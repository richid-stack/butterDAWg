// What a beat is made of, as plain data (no browser types, so Node tests can run it).
//
//   Instrument   one row of the channel rack: a sampler with its zones, envelope and routing
//   Pattern      a loop of notes, for any instruments
//   Note         one hit or one held note: when, how long, which pitch, how hard
//   PatternClip  a placement of a pattern on a playlist track
//
// The step sequencer and the piano roll are two views of the same notes: a step
// is a note that sits on the grid, one step long.

/** the step sequencer's grid: sixteenth notes */
export const STEPS_PER_BEAT = 4;
export const STEP_BEATS = 1 / STEPS_PER_BEAT;

export const MIN_PITCH = 0;
export const MAX_PITCH = 127;
/** the pitch a step in the sequencer plays (middle C), unless it was given another */
export const DEFAULT_PITCH = 60;
export const MAX_RATCHET = 8;

export interface NoteData {
    /** the instrument that plays it (an id from the rack) */
    instrument: string;
    /** where it starts, in beats from the start of the pattern */
    start: number;
    /** how long it is held, in beats */
    length: number;
    /** MIDI note number, 60 = middle C */
    pitch: number;
    /** 0..1 */
    velocity: number;
    /** -1 (left) .. 1 (right); default 0 */
    pan?: number;
    /** the chance that it plays, 0..1; default 1. The same note in the same place always decides the same way. */
    probability?: number;
    /** plays this many times, evenly, in the length of the note; default 1 */
    ratchet?: number;
    /** the pitch glides to this pitch (a slide note); `at` is how far into the note the glide starts, 0..1, default 0 */
    slide?: { to: number; at?: number };
}

export interface PatternData {
    id: string;
    name: string;
    /** "#rrggbb" */
    color: string;
    /** length in beats (16 steps is 4 beats) */
    length: number;
    /** 0.5 (straight) .. 0.75: how far the off-beat sixteenths are pushed late */
    swing?: number;
    notes: NoteData[];
}

export type SamplerMode = "oneshot" | "gate";

/** everything about a zone except which file it plays */
export interface ZoneSettings {
    /** the keys it answers to, MIDI note numbers */
    keyLow: number;
    keyHigh: number;
    /** the key at which the sample plays at its own pitch */
    rootKey: number;
    /** the velocities it answers to, MIDI 1..127 */
    velLow: number;
    velHigh: number;
    /** loop region in seconds of the sample; null for no loop */
    loop: { start: number; end: number } | null;
    /** fine tuning in cents */
    tune: number;
    /** linear gain, 1 is 0 dB */
    volume: number;
    /** -1..1 */
    pan: number;
    /** cents of pitch change per key; 100 (the default) follows the keyboard, 0 plays every key at the sample's own pitch */
    keytrack?: number;
    /** 0..1: how much the velocity changes the loudness (default 1) */
    veltrack?: number;
    /** round robin: zones of the same key and velocity range with a `seqLength` take turns, each playing when `seqPosition` comes round */
    seqLength?: number;
    seqPosition?: number;
    /** only sounds while this key switch note was the last one pressed (see SamplerData.keySwitch) */
    swLast?: number;
    /** an envelope of its own instead of the instrument's */
    env?: { attack: number; decay: number; sustain: number; release: number };
}

/** a zone as it is saved: its settings and the asset (an id from the project's assets) it plays */
export interface ZoneData extends ZoneSettings {
    asset: string;
}

export interface SamplerData {
    zones: ZoneData[];
    /**
     * "oneshot": plays the whole sample whatever the note length (drums).
     * "gate": the note's length is how long the sound is held, then it releases (basses, keys).
     */
    mode: SamplerMode;
    /** envelope times in seconds, sustain is a level 0..1 */
    attack: number;
    decay: number;
    sustain: number;
    release: number;
    /** instruments in the same group cut each other off (an open hat that a closed hat ends); 0 for none */
    chokeGroup: number;
    /** notes in this range choose which zones sound (an articulation) instead of playing; `default` is chosen at the start */
    keySwitch?: { low: number; high: number; default: number | null };
}

export interface InstrumentData {
    id: string;
    name: string;
    /** "#rrggbb" */
    color: string;
    /** the mixer channel it plays into; null for nowhere */
    channel: number | null;
    /** linear gain, 1 is 0 dB */
    volume: number;
    /** -1..1 */
    pan: number;
    muted: boolean;
    sampler: SamplerData;
}

export interface RackData {
    instruments: InstrumentData[];
}

export interface PatternClipData {
    pattern: string;
    startBeat: number;
    /** how long the clip lasts in beats; the pattern repeats if this is longer than the pattern */
    length: number;
}

/** what the PAT and SONG buttons say: play the open pattern in a loop, or the playlist */
export type PlayScope = "pattern" | "song";

export interface BeatData {
    rack: RackData;
    patterns: PatternData[];
    /** the pattern that is open in the channel rack and piano roll (a pattern id) */
    activePattern: string | null;
    scope: PlayScope;
}

// ---- starting values ---------------------------------------------------------------

export function emptySampler(mode: SamplerMode = "oneshot"): SamplerData {
    return { zones: [], mode, attack: 0.001, decay: 0, sustain: 1, release: 0.05, chokeGroup: 0 };
}

export function emptyBeat(): BeatData {
    return { rack: { instruments: [] }, patterns: [], activePattern: null, scope: "song" };
}

/** a copy that shares nothing with the original; optional fields are copied only when they are there */
export function cloneNote(n: NoteData): NoteData {
    const c: NoteData = { ...n };
    if (n.slide) c.slide = { ...n.slide };
    return c;
}

export function clonePattern(p: PatternData): PatternData {
    return { ...p, notes: p.notes.map(cloneNote) };
}

export function clampPitch(p: number): number {
    return Math.max(MIN_PITCH, Math.min(MAX_PITCH, Math.round(p)));
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** 60 -> "C4" */
export function pitchName(pitch: number): string {
    const p = Math.round(pitch);
    return NOTE_NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
}

/** "c4", "C#3", "Db2" -> MIDI number; null if it is not a note name */
export function parsePitch(name: string): number | null {
    const m = /^([a-gA-G])([#b]?)(-?\d+)$/.exec(name.trim());
    if (!m) return null;
    const base: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
    const accidental = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
    const value = base[m[1].toLowerCase()] + accidental + (parseInt(m[3], 10) + 1) * 12;
    return value < MIN_PITCH || value > MAX_PITCH ? null : value;
}
