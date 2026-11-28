// The project file: what is saved, and how an older or damaged file is dealt with.
//
// A project is a folder: `project.json` (this schema) and an `assets/` folder
// that holds the audio files copied into the project ("collect and save").
// This file has no browser or Electron types, so the unit tests run it in Node.
//
// Rules for changing the format:
//   - Adding an optional field needs no new version.
//   - Anything else (renaming, removing, changing what a value means) is a new
//     version: raise CURRENT_VERSION and add a migration that turns the old JSON
//     into the new JSON. Old files must keep opening.
//   - A file with a newer version than this app knows is refused with a message,
//     never opened half-understood.

import { ProjectError } from "./errors";
import { arr, bool, fail, num, obj, str } from "./validate";
import { validateBeat, validatePatternClips } from "../beat/validate";
import type { BeatData, PatternClipData } from "../beat/data";

export const PROJECT_FORMAT = "butterdawg-project";
export const CURRENT_VERSION = 1;

/** number of plugin slots on a mixer channel */
export const PLUGIN_SLOTS = 10;

// ---- the data ---------------------------------------------------------------

export interface ProjectData {
    format: typeof PROJECT_FORMAT;
    /** schema version of this file */
    version: number;
    /** the app version that saved it */
    appVersion: string;
    name: string;
    /** ISO date and time of the save */
    savedAt: string;
    tempo: { points: TempoPointData[] };
    loop: { startBeat: number; endBeat: number } | null;
    /** every audio file the project uses; clips refer to these by id */
    assets: AssetData[];
    tracks: TrackData[];
    mixer: { master: ChannelData; channels: ChannelData[] };
    /** how the windows were left (optional: a project opens without it) */
    view?: { xsnap?: number };
    /** the channel rack and the patterns (optional: a project from before the beat tools has none) */
    beat?: BeatData;
}

export interface TempoPointData {
    beat: number;
    bpm: number;
}

/**
 * Where an asset's file is:
 *   "project"  inside this project's `assets/` folder (path is relative to the project folder)
 *   "app"      in the app's own library (path is relative to the app folder, e.g. "files/samples/kick.wav")
 *   "external" anywhere else on this computer (an absolute path, for example a user library)
 */
export type AssetLocation = "project" | "app" | "external";

/** where a sound came from, so a chop or a generated sample keeps its origin */
export type AssetSource =
    | { kind: "library"; library?: string }
    | { kind: "imported"; from?: string }
    | { kind: "generated"; model?: string; prompt?: string; seed?: number }
    | { kind: "chopped"; parent: string; startSeconds: number; endSeconds: number }
    | { kind: "unknown" };

export interface AssetData {
    id: string;
    location: AssetLocation;
    path: string;
    /** the name to show */
    name: string;
    /** SHA-256 of the file, in hex, recorded when it was copied into the project */
    sha256?: string;
    source: AssetSource;
    /** the licence the sound is under, as a short name ("CC0", "CC-BY 4.0", "own") or null when it is not known */
    licence: string | null;
    /** credit text the licence asks for, if any */
    credit?: string;
}

export interface TrackData {
    title: string;
    /** "#rrggbb" */
    color: string;
    /** false when the track is muted */
    enabled: boolean;
    /** where the track plays into; null for nowhere (silent) */
    route: { to: "master" } | { to: "channel"; index: number } | null;
    clips: ClipData[];
    /** patterns placed on this track (optional) */
    patternClips?: PatternClipData[];
}

export interface ClipData {
    asset: string;
    startBeat: number;
    name: string;
}

export interface ChannelData {
    name: string;
    /** linear gain; 1 is 0 dB */
    volume: number;
    /** 0.5 (left), 1 (centre), 1.5 (right) */
    panning: number;
    active: boolean;
    /** the plugin slots in order; null for an empty slot */
    plugins: Array<PluginData | null>;
}

export interface PluginData {
    /** the plugin folder, relative to the app folder, e.g. "plugins/Gain.bdp" */
    path: string;
    bypassed: boolean;
    /** the value of each parameter, by name */
    params: Record<string, number>;
}

// ---- a new project ----------------------------------------------------------

export function emptyChannel(name: string): ChannelData {
    return { name, volume: 1, panning: 1, active: true, plugins: Array.from({ length: PLUGIN_SLOTS }, (): PluginData | null => null) };
}

export function newProjectData(appVersion: string, name = "Untitled"): ProjectData {
    return {
        format: PROJECT_FORMAT,
        version: CURRENT_VERSION,
        appVersion,
        name,
        savedAt: new Date(0).toISOString(),
        tempo: { points: [{ beat: 0, bpm: 150 }] },
        loop: null,
        assets: [],
        tracks: [],
        mixer: { master: emptyChannel("Master"), channels: [] },
    };
}

// ---- reading a file -----------------------------------------------------------

export { ProjectError };

/** Turns the JSON of version n into the JSON of version n+1. `MIGRATIONS[0]` is 1 to 2. */
export type Migration = (raw: any) => any;
export const MIGRATIONS: Migration[] = [];

/**
 * Upgrades a parsed project file to the current version, one step at a time.
 * `migrations` and `current` can be replaced to test the machinery.
 */
export function migrateProject(raw: unknown, migrations: Migration[] = MIGRATIONS, current = CURRENT_VERSION): any {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new ProjectError("this is not a butterDAWg project (the file does not hold an object)");
    }
    const file = raw as any;
    if (file.format !== PROJECT_FORMAT) {
        throw new ProjectError("this is not a butterDAWg project (it has no project marker)");
    }
    let version = file.version;
    if (!Number.isInteger(version) || version < 1) {
        throw new ProjectError("the project has no valid version number");
    }
    if (version > current) {
        throw new ProjectError(
            `this project was saved by a newer butterDAWg (project format ${version}; this app reads up to ${current}). Update the app to open it.`,
        );
    }
    let result = file;
    while (version < current) {
        const step = migrations[version - 1];
        if (!step) throw new ProjectError(`no way to upgrade a project from format ${version}`);
        result = step(structuredCloneJson(result));
        version++;
        result.version = version;
    }
    return result;
}

function structuredCloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
}

/** Reads the text of a project file: parse, upgrade, check. Throws ProjectError with a message a person can act on. */
export function parseProject(text: string): ProjectData {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        throw new ProjectError("the project file is damaged (it is not valid JSON)");
    }
    const data = migrateProject(raw);
    validateProject(data);
    return data as ProjectData;
}

export function serializeProject(data: ProjectData): string {
    validateProject(data);
    return JSON.stringify(data, null, 2) + "\n";
}

// ---- checking ------------------------------------------------------------------

const MAX_VOLUME = 4; // +12 dB
const MAX_BPM = 999;

/**
 * A relative path must stay inside the folder it is relative to: no "..", no
 * drive letters, no leading slash. (A project file that someone else made must
 * not be able to point at files outside its folder.)
 */
export function isSafeRelativePath(p: string): boolean {
    if (p === "" || p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:/.test(p) || p.includes("\0")) return false;
    return !p.split(/[\\/]/).some((part) => part === ".." || part === "");
}

export function validateProject(data: unknown): asserts data is ProjectData {
    const d = obj(data, "project");
    if (d.format !== PROJECT_FORMAT) fail("format", "not a butterDAWg project");
    num(d.version, "version", 1, CURRENT_VERSION);
    str(d.appVersion, "appVersion");
    str(d.name, "name");
    str(d.savedAt, "savedAt");

    const tempo = obj(d.tempo, "tempo");
    const points = arr(tempo.points, "tempo.points");
    if (points.length === 0) fail("tempo.points", "needs at least one tempo");
    let last = -Infinity;
    points.forEach((p, i) => {
        const pt = obj(p, `tempo.points[${i}]`);
        const beat = num(pt.beat, `tempo.points[${i}].beat`, 0);
        num(pt.bpm, `tempo.points[${i}].bpm`, 1, MAX_BPM);
        if (beat <= last) fail(`tempo.points[${i}].beat`, "tempo points must be in order, one per beat position");
        last = beat;
    });
    if (num((points[0] as any).beat, "tempo.points[0].beat") !== 0) fail("tempo.points[0].beat", "the first tempo must be at beat 0");

    if (d.loop !== null) {
        const loop = obj(d.loop, "loop");
        const s = num(loop.startBeat, "loop.startBeat", 0);
        const e = num(loop.endBeat, "loop.endBeat", 0);
        if (!(e > s)) fail("loop", "must end after it starts");
    }

    const assetIds = new Set<string>();
    arr(d.assets, "assets").forEach((a, i) => {
        const p = `assets[${i}]`;
        const asset = obj(a, p);
        const id = str(asset.id, `${p}.id`);
        if (id === "") fail(`${p}.id`, "must not be empty");
        if (assetIds.has(id)) fail(`${p}.id`, `"${id}" is used by two assets`);
        assetIds.add(id);
        const location = str(asset.location, `${p}.location`);
        if (location !== "project" && location !== "app" && location !== "external") fail(`${p}.location`, `unknown location "${location}"`);
        const path = str(asset.path, `${p}.path`);
        if (location !== "external" && !isSafeRelativePath(path)) fail(`${p}.path`, `"${path}" must be a path inside the ${location === "project" ? "project" : "app"} folder`);
        if (location === "project" && !path.startsWith("assets/")) fail(`${p}.path`, `"${path}" must be in the project's assets folder`);
        str(asset.name, `${p}.name`);
        if (asset.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(str(asset.sha256, `${p}.sha256`))) fail(`${p}.sha256`, "must be 64 hex characters");
        const source = obj(asset.source, `${p}.source`);
        const kind = str(source.kind, `${p}.source.kind`);
        if (!["library", "imported", "generated", "chopped", "unknown"].includes(kind)) fail(`${p}.source.kind`, `unknown source "${kind}"`);
        if (kind === "chopped") {
            str(source.parent, `${p}.source.parent`);
            num(source.startSeconds, `${p}.source.startSeconds`, 0);
            num(source.endSeconds, `${p}.source.endSeconds`, 0);
        }
        if (asset.licence !== null) str(asset.licence, `${p}.licence`);
        if (asset.credit !== undefined) str(asset.credit, `${p}.credit`);
    });
    // a chop must point at an asset that is in the list
    (d.assets as any[]).forEach((a, i) => {
        if (a.source.kind === "chopped" && !assetIds.has(a.source.parent)) fail(`assets[${i}].source.parent`, `"${a.source.parent}" is not an asset of this project`);
    });

    const channels = arr(obj(d.mixer, "mixer").channels, "mixer.channels");
    validateChannel((d.mixer as any).master, "mixer.master");
    channels.forEach((c, i) => validateChannel(c, `mixer.channels[${i}]`));

    // the beat first: the pattern clips on the tracks refer to its patterns
    const beatIds = d.beat !== undefined ? validateBeat(d.beat, { assetIds, channelCount: channels.length }) : { patterns: new Set<string>() };

    arr(d.tracks, "tracks").forEach((t, i) => {
        const p = `tracks[${i}]`;
        const track = obj(t, p);
        str(track.title, `${p}.title`);
        if (!/^#[0-9a-fA-F]{6}$/.test(str(track.color, `${p}.color`))) fail(`${p}.color`, "must look like #rrggbb");
        bool(track.enabled, `${p}.enabled`);
        if (track.route !== null) {
            const route = obj(track.route, `${p}.route`);
            if (route.to === "channel") {
                const index = num(route.index, `${p}.route.index`, 0);
                if (!Number.isInteger(index) || index >= channels.length) fail(`${p}.route.index`, `there is no channel ${index}`);
            } else if (route.to !== "master") {
                fail(`${p}.route.to`, `unknown destination "${String(route.to)}"`);
            }
        }
        arr(track.clips, `${p}.clips`).forEach((c, j) => {
            const cp = `${p}.clips[${j}]`;
            const clip = obj(c, cp);
            const asset = str(clip.asset, `${cp}.asset`);
            if (!assetIds.has(asset)) fail(`${cp}.asset`, `"${asset}" is not an asset of this project`);
            num(clip.startBeat, `${cp}.startBeat`, 0);
            str(clip.name, `${cp}.name`);
        });
        if (track.patternClips !== undefined) validatePatternClips(track.patternClips, `${p}.patternClips`, beatIds.patterns);
    });

    if (d.view !== undefined) {
        const view = obj(d.view, "view");
        if (view.xsnap !== undefined) num(view.xsnap, "view.xsnap", 1, 1000);
    }
}

function validateChannel(c: unknown, path: string): void {
    const channel = obj(c, path);
    str(channel.name, `${path}.name`);
    num(channel.volume, `${path}.volume`, 0, MAX_VOLUME);
    num(channel.panning, `${path}.panning`, 0.5, 1.5);
    bool(channel.active, `${path}.active`);
    const plugins = arr(channel.plugins, `${path}.plugins`);
    if (plugins.length > PLUGIN_SLOTS) fail(`${path}.plugins`, `at most ${PLUGIN_SLOTS} slots`);
    plugins.forEach((p, i) => {
        if (p === null) return;
        const pp = `${path}.plugins[${i}]`;
        const plugin = obj(p, pp);
        const pluginPath = str(plugin.path, `${pp}.path`);
        if (!isSafeRelativePath(pluginPath) || !pluginPath.startsWith("plugins/")) fail(`${pp}.path`, `"${pluginPath}" must be a plugin in the app's plugins folder`);
        bool(plugin.bypassed, `${pp}.bypassed`);
        const params = obj(plugin.params, `${pp}.params`);
        for (const [name, value] of Object.entries(params)) num(value, `${pp}.params.${name}`);
    });
}
