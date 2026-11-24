// Waveform peaks: the lowest and highest sample in each block of frames. Drawing
// a waveform from peaks needs a few thousand numbers instead of every sample,
// so a long file draws as fast as a short one. The peaks are made once, when
// the file is decoded, and resampled to whatever width is needed.

export class Peaks {
    constructor(
        /** frames summarised by each peak */
        readonly framesPerPeak: number,
        readonly min: Float32Array,
        readonly max: Float32Array,
    ) {}

    get length(): number {
        return this.min.length;
    }

    /** Peaks over all channels (the lowest and highest value found in any channel). */
    static fromChannels(channels: Float32Array[], framesPerPeak = 256): Peaks {
        const frames = channels.length ? channels[0].length : 0;
        const count = Math.max(1, Math.ceil(frames / framesPerPeak));
        const min = new Float32Array(count);
        const max = new Float32Array(count);
        for (let p = 0; p < count; p++) {
            const from = p * framesPerPeak;
            const to = Math.min(frames, from + framesPerPeak);
            let lo = Infinity;
            let hi = -Infinity;
            for (const ch of channels) {
                for (let i = from; i < to; i++) {
                    const v = ch[i];
                    if (v < lo) lo = v;
                    if (v > hi) hi = v;
                }
            }
            min[p] = lo === Infinity ? 0 : lo;
            max[p] = hi === -Infinity ? 0 : hi;
        }
        return new Peaks(framesPerPeak, min, max);
    }

    /** `columns` min/max pairs covering the whole file, for drawing at that width */
    resample(columns: number): { min: Float32Array; max: Float32Array } {
        const n = Math.max(1, Math.floor(columns));
        const min = new Float32Array(n);
        const max = new Float32Array(n);
        for (let c = 0; c < n; c++) {
            const from = Math.floor((c * this.length) / n);
            const to = Math.max(from + 1, Math.floor(((c + 1) * this.length) / n));
            let lo = Infinity;
            let hi = -Infinity;
            for (let p = from; p < to && p < this.length; p++) {
                if (this.min[p] < lo) lo = this.min[p];
                if (this.max[p] > hi) hi = this.max[p];
            }
            min[c] = lo === Infinity ? 0 : lo;
            max[c] = hi === -Infinity ? 0 : hi;
        }
        return { min, max };
    }
}
