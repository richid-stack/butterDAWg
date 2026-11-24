// Small pure helpers for levels and fader laws.

/** gain (linear, 1 = unity) to decibels; silence is -Infinity */
export function gainToDb(gain: number): number {
    return gain <= 0 ? -Infinity : 20 * Math.log10(gain);
}

export function dbToGain(db: number): number {
    return db === -Infinity ? 0 : Math.pow(10, db / 20);
}

/** where unity gain sits on a fader that runs from 0 (bottom) to 1 (top) */
export const FADER_UNITY = 0.8;
/** what the very top of the fader gives, in dB */
export const FADER_MAX_DB = 6;

/**
 * Fader position (0 bottom .. 1 top) to linear gain. Below unity the gain
 * follows a square law, which spreads quiet levels over a usable length of
 * fader; above unity it rises in decibels up to +6 dB at the top.
 */
export function faderToGain(position: number): number {
    const f = Math.min(1, Math.max(0, position));
    if (f <= FADER_UNITY) {
        const t = f / FADER_UNITY;
        return t * t;
    }
    return dbToGain(((f - FADER_UNITY) / (1 - FADER_UNITY)) * FADER_MAX_DB);
}

/** the inverse of faderToGain */
export function gainToFader(gain: number): number {
    if (gain <= 0) return 0;
    if (gain <= 1) return Math.sqrt(gain) * FADER_UNITY;
    const db = Math.min(FADER_MAX_DB, gainToDb(gain));
    return FADER_UNITY + (db / FADER_MAX_DB) * (1 - FADER_UNITY);
}

/** "-12.0 dB", "0.0 dB" or "-inf dB" */
export function formatDb(gain: number): string {
    const db = gainToDb(gain);
    if (db === -Infinity) return "-inf dB";
    const rounded = Math.round(db * 10) / 10;
    return (Object.is(rounded, -0) ? 0 : rounded).toFixed(1) + " dB";
}

/** highest absolute sample in a block */
export function peakOf(samples: Float32Array): number {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
        const v = Math.abs(samples[i]);
        if (v > peak) peak = v;
    }
    return peak;
}

/** root-mean-square level of a block */
export function rmsOf(samples: Float32Array): number {
    if (samples.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
}
