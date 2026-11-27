// Project files, as the main process handles them. No Electron in this file, so
// it can be tested with plain Node (test/project-store.test.ts).
//
// A project is a folder:
//
//   My Beat/
//     project.json     the project (see src/project/schema.ts)
//     project.json.bak the version before the last save
//     assets/          audio files the project owns
//
// The page may only read and write inside folders the user chose in a dialog
// (or that were opened from the recent list or the recovery file, which this
// process wrote itself). Nothing here trusts a path that comes from the page.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_TEXT = 64 * 1024 * 1024; // a project file or recovery file larger than this is not a project
const MAX_RECENT = 10;

function safeName(name) {
    const cleaned = String(name).replace(/[\\/:*?"<>|\0]/g, "_").replace(/^\.+/, "_").trim();
    return cleaned === "" ? "file" : cleaned.slice(0, 120);
}

function sha256File(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        fs.createReadStream(file)
            .on("data", (chunk) => hash.update(chunk))
            .on("error", reject)
            .on("end", () => resolve(hash.digest("hex")));
    });
}

async function exists(file) {
    try { await fs.promises.access(file); return true; } catch { return false; }
}

// writes to a temporary file and renames it, so a crash never leaves half a file
async function writeFileAtomic(file, text) {
    const tmp = file + ".tmp-" + process.pid;
    await fs.promises.writeFile(tmp, text, "utf8");
    await fs.promises.rename(tmp, file);
}

function createProjectStore({ userData }) {
    const granted = new Set();
    const recentFile = path.join(userData, "recent.json");
    const recoveryDir = path.join(userData, "recovery");
    const recoveryFile = path.join(recoveryDir, "recovery.json");

    const norm = (dir) => path.resolve(String(dir));

    function requireString(value, what) {
        if (typeof value !== "string" || value === "") throw new Error(what + " must be a path");
        return value;
    }

    function requireGranted(dir) {
        const d = norm(requireString(dir, "the project folder"));
        if (!granted.has(d)) throw new Error("that folder was not chosen in this session: " + d);
        return d;
    }

    // ---- recent projects

    async function recent() {
        try {
            const list = JSON.parse(await fs.promises.readFile(recentFile, "utf8"));
            return Array.isArray(list)
                ? list.filter((r) => r && typeof r.dir === "string" && typeof r.name === "string").slice(0, MAX_RECENT)
                : [];
        } catch {
            return [];
        }
    }

    async function remember(dir, name) {
        const list = (await recent()).filter((r) => norm(r.dir) !== dir);
        list.unshift({ dir, name: String(name || path.basename(dir)), openedAt: new Date().toISOString() });
        await fs.promises.mkdir(userData, { recursive: true });
        await writeFileAtomic(recentFile, JSON.stringify(list.slice(0, MAX_RECENT), null, 2));
    }

    async function forgetRecent(dir) {
        const d = norm(requireString(dir, "the project folder"));
        const list = (await recent()).filter((r) => norm(r.dir) !== d);
        await fs.promises.mkdir(userData, { recursive: true });
        await writeFileAtomic(recentFile, JSON.stringify(list, null, 2));
    }

    // ---- opening and saving

    /** Opens a folder the user chose: reads project.json and grants the folder. */
    async function openFolder(dir) {
        const d = norm(requireString(dir, "the project folder"));
        const file = path.join(d, "project.json");
        let stat;
        try {
            stat = await fs.promises.stat(file);
        } catch {
            throw new Error("There is no project.json in " + d + ", so it is not a butterDAWg project folder.");
        }
        if (stat.size > MAX_TEXT) throw new Error("project.json is too large to be a project");
        const text = await fs.promises.readFile(file, "utf8");
        granted.add(d);
        let name = path.basename(d);
        try { name = JSON.parse(text).name || name; } catch { /* the page reports a damaged file */ }
        await remember(d, name);
        return { dir: d, text };
    }

    /** Opens a project from the recent list. */
    async function openRecent(dir) {
        const d = norm(requireString(dir, "the project folder"));
        if (!(await recent()).some((r) => norm(r.dir) === d)) throw new Error("that project is not in the recent list");
        return openFolder(d);
    }

    /** The user chose where to save: the folder may be written to from now on. */
    function grantSave(dir) {
        granted.add(norm(requireString(dir, "the project folder")));
    }

    async function writeProject(dir, text) {
        const d = requireGranted(dir);
        if (typeof text !== "string" || text.length > MAX_TEXT) throw new Error("not a project file");
        await fs.promises.mkdir(path.join(d, "assets"), { recursive: true });
        const file = path.join(d, "project.json");
        // keep the version before this one
        if (await exists(file)) await fs.promises.copyFile(file, file + ".bak");
        await writeFileAtomic(file, text);
        let name = path.basename(d);
        try { name = JSON.parse(text).name || name; } catch { /* keep the folder name */ }
        await remember(d, name);
    }

    /**
     * Copies files into dir/assets. `resolveSource(from)` returns the real path of
     * a file the page may read, or throws. A file with the same content and name
     * that is already there is reused; a different file with the same name gets
     * "name-2.ext" and so on.
     */
    async function copyAssets(dir, items, resolveSource) {
        const d = requireGranted(dir);
        if (!Array.isArray(items)) throw new Error("items must be a list");
        const assets = path.join(d, "assets");
        await fs.promises.mkdir(assets, { recursive: true });
        const out = [];
        for (const item of items) {
            const from = requireString(item && item.from, "from");
            const source = await resolveSource(from);
            const hash = await sha256File(source);
            const wanted = safeName(item.name || path.basename(source));
            const ext = path.extname(wanted);
            const stem = wanted.slice(0, wanted.length - ext.length);
            let candidate = wanted;
            for (let n = 2; ; n++) {
                const target = path.join(assets, candidate);
                if (!(await exists(target))) {
                    const tmp = target + ".tmp-" + process.pid;
                    await fs.promises.copyFile(source, tmp);
                    await fs.promises.rename(tmp, target);
                    break;
                }
                if ((await sha256File(target)) === hash) break; // the same file is already there
                candidate = stem + "-" + n + ext;
            }
            out.push({ from, path: "assets/" + candidate, sha256: hash });
        }
        return out;
    }

    /** the folders under which the page may read files, besides the app's own: each granted project's assets */
    function extraReadableRoots() {
        return [...granted].map((d) => path.join(d, "assets"));
    }

    // ---- recovery

    async function readRecovery() {
        let raw;
        try {
            raw = JSON.parse(await fs.promises.readFile(recoveryFile, "utf8"));
        } catch {
            return null;
        }
        if (!raw || typeof raw.text !== "string") return null;
        // the file was written by this app, for a folder that was open in it: that folder is open again
        if (typeof raw.dir === "string" && (await exists(raw.dir))) granted.add(norm(raw.dir));
        else raw.dir = null;
        return { savedAt: String(raw.savedAt || ""), name: String(raw.name || "Untitled"), dir: raw.dir, text: raw.text };
    }

    async function writeRecovery(recovery) {
        if (!recovery || typeof recovery.text !== "string" || recovery.text.length > MAX_TEXT) throw new Error("not a recovery file");
        await fs.promises.mkdir(recoveryDir, { recursive: true });
        await writeFileAtomic(recoveryFile, JSON.stringify({
            savedAt: String(recovery.savedAt),
            name: String(recovery.name),
            dir: typeof recovery.dir === "string" ? recovery.dir : null,
            text: recovery.text,
        }));
    }

    async function clearRecovery() {
        await fs.promises.rm(recoveryFile, { force: true });
    }

    function clearRecoverySync() {
        try { fs.rmSync(recoveryFile, { force: true }); } catch { /* nothing to clear */ }
    }

    return {
        recent, forgetRecent, openFolder, openRecent, grantSave, writeProject, copyAssets,
        extraReadableRoots, readRecovery, writeRecovery, clearRecovery, clearRecoverySync,
    };
}

module.exports = { createProjectStore, safeName };
