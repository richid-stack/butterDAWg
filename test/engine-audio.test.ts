import { test } from "node:test";
import assert from "node:assert/strict";
import { WaveFile } from "wavefile";
import { encodeWav } from "../src/engine/Wav";
import { Peaks } from "../src/engine/Peaks";
import { dbToGain, faderToGain, formatDb, gainToDb, gainToFader, peakOf, rmsOf } from "../src/engine/dsp";
import { isAudioFile } from "../src/engine/AudioLoader";

const tone = (frames: number, freq: number, rate: number, amp = 0.5) =>
    Float32Array.from({ length: frames }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));

test("wav: 24-bit stereo file reads back through an independent parser", () => {
    const left = tone(4800, 440, 48000);
    const right = tone(4800, 660, 48000, 0.25);
    const bytes = encodeWav([left, right], 48000, { format: "pcm24" });
    const wav = new WaveFile(bytes);
    const fmt = wav.fmt as { numChannels: number; sampleRate: number; bitsPerSample: number };
    assert.equal(fmt.numChannels, 2);
    assert.equal(fmt.sampleRate, 48000);
    assert.equal(fmt.bitsPerSample, 24);
    const samples = wav.getSamples(false, Float64Array) as unknown as Float64Array[];
    assert.equal(samples[0].length, 4800);
    let worst = 0;
    for (let i = 0; i < 4800; i++) {
        worst = Math.max(worst, Math.abs(samples[0][i] / 8388608 - left[i]), Math.abs(samples[1][i] / 8388608 - right[i]));
    }
    assert.ok(worst < 1 / 8388608, "24-bit error " + worst);
});

test("wav: 32-bit float is lossless and 16-bit is within one step", () => {
    const mono = tone(1000, 100, 44100, 0.9);
    const f = new WaveFile(encodeWav([mono], 44100, { format: "float32" }));
    assert.equal((f.fmt as { audioFormat: number }).audioFormat, 3);
    const back = f.getSamples(false, Float32Array) as unknown as Float32Array;
    assert.deepEqual(Array.from(back), Array.from(mono));

    const w16 = new WaveFile(encodeWav([mono], 44100, { format: "pcm16", dither: false }));
    const s16 = w16.getSamples(false, Float64Array) as unknown as Float64Array;
    for (let i = 0; i < mono.length; i++) assert.ok(Math.abs(s16[i] / 32768 - mono[i]) <= 1 / 32768);
});

test("wav: 16-bit dither is repeatable and overloads are clipped, not wrapped", () => {
    const a = encodeWav([tone(500, 50, 44100)], 44100, { format: "pcm16", seed: 5 });
    const b = encodeWav([tone(500, 50, 44100)], 44100, { format: "pcm16", seed: 5 });
    assert.deepEqual(Array.from(a), Array.from(b));
    const hot = new WaveFile(encodeWav([Float32Array.from([2, -2, 0.5])], 44100, { format: "pcm24" }));
    const v = hot.getSamples(false, Float64Array) as unknown as Float64Array;
    assert.equal(v[0], 8388607);
    assert.equal(v[1], -8388608);
});

test("wav: rejects mismatched channels", () => {
    assert.throws(() => encodeWav([new Float32Array(3), new Float32Array(4)], 44100));
    assert.throws(() => encodeWav([], 44100));
});

test("peaks: match a brute-force scan and cover mono and stereo", () => {
    const left = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 7));
    const right = Float32Array.from({ length: 1000 }, (_, i) => 0.5 * Math.cos(i / 3));
    const peaks = Peaks.fromChannels([left, right], 100);
    assert.equal(peaks.length, 10);
    for (let p = 0; p < 10; p++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = p * 100; i < p * 100 + 100; i++) {
            lo = Math.min(lo, left[i], right[i]);
            hi = Math.max(hi, left[i], right[i]);
        }
        assert.equal(peaks.min[p], lo);
        assert.equal(peaks.max[p], hi);
    }
    const five = peaks.resample(5);
    assert.equal(five.min.length, 5);
    assert.equal(five.max[0], Math.max(peaks.max[0], peaks.max[1]));
    const many = peaks.resample(40); // more columns than peaks still gives values
    assert.equal(many.max.length, 40);
    assert.ok(Peaks.fromChannels([], 100).length === 1);
});

test("fader law: unity at 0.8, +6 dB at the top, silence at the bottom, invertible", () => {
    assert.equal(faderToGain(0), 0);
    assert.ok(Math.abs(faderToGain(0.8) - 1) < 1e-12);
    assert.ok(Math.abs(gainToDb(faderToGain(1)) - 6) < 1e-9);
    assert.ok(Math.abs(gainToDb(faderToGain(0.4)) + 12.04) < 0.01); // half way down: about -12 dB
    for (const f of [0.05, 0.3, 0.55, 0.8, 0.9, 1]) {
        assert.ok(Math.abs(gainToFader(faderToGain(f)) - f) < 1e-9, "fader " + f);
    }
    let prev = -1;
    for (let f = 0; f <= 1.0001; f += 0.01) {
        const g = faderToGain(f);
        assert.ok(g >= prev, "monotonic at " + f);
        prev = g;
    }
    assert.equal(formatDb(1), "0.0 dB");
    assert.equal(formatDb(0), "-inf dB");
    assert.ok(Math.abs(dbToGain(-6.0206) - 0.5) < 1e-4);
});

test("levels: peak and rms", () => {
    const s = Float32Array.from([0.5, -0.8, 0.2, 0]);
    assert.equal(peakOf(s), Float32Array.from([0.8])[0]);
    assert.ok(Math.abs(rmsOf(Float32Array.from([1, -1, 1, -1])) - 1) < 1e-12);
    assert.equal(rmsOf(new Float32Array(0)), 0);
});

test("audio file names", () => {
    assert.ok(isAudioFile("kick.WAV"));
    assert.ok(isAudioFile("a.b.flac"));
    assert.ok(!isAudioFile("notes.txt"));
    assert.ok(!isAudioFile("wav"));
});
