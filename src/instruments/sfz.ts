// A reader for the part of the SFZ sampler format that the free libraries use.
//
// SFZ is a text format: <global>, <master>, <group> and <region> headers, each
// followed by opcodes (`key=c4 sample=piano_c4.wav`). Opcodes set in an outer
// header apply to the regions inside it. This reads regions with their key and
// velocity ranges, loops, envelopes, round robin, choke groups and key
// switches. What it does not understand is reported in `warnings`, never
// silently dropped. No browser types here, so it is tested in Node.

import { parsePitch } from "../beat/data";

export type SfzLoopMode = "no_loop" | "one_shot" | "loop_continuous" | "loop_sustain";

export interface SfzRegion {
    /** the sample's path as the file gives it, with the folder from `default_path` in front */
    sample: string;
    keyLow: number;
    keyHigh: number;
    rootKey: number;
    /** 0..127 as in the file */
    velLow: number;
    velHigh: number;
    loopMode: SfzLoopMode | null;
    /** in sample frames of the file; converting to seconds needs the file's sample rate */
    loopStart: number | null;
    loopEnd: number | null;
    /** cents, with `transpose` folded in */
    tune: number;
    /** decibels */
    volume: number;
    /** -1..1 */
    pan: number;
    /** seconds, and sustain as a level 0..1 */
    attack: number;
    decay: number;
    sustain: number;
    release: number;
    /** cents of pitch change per key; 100 follows the keyboard, 0 plays every key at the sample's own pitch */
    keytrack: number;
    /** 0..1: how much the velocity changes the loudness */
    veltrack: number;
    seqLength: number | null;
    seqPosition: number | null;
    group: number | null;
    offBy: number | null;
    /** the key switch note that has to be the last one pressed for this region to sound */
    swLast: number | null;
}

export interface SfzKeySwitch {
    low: number;
    high: number;
    /** the switch that is active before any is pressed */
    default: number | null;
}

export interface SfzFile {
    regions: SfzRegion[];
    keySwitch: SfzKeySwitch | null;
    warnings: string[];
}

export interface SfzOptions {
    /** reads the text of an `#include` file (a path relative to the SFZ file); null if it cannot be read */
    readInclude?: (path: string) => string | null;
}

type Opcodes = Map<string, string>;

const HEADERS = new Set(["control", "global", "master", "group", "region", "curve", "effect", "midi"]);

/** opcodes that change how a sound plays and that this reader does not do; they are named in a warning */
const UNSUPPORTED = [
    "trigger", "direction", "offset", "end", "cutoff", "resonance", "fil_type", "fil_keytrack", "lfo01_freq", "eg01_time1",
    "sw_previous", "sw_up", "sw_down", "locc", "hicc", "polyphony", "delay", "pitcheg_depth",
    "ampeg_hold", "ampeg_delay", "ampeg_start", "xfin_lokey", "xfout_lokey", "xfin_lovel", "xfout_lovel", "bend_up", "bend_down",
    "pitch_veltrack", "amp_keytrack", "amp_keycenter", "rt_decay", "output", "effect1", "effect2",
];

export function parseSfz(text: string, options: SfzOptions = {}): SfzFile {
    const warnings: string[] = [];
    const source = preprocess(text, options, warnings);
    const blocks = split(source);

    let control: Opcodes = new Map();
    let global: Opcodes = new Map();
    let master: Opcodes = new Map();
    let group: Opcodes = new Map();
    const regions: SfzRegion[] = [];
    const randomised: Array<{ region: SfzRegion; low: number; high: number }> = [];
    const unsupported = new Map<string, number>();
    let defaultPath = "";
    let keySwitch: SfzKeySwitch | null = null;

    for (const block of blocks) {
        switch (block.header) {
            case "control":
                control = block.opcodes;
                defaultPath = (control.get("default_path") ?? "").replace(/\\/g, "/");
                break;
            case "global":
                global = block.opcodes; master = new Map(); group = new Map();
                break;
            case "master":
                master = block.opcodes; group = new Map();
                break;
            case "group":
                group = block.opcodes;
                break;
            case "region": {
                const ops: Opcodes = new Map([...global, ...master, ...group, ...block.opcodes]);
                const region = readRegion(ops, defaultPath, warnings);
                if (!region) break;
                for (const [name, value] of ops) {
                    const base = name.replace(/\d+$/, "");
                    if (!UNSUPPORTED.includes(name) && !UNSUPPORTED.includes(base)) continue;
                    if (value !== "" && Number(value) === 0 && base !== "locc") continue; // zero means "none" for these (offset=0, delay=0)
                    if (base === "trigger" && value === "attack") continue;
                    if (base === "direction" && value === "forward") continue;
                    if (base === "hicc" && value === "127") continue;
                    if (base === "locc" && value === "0") continue;
                    unsupported.set(base, (unsupported.get(base) ?? 0) + 1);
                }
                if (ops.get("trigger") === "release" || ops.get("trigger") === "release_key") {
                    unsupported.set("trigger=release", (unsupported.get("trigger=release") ?? 0) + 1);
                    break; // release samples are not played
                }
                if (ops.get("direction") === "reverse") break;
                const low = numberOf(ops.get("sw_lokey"), true);
                const high = numberOf(ops.get("sw_hikey"), true);
                if (low !== null && high !== null) {
                    const def = numberOf(ops.get("sw_default"), true);
                    keySwitch = { low, high, default: def ?? (keySwitch ? keySwitch.default : null) };
                }
                const lorand = numberOf(ops.get("lorand"));
                const hirand = numberOf(ops.get("hirand"));
                if (lorand !== null && hirand !== null && region.seqLength === null) randomised.push({ region, low: lorand, high: hirand });
                regions.push(region);
                break;
            }
            default:
                break; // <curve>, <effect>, <midi>: not needed for the sound of a region
        }
    }

    // random round robin (lorand/hirand) becomes the same sounds taken in turn, so the result is the same on every render
    const byRange = new Map<string, typeof randomised>();
    for (const r of randomised) {
        const key = [r.region.keyLow, r.region.keyHigh, r.region.velLow, r.region.velHigh].join(":");
        byRange.set(key, [...(byRange.get(key) ?? []), r]);
    }
    for (const list of byRange.values()) {
        list.sort((a, b) => a.low - b.low);
        list.forEach((r, i) => {
            r.region.seqLength = list.length;
            r.region.seqPosition = i + 1;
        });
    }
    if (randomised.length > 0) warnings.push("lorand/hirand: random round robin is played as a fixed round robin (the same notes always choose the same sample)");

    if (unsupported.size > 0) {
        const parts = [...unsupported].map(([name, n]) => `${name} (${n} region${n === 1 ? "" : "s"})`);
        warnings.push("not supported, ignored: " + parts.join(", "));
    }
    return { regions, keySwitch, warnings };
}

// ---- reading the text ---------------------------------------------------------------

function preprocess(text: string, options: SfzOptions, warnings: string[]): string {
    let out = text.replace(/\r\n?/g, "\n").replace(/\/\*[\s\S]*?\*\//g, " ");
    // includes first (their text can hold defines and comments too)
    out = out.replace(/^[ \t]*#include[ \t]+"([^"]+)"[ \t]*$/gm, (_all, file: string) => {
        const included = options.readInclude ? options.readInclude(file) : null;
        if (included === null) {
            warnings.push(`#include "${file}" could not be read`);
            return "";
        }
        return included.replace(/\r\n?/g, "\n").replace(/\/\*[\s\S]*?\*\//g, " ");
    });
    out = out.replace(/\/\/[^\n]*/g, "");
    const defines = new Map<string, string>();
    out = out.replace(/^[ \t]*#define[ \t]+(\$[A-Za-z0-9_]+)[ \t]+([^\n]*)$/gm, (_all, name: string, value: string) => {
        defines.set(name, value.trim());
        return "";
    });
    // longer names first, so $KEY2 is not read as $KEY followed by 2
    for (const name of [...defines.keys()].sort((a, b) => b.length - a.length)) out = out.split(name).join(defines.get(name) as string);
    return out;
}

interface Block {
    header: string;
    opcodes: Opcodes;
}

function split(text: string): Block[] {
    const blocks: Block[] = [];
    // a header, or the name of an opcode up to its "="
    const token = /<([a-zA-Z]+)>|([A-Za-z_][A-Za-z0-9_]*)=/g;
    const hits: Array<{ index: number; end: number; header?: string; name?: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = token.exec(text))) hits.push({ index: m.index, end: m.index + m[0].length, header: m[1]?.toLowerCase(), name: m[2] });
    let current: Block | null = null;
    hits.forEach((hit, i) => {
        if (hit.header !== undefined) {
            current = { header: HEADERS.has(hit.header) ? hit.header : "other", opcodes: new Map() };
            blocks.push(current);
        } else if (current && hit.name) {
            const next = hits[i + 1];
            const value = text.slice(hit.end, next ? next.index : text.length).trim();
            current.opcodes.set(hit.name, value);
        }
    });
    return blocks;
}

function numberOf(value: string | undefined, note = false): number | null {
    if (value === undefined || value === "") return null;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    if (note) return parsePitch(value);
    return null;
}

function readRegion(ops: Opcodes, defaultPath: string, warnings: string[]): SfzRegion | null {
    const sample = ops.get("sample");
    if (!sample || sample.startsWith("*")) {
        if (sample) warnings.push(`generator "${sample}" is not supported, the region was skipped`);
        return null;
    }
    // end=-1 turns a region off
    if (numberOf(ops.get("end")) === -1) return null;

    const key = numberOf(ops.get("key"), true);
    const keyLow = key ?? numberOf(ops.get("lokey"), true) ?? 0;
    const keyHigh = key ?? numberOf(ops.get("hikey"), true) ?? 127;
    const rootKey = numberOf(ops.get("pitch_keycenter"), true) ?? key ?? 60;
    const sustainPercent = numberOf(ops.get("ampeg_sustain"));
    const mode = ops.get("loop_mode") ?? ops.get("loopmode");
    const loopMode: SfzLoopMode | null = mode === "no_loop" || mode === "one_shot" || mode === "loop_continuous" || mode === "loop_sustain" ? mode : null;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

    return {
        sample: (defaultPath + sample).replace(/\\/g, "/"),
        keyLow,
        keyHigh,
        rootKey,
        velLow: numberOf(ops.get("lovel")) ?? 0,
        velHigh: numberOf(ops.get("hivel")) ?? 127,
        loopMode,
        loopStart: numberOf(ops.get("loop_start") ?? ops.get("loopstart")),
        loopEnd: numberOf(ops.get("loop_end") ?? ops.get("loopend")),
        tune: (numberOf(ops.get("tune")) ?? numberOf(ops.get("pitch")) ?? 0) + (numberOf(ops.get("transpose")) ?? 0) * 100,
        volume: numberOf(ops.get("volume")) ?? 0,
        pan: clamp((numberOf(ops.get("pan")) ?? 0) / 100, -1, 1),
        attack: Math.max(0, numberOf(ops.get("ampeg_attack")) ?? 0),
        decay: Math.max(0, numberOf(ops.get("ampeg_decay")) ?? 0),
        sustain: sustainPercent === null ? 1 : clamp(sustainPercent / 100, 0, 1),
        release: Math.max(0, numberOf(ops.get("ampeg_release")) ?? 0.001),
        keytrack: numberOf(ops.get("pitch_keytrack")) ?? 100,
        veltrack: clamp((numberOf(ops.get("amp_veltrack")) ?? 100) / 100, 0, 1),
        seqLength: numberOf(ops.get("seq_length")),
        seqPosition: numberOf(ops.get("seq_position")),
        group: numberOf(ops.get("group")),
        offBy: numberOf(ops.get("off_by")),
        swLast: numberOf(ops.get("sw_last"), true),
    };
}
