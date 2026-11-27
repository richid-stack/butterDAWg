import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// the main process's project code is plain Node and has no Electron in it
const require = createRequire(import.meta.url);
const { createProjectStore, safeName } = require("../projects-main.js");

function sandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-store-"));
    const userData = path.join(root, "userData");
    const store = createProjectStore({ userData });
    const dir = (name: string) => {
        const d = path.join(root, name);
        fs.mkdirSync(d, { recursive: true });
        return d;
    };
    const file = (rel: string, content: string | Buffer) => {
        const f = path.join(root, rel);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, content);
        return f;
    };
    return { root, userData, store, dir, file, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const sha = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
const allow = async (from: string) => from; // a resolver that allows everything: the tests of what it refuses are below

test("store: names are made safe", () => {
    assert.equal(safeName("../x"), "__x");
    assert.equal(safeName("a/b\\c:d"), "a_b_c_d");
    assert.equal(safeName(""), "file");
    assert.equal(safeName("...."), "_");
});

test("store: nothing may be written before the user chose the folder", async () => {
    const s = sandbox();
    try {
        const d = s.dir("beat");
        await assert.rejects(s.store.writeProject(d, "{}"), /not chosen/);
        await assert.rejects(s.store.copyAssets(d, [], allow), /not chosen/);
        assert.ok(!fs.existsSync(path.join(d, "project.json")));
        s.store.grantSave(d);
        await s.store.writeProject(d, "{}");
        assert.equal(fs.readFileSync(path.join(d, "project.json"), "utf8"), "{}");
        assert.ok(fs.existsSync(path.join(d, "assets")));
    } finally { s.done(); }
});

test("store: paths that are not paths are refused", async () => {
    const s = sandbox();
    try {
        for (const bad of [undefined, null, "", 5, {}]) {
            await assert.rejects(s.store.writeProject(bad as any, "{}"));
            await assert.rejects(s.store.openFolder(bad as any));
        }
        const d = s.dir("beat");
        s.store.grantSave(d);
        await assert.rejects(s.store.writeProject(d, 5 as any), /not a project file/);
    } finally { s.done(); }
});

test("store: a granted folder is not a way into its parent or its neighbours", async () => {
    const s = sandbox();
    try {
        const a = s.dir("a");
        const b = s.dir("b");
        s.store.grantSave(a);
        await assert.rejects(s.store.writeProject(b, "{}"), /not chosen/);
        await assert.rejects(s.store.writeProject(path.join(a, "..", "b"), "{}"), /not chosen/);
        await assert.rejects(s.store.writeProject(path.join(a, "assets"), "{}"), /not chosen/);
    } finally { s.done(); }
});

test("store: saving again keeps the version before as project.json.bak", async () => {
    const s = sandbox();
    try {
        const d = s.dir("beat");
        s.store.grantSave(d);
        await s.store.writeProject(d, '{"name":"first"}');
        assert.ok(!fs.existsSync(path.join(d, "project.json.bak")), "the first save has nothing to keep");
        await s.store.writeProject(d, '{"name":"second"}');
        assert.equal(fs.readFileSync(path.join(d, "project.json.bak"), "utf8"), '{"name":"first"}');
        assert.equal(fs.readFileSync(path.join(d, "project.json"), "utf8"), '{"name":"second"}');
        // no temporary files are left behind
        assert.deepEqual(fs.readdirSync(d).sort(), ["assets", "project.json", "project.json.bak"]);
    } finally { s.done(); }
});

test("store: openFolder reads the project, grants the folder and lists it as recent", async () => {
    const s = sandbox();
    try {
        const d = s.dir("beat");
        fs.writeFileSync(path.join(d, "project.json"), JSON.stringify({ name: "Night Drive" }));
        const opened = await s.store.openFolder(d);
        assert.equal(opened.dir, path.resolve(d));
        assert.equal(JSON.parse(opened.text).name, "Night Drive");
        assert.deepEqual((await s.store.recent()).map((r: any) => r.name), ["Night Drive"]);
        await s.store.writeProject(d, '{"name":"Renamed"}'); // opening granted it
        assert.deepEqual((await s.store.recent()).map((r: any) => r.name), ["Renamed"]);
        assert.deepEqual(s.store.extraReadableRoots(), [path.join(path.resolve(d), "assets")]);
    } finally { s.done(); }
});

test("store: a folder without project.json is not opened and not granted", async () => {
    const s = sandbox();
    try {
        const d = s.dir("empty");
        await assert.rejects(s.store.openFolder(d), /no project\.json/);
        await assert.rejects(s.store.writeProject(d, "{}"), /not chosen/);
        assert.deepEqual(await s.store.recent(), []);
        assert.deepEqual(s.store.extraReadableRoots(), []);
    } finally { s.done(); }
});

test("store: a damaged project file is still returned as text (the page says what is wrong)", async () => {
    const s = sandbox();
    try {
        const d = s.dir("broken");
        fs.writeFileSync(path.join(d, "project.json"), "{ not json");
        const opened = await s.store.openFolder(d);
        assert.equal(opened.text, "{ not json");
        assert.equal((await s.store.recent())[0].name, "broken");
    } finally { s.done(); }
});

test("store: the recent list has the newest first, no repeats, and at most ten", async () => {
    const s = sandbox();
    try {
        const dirs: string[] = [];
        for (let i = 0; i < 12; i++) {
            const d = s.dir("p" + i);
            fs.writeFileSync(path.join(d, "project.json"), JSON.stringify({ name: "P" + i }));
            await s.store.openFolder(d);
            dirs.push(d);
        }
        let list = await s.store.recent();
        assert.equal(list.length, 10);
        assert.equal(list[0].name, "P11");
        await s.store.openFolder(dirs[5]);
        list = await s.store.recent();
        assert.equal(list[0].name, "P5");
        assert.equal(list.filter((r: any) => r.name === "P5").length, 1);
        await s.store.forgetRecent(dirs[5]);
        assert.ok(!(await s.store.recent()).some((r: any) => r.name === "P5"));
    } finally { s.done(); }
});

test("store: a damaged recent list is an empty list", async () => {
    const s = sandbox();
    try {
        fs.mkdirSync(s.userData, { recursive: true });
        fs.writeFileSync(path.join(s.userData, "recent.json"), "{{{");
        assert.deepEqual(await s.store.recent(), []);
        fs.writeFileSync(path.join(s.userData, "recent.json"), JSON.stringify([{ dir: 5 }, { dir: "/x", name: "ok" }, null]));
        assert.deepEqual((await s.store.recent()).map((r: any) => r.name), ["ok"]);
    } finally { s.done(); }
});

test("store: openRecent only opens what is in the list", async () => {
    const s = sandbox();
    try {
        const d = s.dir("beat");
        fs.writeFileSync(path.join(d, "project.json"), "{}");
        await assert.rejects(s.store.openRecent(d), /not in the recent list/);
        await s.store.openFolder(d);
        const again = createProjectStore({ userData: s.userData }); // a new session: nothing is granted yet
        await assert.rejects(again.writeProject(d, "{}"), /not chosen/);
        const opened = await again.openRecent(d);
        assert.equal(opened.text, "{}");
        await again.writeProject(d, "{}");
    } finally { s.done(); }
});

test("store: copyAssets copies into assets/ and reports the hash", async () => {
    const s = sandbox();
    try {
        const d = s.dir("beat");
        s.store.grantSave(d);
        const src = s.file("lib/kick.wav", "KICK");
        const [out] = await s.store.copyAssets(d, [{ from: src }], allow);
        assert.deepEqual(out, { from: src, path: "assets/kick.wav", sha256: sha("KICK") });
        assert.equal(fs.readFileSync(path.join(d, "assets", "kick.wav"), "utf8"), "KICK");
    } finally { s.done(); }
});

test("store: copyAssets reuses an identical file and renames a different one with the same name", async () => {
    const s = sandbox();
    try {
        const d = s.dir("beat");
        s.store.grantSave(d);
        const a = s.file("one/kick.wav", "SAME");
        const b = s.file("two/kick.wav", "SAME");
        const c = s.file("three/kick.wav", "OTHER");
        const e = s.file("four/kick.wav", "THIRD");
        const out = await s.store.copyAssets(d, [{ from: a }, { from: b }, { from: c }, { from: e }, { from: c }], allow);
        assert.deepEqual(out.map((o: any) => o.path), [
            "assets/kick.wav", "assets/kick.wav", "assets/kick-2.wav", "assets/kick-3.wav", "assets/kick-2.wav",
        ]);
        assert.deepEqual(fs.readdirSync(path.join(d, "assets")).sort(), ["kick-2.wav", "kick-3.wav", "kick.wav"]);
    } finally { s.done(); }
});

test("store: copyAssets does not trust the name it is given", async () => {
    const s = sandbox();
    try {
        const d = s.dir("beat");
        s.store.grantSave(d);
        const src = s.file("lib/a.wav", "A");
        const [out] = await s.store.copyAssets(d, [{ from: src, name: "../../escape.wav" }], allow);
        const segments = out.path.split("/");
        assert.equal(segments.length, 2, out.path); // assets/<one file name>
        assert.equal(segments[0], "assets");
        assert.ok(segments[1] !== ".." && segments[1] !== ".", out.path);
        assert.ok(!fs.existsSync(path.join(s.root, "escape.wav")));
        assert.deepEqual(fs.readdirSync(d).sort(), ["assets"]);
    } finally { s.done(); }
});

test("store: copyAssets only copies what the resolver allows", async () => {
    const s = sandbox();
    try {
        const d = s.dir("beat");
        s.store.grantSave(d);
        const secret = s.file("home/secret.txt", "private");
        const refuse = async () => { throw new Error("not readable"); };
        await assert.rejects(s.store.copyAssets(d, [{ from: secret }], refuse), /not readable/);
        assert.deepEqual(fs.readdirSync(path.join(d, "assets")), []);
        await assert.rejects(s.store.copyAssets(d, "nope" as any, allow), /list/);
        await assert.rejects(s.store.copyAssets(d, [{}], allow), /from/);
    } finally { s.done(); }
});

test("store: recovery is written, read back, and cleared", async () => {
    const s = sandbox();
    try {
        assert.equal(await s.store.readRecovery(), null);
        const d = s.dir("beat");
        await s.store.writeRecovery({ savedAt: "2026-11-27T00:00:00Z", name: "Night Drive", dir: d, text: '{"a":1}' });
        const r = await s.store.readRecovery();
        assert.equal(r.name, "Night Drive");
        assert.equal(r.text, '{"a":1}');
        assert.equal(r.dir, d);
        // the recovered work belongs to a folder that was open: it may be saved to again
        await s.store.writeProject(d, "{}");
        await s.store.clearRecovery();
        assert.equal(await s.store.readRecovery(), null);
        await s.store.clearRecovery(); // clearing nothing is fine
    } finally { s.done(); }
});

test("store: recovery of a project that was never saved has no folder, and a vanished folder is dropped", async () => {
    const s = sandbox();
    try {
        await s.store.writeRecovery({ savedAt: "t", name: "Untitled", dir: null, text: "{}" });
        assert.equal((await s.store.readRecovery()).dir, null);
        await s.store.writeRecovery({ savedAt: "t", name: "Gone", dir: path.join(s.root, "does-not-exist"), text: "{}" });
        const r = await s.store.readRecovery();
        assert.equal(r.dir, null);
        await assert.rejects(s.store.writeProject(path.join(s.root, "does-not-exist"), "{}"), /not chosen/);
    } finally { s.done(); }
});

test("store: a recovery file that was damaged or edited is not used", async () => {
    const s = sandbox();
    try {
        const file = path.join(s.userData, "recovery", "recovery.json");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "garbage");
        assert.equal(await s.store.readRecovery(), null);
        fs.writeFileSync(file, JSON.stringify({ name: "x", text: 5 }));
        assert.equal(await s.store.readRecovery(), null);
        await assert.rejects(s.store.writeRecovery({ text: 5 } as any), /not a recovery file/);
        await assert.rejects(s.store.writeRecovery(null as any), /not a recovery file/);
    } finally { s.done(); }
});

test("store: clearRecoverySync is safe to call on the way out", async () => {
    const s = sandbox();
    try {
        s.store.clearRecoverySync();
        await s.store.writeRecovery({ savedAt: "t", name: "n", dir: null, text: "{}" });
        s.store.clearRecoverySync();
        assert.equal(await s.store.readRecovery(), null);
    } finally { s.done(); }
});

test("store: copyAssets with unique: true never reuses an identical file", async () => {
    const s = sandbox();
    try {
        const d = s.dir("beat");
        s.store.grantSave(d);
        const a = s.file("one/kick.wav", "SAME");
        const b = s.file("two/kick.wav", "SAME");
        const [first] = await s.store.copyAssets(d, [{ from: a }], allow);
        const [second] = await s.store.copyAssets(d, [{ from: b, unique: true }], allow);
        assert.equal(first.path, "assets/kick.wav");
        assert.equal(second.path, "assets/kick-2.wav");
        assert.equal(second.sha256, first.sha256); // the same bytes, kept as two files on purpose
        assert.deepEqual(fs.readdirSync(path.join(d, "assets")).sort(), ["kick-2.wav", "kick.wav"]);
        // without it, the identical file is reused
        const [third] = await s.store.copyAssets(d, [{ from: b }], allow);
        assert.equal(third.path, "assets/kick.wav");
    } finally { s.done(); }
});
