import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSfz } from "../src/instruments/sfz";
import { isKeySwitch, midiVelocity, pickZones, playbackRate, velocityGain } from "../src/instruments/zones";
import { ZoneData } from "../src/beat/data";

test("sfz: a region inherits from global, master and group, and the nearest wins", () => {
    const sfz = parseSfz(`
        <global> ampeg_release=0.3 volume=-3
        <master> pan=50
        <group> lovel=1 hivel=63 ampeg_release=0.5
        <region> sample=a.wav key=c4
        <region> sample=b.wav lokey=d4 hikey=e4 pitch_keycenter=d4 volume=-6
        <group> lovel=64 hivel=127
        <region> sample=c.wav key=60
    `);
    assert.equal(sfz.regions.length, 3);
    const [a, b, c] = sfz.regions;
    assert.deepEqual([a.keyLow, a.keyHigh, a.rootKey], [60, 60, 60]);
    assert.deepEqual([a.velLow, a.velHigh], [1, 63]);
    assert.equal(a.release, 0.5); // the group's, not the global's
    assert.equal(a.volume, -3);
    assert.equal(a.pan, 0.5);
    assert.deepEqual([b.keyLow, b.keyHigh, b.rootKey], [62, 64, 62]);
    assert.equal(b.volume, -6); // the region's own
    assert.deepEqual([c.velLow, c.velHigh], [64, 127]);
    assert.equal(c.release, 0.3); // the new group starts again from the global
    assert.deepEqual(sfz.warnings, []);
});

test("sfz: comments, a default path, and sample names with spaces", () => {
    const sfz = parseSfz(`
        // a line comment
        <control> default_path=Samples\\Piano/
        /* a block
           comment */ <region> sample=Soft C4.wav key=c4 // trailing comment
        <region> sample=hat open.wav key=d4
    `);
    assert.deepEqual(sfz.regions.map((r) => r.sample), ["Samples/Piano/Soft C4.wav", "Samples/Piano/hat open.wav"]);
    assert.equal(sfz.regions[0].keyLow, 60);
});

test("sfz: defines", () => {
    const sfz = parseSfz(`
        #define $ROOT 64
        #define $ROOTNAME e4
        <region> sample=x.wav key=$ROOT
        <region> sample=y.wav key=$ROOTNAME
    `);
    assert.deepEqual(sfz.regions.map((r) => r.keyLow), [64, 64]);
});

test("sfz: loops, tuning, envelope and tracking", () => {
    const [r] = parseSfz(`<region> sample=pad.wav key=c3 loop_mode=loop_continuous loop_start=1000 loop_end=9000
        tune=-20 transpose=2 ampeg_attack=0.2 ampeg_decay=0.1 ampeg_sustain=70 ampeg_release=1.5
        pitch_keytrack=0 amp_veltrack=50`).regions;
    assert.equal(r.loopMode, "loop_continuous");
    assert.deepEqual([r.loopStart, r.loopEnd], [1000, 9000]);
    assert.equal(r.tune, 180); // -20 cents and two semitones
    assert.deepEqual([r.attack, r.decay, r.sustain, r.release], [0.2, 0.1, 0.7, 1.5]);
    assert.equal(r.keytrack, 0);
    assert.equal(r.veltrack, 0.5);
});

test("sfz: round robin, choke groups and key switches", () => {
    const sfz = parseSfz(`
        <group> sw_lokey=c1 sw_hikey=e1 sw_default=c1
        <region> sample=a.wav key=c3 sw_last=c1 seq_length=2 seq_position=1 group=1 off_by=1
        <region> sample=b.wav key=c3 sw_last=c1 seq_length=2 seq_position=2 group=1 off_by=1
        <region> sample=c.wav key=c3 sw_last=d1
    `);
    assert.deepEqual(sfz.keySwitch, { low: 24, high: 28, default: 24 });
    assert.deepEqual(sfz.regions.map((r) => [r.seqLength, r.seqPosition, r.swLast]), [[2, 1, 24], [2, 2, 24], [null, null, 26]]);
    assert.deepEqual([sfz.regions[0].group, sfz.regions[0].offBy], [1, 1]);
});

test("sfz: random round robin becomes a fixed round robin, with a warning", () => {
    const sfz = parseSfz(`
        <group> key=c4
        <region> sample=a.wav lorand=0 hirand=0.5
        <region> sample=b.wav lorand=0.5 hirand=1
    `);
    assert.deepEqual(sfz.regions.map((r) => [r.seqLength, r.seqPosition]), [[2, 1], [2, 2]]);
    assert.ok(sfz.warnings.some((w) => /lorand/.test(w)));
});

test("sfz: what is not supported is reported, not dropped without a word", () => {
    const sfz = parseSfz(`
        <region> sample=a.wav key=c4 cutoff=2000 fil_type=lpf_2p
        <region> sample=b.wav key=c4 trigger=release
        <region> sample=c.wav key=d4 trigger=attack offset=0
        <region> sample=*sine
        <region> sample=gone.wav end=-1
        <region> sample=d.wav key=e4 direction=reverse
    `);
    assert.deepEqual(sfz.regions.map((r) => r.sample), ["a.wav", "c.wav"]); // release samples, generators, off and reversed regions are skipped
    const text = sfz.warnings.join("\n");
    assert.match(text, /cutoff/);
    assert.match(text, /trigger=release/);
    assert.match(text, /\*sine/);
    assert.doesNotMatch(text, /offset/, "offset=0 means nothing to report");
});

test("sfz: includes are read through the callback, and a missing one is reported", () => {
    const read = (p: string) => (p === "keys.sfz" ? "<region> sample=k.wav key=c4" : null);
    const sfz = parseSfz(`#include "keys.sfz"\n#include "nope.sfz"\n<region> sample=l.wav key=d4`, { readInclude: read });
    assert.deepEqual(sfz.regions.map((r) => r.sample), ["k.wav", "l.wav"]);
    assert.ok(sfz.warnings.some((w) => /nope\.sfz/.test(w)));
});

test("sfz: text that is not sfz gives no regions rather than an error", () => {
    assert.deepEqual(parseSfz("hello world, this is not a sampler file").regions, []);
    assert.deepEqual(parseSfz("").regions, []);
    assert.equal(parseSfz("<region>\n<region> sample=x.wav").regions.length, 1);
});

const zone = (over: Partial<ZoneData> = {}): ZoneData => ({
    asset: "a1", keyLow: 0, keyHigh: 127, rootKey: 60, velLow: 1, velHigh: 127, loop: null, tune: 0, volume: 1, pan: 0, ...over,
});

test("zones: key and velocity ranges", () => {
    const zones = [
        zone({ asset: "low", keyLow: 0, keyHigh: 59 }),
        zone({ asset: "soft", keyLow: 60, keyHigh: 72, velLow: 1, velHigh: 63 }),
        zone({ asset: "loud", keyLow: 60, keyHigh: 72, velLow: 64, velHigh: 127 }),
    ];
    const names = (pitch: number, velocity: number) => pickZones(zones, { pitch, velocity, seq: 0, switchNote: null }).map((z) => z.asset);
    assert.deepEqual(names(50, 1), ["low"]);
    assert.deepEqual(names(60, 0.2), ["soft"]);
    assert.deepEqual(names(60, 0.9), ["loud"]);
    assert.deepEqual(names(73, 1), []);
    assert.equal(midiVelocity(0), 1);
    assert.equal(midiVelocity(1), 127);
    assert.equal(midiVelocity(0.5), 64);
});

test("zones: round robin takes turns, from the start of the song", () => {
    const zones = [zone({ asset: "x", seqLength: 3, seqPosition: 1 }), zone({ asset: "y", seqLength: 3, seqPosition: 2 }), zone({ asset: "z", seqLength: 3, seqPosition: 3 })];
    const heard = [0, 1, 2, 3, 4, 5].map((seq) => pickZones(zones, { pitch: 60, velocity: 1, seq, switchNote: null })[0].asset);
    assert.deepEqual(heard, ["x", "y", "z", "x", "y", "z"]);
    // a zone with no round robin always sounds with the one whose turn it is
    const both = pickZones([...zones, zone({ asset: "always" })], { pitch: 60, velocity: 1, seq: 1, switchNote: null });
    assert.deepEqual(both.map((z) => z.asset), ["y", "always"]);
});

test("zones: key switches choose which zones sound", () => {
    const zones = [zone({ asset: "sustain", swLast: 24 }), zone({ asset: "staccato", swLast: 26 }), zone({ asset: "both" })];
    const names = (switchNote: number | null) => pickZones(zones, { pitch: 60, velocity: 1, seq: 0, switchNote }).map((z) => z.asset);
    assert.deepEqual(names(24), ["sustain", "both"]);
    assert.deepEqual(names(26), ["staccato", "both"]);
    assert.deepEqual(names(null), ["both"]);
    assert.equal(isKeySwitch(25, { low: 24, high: 28 }), true);
    assert.equal(isKeySwitch(60, { low: 24, high: 28 }), false);
    assert.equal(isKeySwitch(60, undefined), false);
});

test("zones: pitch and velocity", () => {
    assert.equal(playbackRate(zone({ rootKey: 60 }), 60), 1);
    assert.equal(playbackRate(zone({ rootKey: 60 }), 72), 2);
    assert.ok(Math.abs(playbackRate(zone({ rootKey: 60 }), 48) - 0.5) < 1e-12);
    assert.ok(Math.abs(playbackRate(zone({ rootKey: 60, tune: 1200 }), 60) - 2) < 1e-12);
    // keytrack 0: every key plays the sample as it is
    assert.equal(playbackRate(zone({ rootKey: 60, keytrack: 0 }), 90), 1);
    assert.equal(velocityGain(1), 1);
    assert.equal(velocityGain(0.5), 0.5);
    assert.equal(velocityGain(0.2, 0), 1); // no velocity tracking
    assert.equal(velocityGain(2), 1);
});
