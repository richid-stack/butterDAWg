// Converts between beats (the project's time unit) and seconds (what the audio
// clock counts). A tempo map is a list of tempo points; the tempo holds until
// the next point (a step change, not a ramp). A project that never changes
// tempo has one point at beat 0.
//
// Everything here is plain maths with no Web Audio or DOM types, so it also runs
// in a worker, in the browser build and in unit tests.

export interface TempoPoint {
    /** where the tempo takes effect, in beats from the start of the project */
    beat: number;
    /** quarter-note beats per minute */
    bpm: number;
}

export const MIN_BPM = 1;
export const MAX_BPM = 999;

export class TempoMap {
    private points: TempoPoint[] = [];
    // seconds from beat 0 to each point; always as long as `points`
    private startSeconds: number[] = [];

    constructor(bpm = 120) {
        this.setPoints([{ beat: 0, bpm }]);
    }

    /** the tempo at the start of the project */
    get bpm(): number {
        return this.points[0].bpm;
    }

    getPoints(): readonly TempoPoint[] {
        return this.points;
    }

    /** one constant tempo for the whole project */
    setBpm(bpm: number): void {
        this.setPoints([{ beat: 0, bpm }]);
    }

    /**
     * Replaces the whole map. Points are sorted by beat; the first one is moved
     * to beat 0 so every beat has a tempo.
     */
    setPoints(points: readonly TempoPoint[]): void {
        if (points.length === 0) {
            throw new Error("a tempo map needs at least one point");
        }
        const sorted = points
            .map((p) => ({ beat: p.beat, bpm: clampBpm(p.bpm) }))
            .sort((a, b) => a.beat - b.beat);
        sorted[0].beat = 0;
        // two points at the same beat: the later one wins
        this.points = sorted.filter((p, i) => i === sorted.length - 1 || sorted[i + 1].beat !== p.beat);
        this.startSeconds = [0];
        for (let i = 1; i < this.points.length; i++) {
            const prev = this.points[i - 1];
            this.startSeconds.push(
                this.startSeconds[i - 1] + ((this.points[i].beat - prev.beat) * 60) / prev.bpm,
            );
        }
    }

    bpmAt(beat: number): number {
        return this.points[this.indexForBeat(beat)].bpm;
    }

    /** seconds from beat 0 to `beat` (negative beats extend the first tempo backwards) */
    secondsAt(beat: number): number {
        const i = this.indexForBeat(beat);
        const p = this.points[i];
        return this.startSeconds[i] + ((beat - p.beat) * 60) / p.bpm;
    }

    /** the beat that is `seconds` after beat 0 */
    beatAt(seconds: number): number {
        const i = this.indexForSeconds(seconds);
        const p = this.points[i];
        return p.beat + ((seconds - this.startSeconds[i]) * p.bpm) / 60;
    }

    /** how long it takes to play from beat `a` to beat `b` */
    secondsBetween(a: number, b: number): number {
        return this.secondsAt(b) - this.secondsAt(a);
    }

    /** the beat reached `seconds` after starting from `beat` */
    advance(beat: number, seconds: number): number {
        return this.beatAt(this.secondsAt(beat) + seconds);
    }

    copy(): TempoMap {
        const t = new TempoMap();
        t.setPoints(this.points);
        return t;
    }

    private indexForBeat(beat: number): number {
        let lo = 0;
        let hi = this.points.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.points[mid].beat <= beat) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    private indexForSeconds(seconds: number): number {
        let lo = 0;
        let hi = this.startSeconds.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.startSeconds[mid] <= seconds) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }
}

function clampBpm(bpm: number): number {
    if (!Number.isFinite(bpm)) return 120;
    return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
}
