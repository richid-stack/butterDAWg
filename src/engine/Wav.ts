// WAV file writer. Writes 16-bit or 24-bit integer PCM, or 32-bit float.
// Plain typed-array code, so it runs in the app, in a worker and in tests.

export type WavFormat = "pcm16" | "pcm24" | "float32";

export interface WavOptions {
    format?: WavFormat;
    /** add triangular dither when rounding to 16 bits (default true) */
    dither?: boolean;
    /** seed for the dither noise, so the same input always gives the same file */
    seed?: number;
}

/** channels: one Float32Array per channel, all the same length, values nominally in -1..1 */
export function encodeWav(channels: Float32Array[], sampleRate: number, options: WavOptions = {}): Uint8Array {
    const format = options.format ?? "pcm24";
    if (channels.length < 1) throw new Error("a wav file needs at least one channel");
    const frames = channels[0].length;
    for (const ch of channels) {
        if (ch.length !== frames) throw new Error("all channels must have the same length");
    }
    const numChannels = channels.length;
    const bytesPerSample = format === "pcm16" ? 2 : format === "pcm24" ? 3 : 4;
    const blockAlign = numChannels * bytesPerSample;
    const dataBytes = frames * blockAlign;
    const isFloat = format === "float32";
    // float files carry a "fact" chunk, which some readers require
    const headerBytes = 12 + (8 + 16) + (isFloat ? 8 + 4 : 0) + 8;
    const out = new Uint8Array(headerBytes + dataBytes + (dataBytes % 2));
    const view = new DataView(out.buffer);

    let p = 0;
    const text = (s: string) => {
        for (let i = 0; i < s.length; i++) out[p++] = s.charCodeAt(i);
    };
    const u32 = (v: number) => {
        view.setUint32(p, v, true);
        p += 4;
    };
    const u16 = (v: number) => {
        view.setUint16(p, v, true);
        p += 2;
    };

    text("RIFF");
    u32(out.length - 8);
    text("WAVE");
    text("fmt ");
    u32(16);
    u16(isFloat ? 3 : 1);
    u16(numChannels);
    u32(sampleRate);
    u32(sampleRate * blockAlign);
    u16(blockAlign);
    u16(bytesPerSample * 8);
    if (isFloat) {
        text("fact");
        u32(4);
        u32(frames);
    }
    text("data");
    u32(dataBytes);

    let rng = (options.seed ?? 1) >>> 0 || 1;
    const noise = () => {
        // xorshift32, scaled to 0..1
        rng ^= rng << 13;
        rng >>>= 0;
        rng ^= rng >>> 17;
        rng ^= rng << 5;
        rng >>>= 0;
        return rng / 4294967296;
    };
    const dither = format === "pcm16" && (options.dither ?? true);

    for (let i = 0; i < frames; i++) {
        for (let c = 0; c < numChannels; c++) {
            const x = channels[c][i];
            if (isFloat) {
                view.setFloat32(p, x, true);
                p += 4;
            } else if (format === "pcm16") {
                let v = x * 32768;
                if (dither) v += noise() - noise(); // triangular, +-1 step
                view.setInt16(p, clampInt(Math.round(v), -32768, 32767), true);
                p += 2;
            } else {
                const v = clampInt(Math.round(x * 8388608), -8388608, 8388607);
                out[p++] = v & 0xff;
                out[p++] = (v >> 8) & 0xff;
                out[p++] = (v >> 16) & 0xff;
            }
        }
    }
    return out;
}

function clampInt(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}
