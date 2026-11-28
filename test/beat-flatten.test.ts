import { test } from "node:test";
import assert from "node:assert/strict";
import { NoteData, PatternData, parsePitch, pitchName, clampPitch } from "../src/beat/data";
import {
    assignSequence,
    chance,
    notesOfPattern,
    notesOfPlacement,
    notesOfSong,
    swingBeat,
    SWING_STRAIGHT,
} from "../src/beat/flatten";

const note = (over: Partial<NoteData> = {}): NoteData => ({ instrument: "i1", start: 0, length: 0.25, pitch: 60, velocity: 0.8, ...over });
const pattern = (notes: NoteData[], over: Partial<PatternData> = {}): PatternData => ({
    id: "p1", name: "Pattern 1", color: "#808080", length: 4, notes, ...over,
});

test("swing: straight leaves every position where it is", () => {
    for (const b of [0, 0.25, 0.5, 0.75, 1.3, 7.99]) assert.equal(swingBeat(b, SWING_STRAIGHT), b);
});

test("swing: the second sixteenth of each pair is late, the first is not", () => {
    const s = 2 / 3; // triplet swing
    assert.equal(swingBeat(0, s), 0);
    assert.ok(Math.abs(swingBeat(0.25, s) - s * 0.5) < 1e-12, "0.25 -> 0.3333");
    assert.equal(swingBeat(0.5, s), 0.5); // the next pair starts on time
    assert.ok(Math.abs(swingBeat(1.25, s) - (1 + s * 0.5)) < 1e-12);
});

test("swing: it never changes the order of notes, and it stays inside the pair", () => {
    for (const s of [0.55, 0.6, 2 / 3, 0.75]) {
        let last = -1;
        for (let i = 0; i <= 400; i++) {
            const b = i / 100;
            const w = swingBeat(b, s);
            assert.ok(w >= last - 1e-12, `order at ${b} with ${s}`);
            last = w;
            assert.ok(Math.abs(w - b) < 0.25 + 1e-9, "moves less than half of a pair");
        }
    }
    // more than the maximum is the maximum
    assert.equal(swingBeat(0.25, 0.9), swingBeat(0.25, 0.75));
});

test("chance: always the same for the same inputs, spread over 0..1", () => {
    assert.equal(chance(1, 2, 3), chance(1, 2, 3));
    assert.notEqual(chance(1, 2, 3), chance(1, 2, 4));
    let below = 0;
    for (let i = 0; i < 4000; i++) if (chance(7, i, i * 0.25) < 0.5) below++;
    assert.ok(below > 1800 && below < 2200, `about half below 0.5, got ${below}`);
});

test("a pattern placed once plays each note at its place", () => {
    const p = pattern([note({ start: 0 }), note({ start: 1 }), note({ start: 2.5, pitch: 64 })]);
    const events = notesOfPlacement(p, { startBeat: 8, length: 4 });
    assert.deepEqual(events.map((e) => e.startBeat), [8, 9, 10.5]);
    assert.equal(events[2].pitch, 64);
    assert.equal(events[0].pan, 0);
    assert.equal(events[0].slideTo, null);
});

test("a clip longer than the pattern repeats it; a shorter one cuts it", () => {
    const p = pattern([note({ start: 0 }), note({ start: 3 })]);
    assert.deepEqual(notesOfPlacement(p, { startBeat: 0, length: 8 }).map((e) => e.startBeat), [0, 3, 4, 7]);
    assert.deepEqual(notesOfPlacement(p, { startBeat: 0, length: 2 }).map((e) => e.startBeat), [0]);
});

test("a held note is cut where the clip ends", () => {
    const held = pattern([note({ start: 3, length: 1 })]);
    const [e] = notesOfPlacement(held, { startBeat: 10, length: 3.5 });
    assert.equal(e.startBeat, 13);
    assert.ok(Math.abs(e.lengthBeats - 0.5) < 1e-9, `length ${e.lengthBeats}`);
});

test("notes outside the pattern, or with a bad start, are not played", () => {
    const p = pattern([note({ start: 4 }), note({ start: -1 }), note({ start: NaN }), note({ start: 3.75 })]);
    assert.deepEqual(notesOfPlacement(p, { startBeat: 0, length: 4 }).map((e) => e.startBeat), [3.75]);
    assert.deepEqual(notesOfPlacement(pattern([], { length: 0 }), { startBeat: 0, length: 4 }), []);
    assert.deepEqual(notesOfPlacement(pattern([note()]), { startBeat: 0, length: 0 }), []);
});

test("ratchet splits a note into equal hits within its length", () => {
    const p = pattern([note({ start: 1, length: 0.5, ratchet: 4, velocity: 0.7 })]);
    const events = notesOfPlacement(p, { startBeat: 0, length: 4 });
    assert.equal(events.length, 4);
    assert.deepEqual(events.map((e) => e.startBeat), [1, 1.125, 1.25, 1.375]);
    for (const e of events) {
        assert.ok(Math.abs(e.lengthBeats - 0.125) < 1e-12);
        assert.equal(e.velocity, 0.7);
    }
    // not more than the limit, never fewer than one
    assert.equal(notesOfPlacement(pattern([note({ ratchet: 99 })]), { startBeat: 0, length: 4 }).length, 8);
    assert.equal(notesOfPlacement(pattern([note({ ratchet: 0 })]), { startBeat: 0, length: 4 }).length, 1);
});

test("probability: the same song always gives the same notes, and it is about right", () => {
    const notes: NoteData[] = [];
    for (let i = 0; i < 64; i++) notes.push(note({ start: i * 0.25, probability: 0.5 }));
    const p = pattern(notes, { length: 16 });
    const a = notesOfPlacement(p, { startBeat: 0, length: 64 }); // four loops
    const b = notesOfPlacement(p, { startBeat: 0, length: 64 });
    assert.deepEqual(a, b);
    const share = a.length / (64 * 4);
    assert.ok(share > 0.4 && share < 0.6, `about half played, got ${share}`);
    // every loop decides on its own
    const first = a.filter((e) => e.startBeat < 16).map((e) => e.startBeat);
    const second = a.filter((e) => e.startBeat >= 16 && e.startBeat < 32).map((e) => e.startBeat - 16);
    assert.notDeepEqual(first, second);
    // 1 always plays, 0 never does
    assert.equal(notesOfPlacement(pattern([note({ probability: 1 })]), { startBeat: 0, length: 4 }).length, 1);
    assert.equal(notesOfPlacement(pattern([note({ probability: 0 })]), { startBeat: 0, length: 4 }).length, 0);
});

test("swing moves the note and its end together", () => {
    const p = pattern([note({ start: 0.25, length: 0.25 })], { swing: 2 / 3 });
    const [e] = notesOfPlacement(p, { startBeat: 0, length: 4 });
    assert.ok(Math.abs(e.startBeat - (2 / 3) * 0.5) < 1e-12);
    // the end is the next pair's start, which does not move
    assert.ok(Math.abs(e.startBeat + e.lengthBeats - 0.5) < 1e-12);
});

test("slide and pan are carried to the event", () => {
    const p = pattern([note({ pan: -0.5, slide: { to: 67, at: 0.5 } })]);
    const [e] = notesOfPlacement(p, { startBeat: 0, length: 4 });
    assert.equal(e.pan, -0.5);
    assert.equal(e.slideTo, 67);
    assert.equal(e.slideAt, 0.5);
});

test("the song: placements are put in time order and numbered per instrument", () => {
    const patterns = new Map<string, PatternData>([
        ["a", pattern([note({ start: 0, instrument: "kick" }), note({ start: 2, instrument: "kick" }), note({ start: 1, instrument: "hat" })], { id: "a" })],
    ]);
    const events = notesOfSong(patterns, [
        { pattern: "a", startBeat: 4, length: 4 },
        { pattern: "a", startBeat: 0, length: 4 },
        { pattern: "missing", startBeat: 0, length: 4 },
    ]);
    assert.deepEqual(events.map((e) => [e.startBeat, e.instrument, e.seq]), [
        [0, "kick", 0], [1, "hat", 0], [2, "kick", 1], [4, "kick", 2], [5, "hat", 1], [6, "kick", 3],
    ]);
});

test("notes at the same moment keep the order they were given", () => {
    const events = assignSequence([
        { instrument: "a", startBeat: 1, lengthBeats: 1, pitch: 60, velocity: 1, pan: 0, slideTo: null, slideAt: 0, seq: 0 },
        { instrument: "a", startBeat: 1, lengthBeats: 1, pitch: 64, velocity: 1, pan: 0, slideTo: null, slideAt: 0, seq: 0 },
        { instrument: "a", startBeat: 0, lengthBeats: 1, pitch: 55, velocity: 1, pan: 0, slideTo: null, slideAt: 0, seq: 0 },
    ]);
    assert.deepEqual(events.map((e) => e.pitch), [55, 60, 64]);
    assert.deepEqual(events.map((e) => e.seq), [0, 1, 2]);
});

test("the open pattern alone is one placement from beat 0", () => {
    const p = pattern([note({ start: 0 }), note({ start: 3 })]);
    assert.deepEqual(notesOfPattern(p).map((e) => e.startBeat), [0, 3]);
});

test("pitch names", () => {
    assert.equal(pitchName(60), "C4");
    assert.equal(pitchName(61), "C#4");
    assert.equal(pitchName(36), "C2");
    assert.equal(pitchName(0), "C-1");
    assert.equal(parsePitch("c4"), 60);
    assert.equal(parsePitch("C#3"), 49);
    assert.equal(parsePitch("Db3"), 49);
    assert.equal(parsePitch("g9"), 127);
    assert.equal(parsePitch("g#9"), null);
    assert.equal(parsePitch("hello"), null);
    assert.equal(clampPitch(200), 127);
    assert.equal(clampPitch(-5), 0);
    assert.equal(clampPitch(60.4), 60);
});
