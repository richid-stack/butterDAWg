// Which zones of a sampler answer to a note, and how a zone plays it.
// Pure functions (no Web Audio), so they are tested in Node.

import { ZoneSettings } from "../beat/data";

export interface NoteQuery {
    /** MIDI note number */
    pitch: number;
    /** 0..1 */
    velocity: number;
    /** how many notes this instrument played before this one, counted from the start of the song (round robin) */
    seq: number;
    /** the key switch that is active, or null */
    switchNote: number | null;
}

/** 0..1 to MIDI velocity 1..127 */
export function midiVelocity(velocity: number): number {
    return Math.max(1, Math.min(127, Math.round(velocity * 127)));
}

/**
 * The zones that sound for a note: the ones whose key and velocity ranges hold
 * it, that belong to the active key switch, and, for round robin, the one
 * whose turn it is.
 */
export function pickZones<T>(zones: readonly T[], query: NoteQuery, settings: (zone: T) => ZoneSettings = (zone) => zone as unknown as ZoneSettings): T[] {
    const vel = midiVelocity(query.velocity);
    const out: T[] = [];
    for (const item of zones) {
        const z = settings(item);
        if (query.pitch < z.keyLow || query.pitch > z.keyHigh) continue;
        if (vel < z.velLow || vel > z.velHigh) continue;
        if (z.swLast !== undefined && z.swLast !== query.switchNote) continue;
        if (z.seqLength !== undefined && z.seqLength > 1) {
            const turn = (((query.seq % z.seqLength) + z.seqLength) % z.seqLength) + 1;
            if (turn !== (z.seqPosition ?? 1)) continue;
        }
        out.push(item);
    }
    return out;
}

/** How fast the sample is played for a pitch: 1 is its own speed, 2 an octave up. */
export function playbackRate(zone: ZoneSettings, pitch: number): number {
    const keytrack = zone.keytrack ?? 100;
    const cents = (pitch - zone.rootKey) * keytrack + zone.tune;
    return Math.pow(2, cents / 1200);
}

/** How loud a note is for a velocity: 0..1 at full velocity-tracking, steady loudness at none. */
export function velocityGain(velocity: number, veltrack = 1): number {
    const v = Math.max(0, Math.min(1, velocity));
    return 1 - veltrack + veltrack * v;
}

/** whether a note is a key switch (it chooses an articulation and makes no sound itself) */
export function isKeySwitch(pitch: number, range: { low: number; high: number } | undefined): boolean {
    return !!range && pitch >= range.low && pitch <= range.high;
}
