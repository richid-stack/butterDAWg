// The loudness of one note over time: attack, decay to the sustain level, and a release when the note ends. It is a
// chain of straight lines, worked out here as plain numbers so that the level at any moment is known without asking
// the audio engine (a note that is cut short has to fade from where it is, and the engine cannot say where that is
// for a sound that has not started yet). No audio types: the unit tests run it in Node.

export interface EnvelopeTimes {
    /** seconds; never an instant jump (that would click), so the smallest is a millisecond */
    attack: number;
    decay: number;
    /** 0..1, of the peak */
    sustain: number;
}

export const MIN_ATTACK = 0.001;
export const MIN_RELEASE = 0.005;

export class Envelope {
    readonly attack: number;
    /** time the note starts, on the audio clock */
    readonly start: number;
    private peak: number;
    private decay: number;
    private sustain: number;
    private off: { at: number; release: number; level: number } | null = null;
    private cutAt: { at: number; fade: number; level: number } | null = null;

    constructor(start: number, peak: number, times: EnvelopeTimes) {
        this.start = start;
        this.peak = peak;
        this.attack = Math.max(times.attack, MIN_ATTACK);
        this.decay = Math.max(times.decay, 0);
        this.sustain = Math.max(0, Math.min(1, times.sustain));
    }

    /** the level while the key is held (the note has not ended), at time t */
    heldLevel(t: number): number {
        if (t <= this.start) return 0;
        const a = this.start + this.attack;
        // with no decay time the attack goes straight to the sustain level
        const top = this.decay > 0 ? this.peak : this.peak * this.sustain;
        if (t < a) return (top * (t - this.start)) / this.attack;
        if (this.decay > 0 && this.sustain < 1) {
            const k = Math.min(1, (t - a) / this.decay);
            return this.peak * (1 - (1 - this.sustain) * k);
        }
        return top;
    }

    /** the note ends at `at` and fades out over `release` seconds */
    release(at: number, release: number): void {
        const when = Math.max(at, this.start + this.attack);
        this.off = { at: when, release: Math.max(release, MIN_RELEASE), level: this.heldLevel(when) };
    }

    /** the note is cut at `at` and fades out over `fade` seconds, from the level it has then */
    cut(at: number, fade: number): void {
        if (this.cutAt && this.cutAt.at <= at) return;
        this.cutAt = { at, fade: Math.max(fade, 0.001), level: this.level(at) };
    }

    /** the level at time t, with the release and any cut */
    level(t: number): number {
        let level = this.heldLevel(t);
        if (this.off && t >= this.off.at) level = this.off.level * Math.max(0, 1 - (t - this.off.at) / this.off.release);
        if (this.cutAt && t >= this.cutAt.at) level = this.cutAt.level * Math.max(0, 1 - (t - this.cutAt.at) / this.cutAt.fade);
        return level;
    }

    /** when the sound has faded to nothing, or null while it has no end */
    get endsAt(): number | null {
        let end: number | null = this.off ? this.off.at + this.off.release : null;
        if (this.cutAt) end = end === null ? this.cutAt.at + this.cutAt.fade : Math.min(end, this.cutAt.at + this.cutAt.fade);
        return end;
    }

    /**
     * The corners of the line, in time order: where the level changes direction. The first is the start; the last is
     * the end of the release if there is one. Between two corners the level is a straight line.
     */
    points(): Array<[number, number]> {
        const end = this.cutAt ? this.cutAt.at : this.off ? this.off.at : Infinity;
        const a = this.start + this.attack;
        const raw: Array<[number, number]> = [[this.start, 0]];
        raw.push([a, this.decay > 0 ? this.peak : this.peak * this.sustain]);
        if (this.decay > 0 && this.sustain < 1) raw.push([a + this.decay, this.peak * this.sustain]);
        const out: Array<[number, number]> = [];
        for (const p of raw) {
            if (p[0] < end) out.push(p);
        }
        if (end !== Infinity) out.push([end, this.level(end)]);
        if (this.cutAt) out.push([this.cutAt.at + this.cutAt.fade, 0]);
        else if (this.off) out.push([this.off.at + this.off.release, 0]);
        return out;
    }
}
