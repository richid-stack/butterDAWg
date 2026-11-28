// Turns patterns and where they are placed into the list of notes to play.
//
// This is the one place that decides which notes sound and when: swing moves
// them, a ratchet splits them, a probability may drop them, a clip shorter than
// its pattern cuts it, and a clip longer than its pattern repeats it. Live
// playback and the export both use the result, so they play the same notes.
// No Web Audio here, so it is tested in Node.

import { MAX_RATCHET, NoteData, PatternData } from "./data";

/** one note to play, with its place on the song's timeline */
export interface NoteEventData {
    instrument: string;
    /** where it starts, in beats on the song's timeline */
    startBeat: number;
    lengthBeats: number;
    pitch: number;
    velocity: number;
    pan: number;
    /** pitch to glide to, and how far into the note the glide begins (0..1) */
    slideTo: number | null;
    slideAt: number;
    /** how many notes of this instrument came before it, counting from the start of the song (for round robin) */
    seq: number;
}

export const SWING_STRAIGHT = 0.5;
export const SWING_MAX = 0.75;
// swing works on pairs of sixteenths: half a beat
const SWING_CELL = 0.5;

/**
 * Moves a position in beats the way swing does. Inside each pair of sixteenths
 * the second one is pushed later; 0.5 leaves everything where it is, 0.667 is
 * triplet swing. Positions between are stretched evenly, so the order of notes
 * never changes and a note that is not on the grid moves too, in proportion.
 */
export function swingBeat(beat: number, swing: number): number {
    if (swing === SWING_STRAIGHT) return beat;
    const s = Math.max(SWING_STRAIGHT, Math.min(SWING_MAX, swing));
    const cell = Math.floor(beat / SWING_CELL + 1e-9);
    const r = (beat - cell * SWING_CELL) / SWING_CELL; // 0..1 inside the pair
    const warped = r < 0.5 ? r * 2 * s : s + (r - 0.5) * 2 * (1 - s);
    return (cell + warped) * SWING_CELL;
}

/** A number between 0 and 1 that depends only on its inputs (a small integer hash), so a "maybe" always comes out the same. */
export function chance(...values: number[]): number {
    let h = 2166136261;
    for (const v of values) {
        const n = Math.round(v * 1000) | 0;
        h ^= n + 0x9e3779b9 + ((h << 6) | 0) + (h >>> 2);
        h = Math.imul(h, 16777619);
        h ^= h >>> 15;
    }
    h = Math.imul(h ^ (h >>> 13), 0x85ebca6b);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

function hashText(text: string): number {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
    return h;
}

export interface Placement {
    /** where the pattern is placed on the song's timeline, in beats */
    startBeat: number;
    /** how long the placement lasts, in beats */
    length: number;
}

/**
 * The notes one placement of a pattern plays. `seq` is not set here (see assignSequence).
 */
export function notesOfPlacement(pattern: PatternData, placement: Placement): NoteEventData[] {
    const out: NoteEventData[] = [];
    const patternLength = pattern.length;
    if (!(patternLength > 0) || !(placement.length > 0)) return out;
    const swing = pattern.swing ?? SWING_STRAIGHT;
    const salt = hashText(pattern.id);
    const end = placement.startBeat + placement.length;

    for (let loop = 0; loop * patternLength < placement.length; loop++) {
        const base = placement.startBeat + loop * patternLength;
        pattern.notes.forEach((note, index) => {
            if (!(note.start >= 0) || note.start >= patternLength) return; // outside the pattern
            const start = base + swingBeat(note.start, swing);
            if (start >= end - 1e-9) return;
            // a "maybe" is decided by the note and its place in the song, so every loop can differ but a render is always the same
            const p = note.probability ?? 1;
            if (p < 1 && chance(salt, index, start) >= p) return;

            const noteEnd = Math.min(base + swingBeat(Math.min(note.start + note.length, patternLength), swing), end);
            const length = Math.max(noteEnd - start, 1e-6);
            const hits = Math.max(1, Math.min(MAX_RATCHET, Math.round(note.ratchet ?? 1)));
            for (let h = 0; h < hits; h++) {
                const piece = length / hits;
                out.push(eventOf(note, start + h * piece, piece));
            }
        });
    }
    return out;
}

function eventOf(note: NoteData, startBeat: number, lengthBeats: number): NoteEventData {
    return {
        instrument: note.instrument,
        startBeat,
        lengthBeats,
        pitch: note.pitch,
        velocity: note.velocity,
        pan: note.pan ?? 0,
        slideTo: note.slide ? note.slide.to : null,
        slideAt: note.slide?.at ?? 0,
        seq: 0,
    };
}

/** Puts the notes in time order (notes at the same moment keep the order they came in) and numbers them per instrument. */
export function assignSequence(events: NoteEventData[]): NoteEventData[] {
    const sorted = events
        .map((e, i) => ({ e, i }))
        .sort((a, b) => a.e.startBeat - b.e.startBeat || a.i - b.i)
        .map((x) => x.e);
    const counts = new Map<string, number>();
    for (const e of sorted) {
        const n = counts.get(e.instrument) ?? 0;
        e.seq = n;
        counts.set(e.instrument, n + 1);
    }
    return sorted;
}

/** Every note the song plays: each placement of each pattern. */
export function notesOfSong(
    patterns: ReadonlyMap<string, PatternData>,
    placements: Iterable<Placement & { pattern: string }>,
): NoteEventData[] {
    const all: NoteEventData[] = [];
    for (const placement of placements) {
        const pattern = patterns.get(placement.pattern);
        if (pattern) all.push(...notesOfPlacement(pattern, placement));
    }
    return assignSequence(all);
}

/** The notes of the open pattern played alone: one placement at beat 0, as long as the pattern. */
export function notesOfPattern(pattern: PatternData): NoteEventData[] {
    return assignSequence(notesOfPlacement(pattern, { startBeat: 0, length: pattern.length }));
}
