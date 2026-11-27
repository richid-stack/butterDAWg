// Where audio files are, and where they came from.
//
// The live project refers to a file by one absolute path (what the loader
// reads). The project file refers to it by an asset record: a location (the
// project's own `assets/` folder, the app's library, or somewhere else on the
// computer), a path that stays valid when the project folder is moved, the
// source and the licence. This file converts between the two and remembers the
// source and licence of each file while the project is open.
//
// No browser or Electron types here, so the unit tests run it in Node.

import type { AssetData, AssetLocation, AssetSource } from "./schema";

/** one slash style, no trailing slash */
export function normalizePath(p: string): string {
    const slashed = p.replace(/\\/g, "/");
    return slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
}

export function baseName(p: string): string {
    const n = normalizePath(p);
    return n.slice(n.lastIndexOf("/") + 1);
}

function inside(path: string, root: string): string | null {
    const r = normalizePath(root);
    return path.startsWith(r + "/") ? path.slice(r.length + 1) : null;
}

export interface Roots {
    /** the folder the app is installed in */
    appRoot: string;
    /** the folder of the project that is open, or null before it has been saved */
    projectDir: string | null;
}

/** Works out the location and the stable path for a file the loader reads from `absolute`. */
export function classify(absolute: string, roots: Roots): { location: AssetLocation; path: string } {
    const abs = normalizePath(absolute);
    if (roots.projectDir) {
        const rel = inside(abs, roots.projectDir);
        if (rel !== null && rel.startsWith("assets/")) return { location: "project", path: rel };
    }
    const rel = inside(abs, roots.appRoot);
    if (rel !== null) return { location: "app", path: rel };
    return { location: "external", path: abs };
}

/** The path the loader reads for an asset record; null if it is in the project folder and there is none yet. */
export function toAbsolute(asset: Pick<AssetData, "location" | "path">, roots: Roots): string | null {
    if (asset.location === "external") return normalizePath(asset.path);
    if (asset.location === "app") return normalizePath(roots.appRoot) + "/" + asset.path;
    return roots.projectDir ? normalizePath(roots.projectDir) + "/" + asset.path : null;
}

// ---- source and licence -----------------------------------------------------------

export interface AssetMeta {
    source: AssetSource;
    licence: string | null;
    credit?: string;
    sha256?: string;
}

/** What is remembered about each file (by absolute path) while a project is open. */
export class AssetBook {
    private meta = new Map<string, AssetMeta>();

    remember(absolute: string, meta: AssetMeta): void {
        this.meta.set(normalizePath(absolute), { ...meta });
    }

    get(absolute: string): AssetMeta | undefined {
        return this.meta.get(normalizePath(absolute));
    }

    /** moves what is known about a file to its new path (it was copied into the project) */
    moved(from: string, to: string, extra: Partial<AssetMeta> = {}): void {
        const old = this.get(from);
        if (old) this.remember(to, { ...old, ...extra });
    }

    clear(): void {
        this.meta.clear();
    }
}

/**
 * The licence record of the app's own library: `files/licences.json`. Each
 * entry names a folder (or a file) under `files/` and what is known about
 * everything below it. The longest matching entry wins. A file with no entry
 * has an unknown licence, and is recorded as such rather than guessed.
 */
export interface LicenceEntry {
    /** path under files/, e.g. "samples" or "packs/808" */
    path: string;
    library?: string;
    licence: string | null;
    credit?: string;
}

export interface LicenceManifest {
    entries: LicenceEntry[];
}

export function parseLicenceManifest(text: string): LicenceManifest {
    const raw = JSON.parse(text);
    if (!raw || !Array.isArray(raw.entries)) throw new Error("licences.json must have a list called entries");
    const entries: LicenceEntry[] = raw.entries.map((e: any, i: number) => {
        if (typeof e?.path !== "string" || e.path === "") throw new Error(`licences.json entries[${i}] needs a path`);
        if (e.licence !== null && typeof e.licence !== "string") throw new Error(`licences.json entries[${i}] needs a licence (text, or null when unknown)`);
        return { path: normalizePath(e.path), library: e.library, licence: e.licence, credit: e.credit };
    });
    return { entries };
}

/** The source and licence for a file in the app's library (`relative` is the path below the app folder, e.g. "files/samples/kick.wav"). */
export function libraryMeta(relative: string, manifest: LicenceManifest | null): AssetMeta {
    const under = relative.startsWith("files/") ? relative.slice("files/".length) : relative;
    let best: LicenceEntry | null = null;
    for (const entry of manifest?.entries ?? []) {
        const hit = under === entry.path || under.startsWith(entry.path + "/");
        if (hit && (!best || entry.path.length > best.path.length)) best = entry;
    }
    const meta: AssetMeta = {
        source: best?.library ? { kind: "library", library: best.library } : { kind: "library" },
        licence: best ? best.licence : null,
    };
    if (best?.credit) meta.credit = best.credit;
    return meta;
}

/** What to record for a file that has no record yet. */
export function defaultMeta(absolute: string, roots: Roots, manifest: LicenceManifest | null): AssetMeta {
    const { location, path } = classify(absolute, roots);
    if (location === "app") return libraryMeta(path, manifest);
    // a file the user brought in: only its name is kept, so a project does not carry their folder names around
    return { source: { kind: "imported", from: baseName(absolute) }, licence: null };
}

/** A file name that is safe inside the project's assets folder. */
export function safeAssetName(name: string): string {
    const cleaned = name.replace(/[\\/:*?"<>|\0]/g, "_").replace(/^\.+/, "_").trim();
    return cleaned === "" ? "file" : cleaned.slice(0, 120);
}
