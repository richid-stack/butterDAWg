// Checks the beat part of a project file (the rack, the patterns, the pattern clips). A file is read as untrusted
// text: every number is checked for type and range, and every reference (an asset, a channel, an instrument, a
// pattern) has to point at something that is in the file.

import { arr, bool, fail, num, obj, str } from "../project/validate";
import { MAX_PITCH, MAX_RATCHET } from "./data";

export const MAX_INSTRUMENTS = 128;
export const MAX_ZONES = 512;
export const MAX_PATTERNS = 999;
export const MAX_NOTES = 100_000;
export const MAX_PATTERN_BEATS = 4096;
const MAX_GAIN = 4; // +12 dB
const MAX_SECONDS = 60;
const MAX_CHOKE_GROUP = 64;

function int(v: unknown, path: string, min: number, max: number): number {
    const n = num(v, path, min, max);
    if (!Number.isInteger(n)) fail(path, `must be a whole number, not ${n}`);
    return n;
}

function colour(v: unknown, path: string): void {
    if (!/^#[0-9a-fA-F]{6}$/.test(str(v, path))) fail(path, "must look like #rrggbb");
}

export interface BeatContext {
    /** the ids of the project's assets */
    assetIds: ReadonlySet<string>;
    /** how many mixer channels there are */
    channelCount: number;
}

/** what the beat refers to, for the checks that come after (the pattern clips on the tracks) */
export interface BeatIds {
    patterns: ReadonlySet<string>;
}

export function validateBeat(data: unknown, context: BeatContext): BeatIds {
    const beat = obj(data, "beat");
    const instrumentIds = new Set<string>();
    const rack = obj(beat.rack, "beat.rack");
    const instruments = arr(rack.instruments, "beat.rack.instruments");
    if (instruments.length > MAX_INSTRUMENTS) fail("beat.rack.instruments", `at most ${MAX_INSTRUMENTS} instruments`);
    instruments.forEach((raw, i) => validateInstrument(raw, `beat.rack.instruments[${i}]`, context, instrumentIds));

    const patternIds = new Set<string>();
    const patterns = arr(beat.patterns, "beat.patterns");
    if (patterns.length > MAX_PATTERNS) fail("beat.patterns", `at most ${MAX_PATTERNS} patterns`);
    patterns.forEach((raw, i) => validatePattern(raw, `beat.patterns[${i}]`, instrumentIds, patternIds));

    if (beat.activePattern !== null) {
        const id = str(beat.activePattern, "beat.activePattern");
        if (!patternIds.has(id)) fail("beat.activePattern", `"${id}" is not a pattern of this project`);
    }
    const scope = str(beat.scope, "beat.scope");
    if (scope !== "pattern" && scope !== "song") fail("beat.scope", `unknown scope "${scope}"`);
    return { patterns: patternIds };
}

function validateInstrument(raw: unknown, path: string, context: BeatContext, ids: Set<string>): void {
    const instrument = obj(raw, path);
    const id = str(instrument.id, `${path}.id`);
    if (id === "") fail(`${path}.id`, "must not be empty");
    if (ids.has(id)) fail(`${path}.id`, `"${id}" is used by two instruments`);
    ids.add(id);
    str(instrument.name, `${path}.name`);
    colour(instrument.color, `${path}.color`);
    if (instrument.channel !== null) int(instrument.channel, `${path}.channel`, 0, Math.max(0, context.channelCount - 1));
    if (instrument.channel !== null && context.channelCount === 0) fail(`${path}.channel`, "there are no mixer channels");
    num(instrument.volume, `${path}.volume`, 0, MAX_GAIN);
    num(instrument.pan, `${path}.pan`, -1, 1);
    bool(instrument.muted, `${path}.muted`);

    const sampler = obj(instrument.sampler, `${path}.sampler`);
    const mode = str(sampler.mode, `${path}.sampler.mode`);
    if (mode !== "oneshot" && mode !== "gate") fail(`${path}.sampler.mode`, `unknown mode "${mode}"`);
    num(sampler.attack, `${path}.sampler.attack`, 0, MAX_SECONDS);
    num(sampler.decay, `${path}.sampler.decay`, 0, MAX_SECONDS);
    num(sampler.sustain, `${path}.sampler.sustain`, 0, 1);
    num(sampler.release, `${path}.sampler.release`, 0, MAX_SECONDS);
    int(sampler.chokeGroup, `${path}.sampler.chokeGroup`, 0, MAX_CHOKE_GROUP);
    if (sampler.keySwitch !== undefined) {
        const ks = obj(sampler.keySwitch, `${path}.sampler.keySwitch`);
        const low = int(ks.low, `${path}.sampler.keySwitch.low`, 0, MAX_PITCH);
        const high = int(ks.high, `${path}.sampler.keySwitch.high`, 0, MAX_PITCH);
        if (low > high) fail(`${path}.sampler.keySwitch`, "the first key must not be above the last");
        if (ks.default !== null) int(ks.default, `${path}.sampler.keySwitch.default`, 0, MAX_PITCH);
    }
    const zones = arr(sampler.zones, `${path}.sampler.zones`);
    if (zones.length > MAX_ZONES) fail(`${path}.sampler.zones`, `at most ${MAX_ZONES} zones`);
    zones.forEach((z, i) => validateZone(z, `${path}.sampler.zones[${i}]`, context.assetIds));
}

function validateZone(raw: unknown, path: string, assetIds: ReadonlySet<string>): void {
    const zone = obj(raw, path);
    const asset = str(zone.asset, `${path}.asset`);
    if (!assetIds.has(asset)) fail(`${path}.asset`, `"${asset}" is not an asset of this project`);
    const keyLow = int(zone.keyLow, `${path}.keyLow`, 0, MAX_PITCH);
    const keyHigh = int(zone.keyHigh, `${path}.keyHigh`, 0, MAX_PITCH);
    if (keyLow > keyHigh) fail(`${path}.keyLow`, "the lowest key must not be above the highest");
    int(zone.rootKey, `${path}.rootKey`, 0, MAX_PITCH);
    const velLow = int(zone.velLow, `${path}.velLow`, 1, 127);
    const velHigh = int(zone.velHigh, `${path}.velHigh`, 1, 127);
    if (velLow > velHigh) fail(`${path}.velLow`, "the lowest velocity must not be above the highest");
    if (zone.loop !== null) {
        const loop = obj(zone.loop, `${path}.loop`);
        const start = num(loop.start, `${path}.loop.start`, 0);
        const end = num(loop.end, `${path}.loop.end`, 0);
        if (!(end > start)) fail(`${path}.loop`, "must end after it starts");
    }
    num(zone.tune, `${path}.tune`, -4800, 4800);
    num(zone.volume, `${path}.volume`, 0, MAX_GAIN);
    num(zone.pan, `${path}.pan`, -1, 1);
    if (zone.keytrack !== undefined) num(zone.keytrack, `${path}.keytrack`, -1200, 1200);
    if (zone.veltrack !== undefined) num(zone.veltrack, `${path}.veltrack`, 0, 1);
    if (zone.seqLength !== undefined) {
        const length = int(zone.seqLength, `${path}.seqLength`, 1, 64);
        const position = zone.seqPosition === undefined ? 1 : int(zone.seqPosition, `${path}.seqPosition`, 1, 64);
        if (position > length) fail(`${path}.seqPosition`, "must not be more than the round robin length");
    } else if (zone.seqPosition !== undefined) {
        fail(`${path}.seqPosition`, "needs a round robin length");
    }
    if (zone.swLast !== undefined) int(zone.swLast, `${path}.swLast`, 0, MAX_PITCH);
    if (zone.env !== undefined) {
        const env = obj(zone.env, `${path}.env`);
        num(env.attack, `${path}.env.attack`, 0, MAX_SECONDS);
        num(env.decay, `${path}.env.decay`, 0, MAX_SECONDS);
        num(env.sustain, `${path}.env.sustain`, 0, 1);
        num(env.release, `${path}.env.release`, 0, MAX_SECONDS);
    }
}

function validatePattern(raw: unknown, path: string, instrumentIds: ReadonlySet<string>, ids: Set<string>): void {
    const pattern = obj(raw, path);
    const id = str(pattern.id, `${path}.id`);
    if (id === "") fail(`${path}.id`, "must not be empty");
    if (ids.has(id)) fail(`${path}.id`, `"${id}" is used by two patterns`);
    ids.add(id);
    str(pattern.name, `${path}.name`);
    colour(pattern.color, `${path}.color`);
    num(pattern.length, `${path}.length`, 0.25, MAX_PATTERN_BEATS);
    if (pattern.swing !== undefined) num(pattern.swing, `${path}.swing`, 0.5, 0.75);
    const notes = arr(pattern.notes, `${path}.notes`);
    if (notes.length > MAX_NOTES) fail(`${path}.notes`, `at most ${MAX_NOTES} notes in a pattern`);
    notes.forEach((n, i) => {
        const np = `${path}.notes[${i}]`;
        const note = obj(n, np);
        const instrument = str(note.instrument, `${np}.instrument`);
        if (!instrumentIds.has(instrument)) fail(`${np}.instrument`, `"${instrument}" is not an instrument of this project`);
        num(note.start, `${np}.start`, 0, MAX_PATTERN_BEATS);
        num(note.length, `${np}.length`, 0.001, MAX_PATTERN_BEATS);
        int(note.pitch, `${np}.pitch`, 0, MAX_PITCH);
        num(note.velocity, `${np}.velocity`, 0, 1);
        if (note.pan !== undefined) num(note.pan, `${np}.pan`, -1, 1);
        if (note.probability !== undefined) num(note.probability, `${np}.probability`, 0, 1);
        if (note.ratchet !== undefined) int(note.ratchet, `${np}.ratchet`, 1, MAX_RATCHET);
        if (note.slide !== undefined) {
            const slide = obj(note.slide, `${np}.slide`);
            int(slide.to, `${np}.slide.to`, 0, MAX_PITCH);
            if (slide.at !== undefined) num(slide.at, `${np}.slide.at`, 0, 1);
        }
    });
}

/** the pattern clips of one track */
export function validatePatternClips(raw: unknown, path: string, patterns: ReadonlySet<string>): void {
    arr(raw, path).forEach((c, i) => {
        const cp = `${path}[${i}]`;
        const clip = obj(c, cp);
        const pattern = str(clip.pattern, `${cp}.pattern`);
        if (!patterns.has(pattern)) fail(`${cp}.pattern`, `"${pattern}" is not a pattern of this project`);
        num(clip.startBeat, `${cp}.startBeat`, 0);
        num(clip.length, `${cp}.length`, 0.25, 100_000);
    });
}
