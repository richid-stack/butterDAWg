import { TempoMap } from "./TempoMap";

// The transport owns "where are we in the song". Position is counted in beats;
// the audio clock (seconds) is only used to know how far playback has moved.
//
// While playing, the position is not stepped by a timer. It is worked out from
// one anchor: "at clock time T the position was beat B". Anything that needs
// the position (the playhead, the scheduler) asks for it at a clock time, so
// timers that fire late cannot make the music drift.

export type TransportState = "stopped" | "playing" | "paused";

/** the audio clock; for a Web Audio context this is `ctx.currentTime` */
export interface Clock {
    now(): number;
}

export interface LoopRegion {
    startBeat: number;
    endBeat: number;
}

export type TransportEvent = "state" | "timeline";

export class Transport {
    readonly tempo: TempoMap;

    private clock: Clock;
    private _state: TransportState = "stopped";
    private anchorBeat = 0;
    private anchorTime = 0;
    private restBeat = 0; // where playback starts from, and where it rests when not playing
    private returnBeat = 0; // where stop() puts the position back to
    private loop: LoopRegion | null = null;
    private _version = 0;
    private listeners: Record<TransportEvent, Set<() => void>> = {
        state: new Set(),
        timeline: new Set(),
    };

    constructor(clock: Clock, tempo = new TempoMap()) {
        this.clock = clock;
        this.tempo = tempo;
    }

    get state(): TransportState {
        return this._state;
    }

    get isPlaying(): boolean {
        return this._state === "playing";
    }

    /**
     * Goes up every time the timeline jumps or changes speed (play, pause, seek,
     * tempo change, loop change). The scheduler restarts its look-ahead when it
     * sees a new number.
     */
    get version(): number {
        return this._version;
    }

    /** the position now, in beats */
    get position(): number {
        return this.positionAt(this.clock.now());
    }

    /**
     * The position at a clock time, in beats. While playing, a loop region
     * brings the position back to its start every time it passes its end.
     */
    positionAt(time: number): number {
        if (this._state !== "playing") return this.restBeat;
        const elapsed = Math.max(0, time - this.anchorTime);
        const loop = this.loopAfter(this.anchorBeat);
        if (!loop) return this.tempo.advance(this.anchorBeat, elapsed);

        const firstPass = this.tempo.secondsBetween(this.anchorBeat, loop.endBeat);
        if (elapsed < firstPass) return this.tempo.advance(this.anchorBeat, elapsed);
        const period = this.tempo.secondsBetween(loop.startBeat, loop.endBeat);
        return this.tempo.advance(loop.startBeat, (elapsed - firstPass) % period);
    }

    /** the anchor the scheduler walks forward from: at `time` the position was `beat` */
    get anchor(): { beat: number; time: number } {
        return { beat: this.anchorBeat, time: this.anchorTime };
    }

    getLoop(): LoopRegion | null {
        return this.loop ? { ...this.loop } : null;
    }

    /** Starts playing from the current position, `delay` seconds from now. */
    play(delay = 0): void {
        if (this._state === "playing") return;
        if (this._state === "stopped") this.returnBeat = this.restBeat;
        this.anchorBeat = this.restBeat;
        this.anchorTime = this.clock.now() + delay;
        this._state = "playing";
        this.changed(true);
    }

    /** Stops playing and keeps the position. */
    pause(): void {
        if (this._state !== "playing") return;
        this.restBeat = this.position;
        this._state = "paused";
        this.changed(true);
    }

    /** Stops playing and goes back to where playing last started from. */
    stop(): void {
        this._state = "stopped";
        this.restBeat = this.returnBeat;
        this.changed(true);
    }

    /** Moves to a beat; keeps playing if it was playing. */
    seek(beat: number): void {
        const target = Math.max(0, beat);
        this.restBeat = target;
        this.returnBeat = target;
        if (this._state === "playing") {
            this.anchorBeat = target;
            this.anchorTime = this.clock.now();
        }
        this.changed(false);
    }

    /** Sets (or with `null` clears) the loop region, in beats. */
    setLoop(region: LoopRegion | null): void {
        if (region && !(region.endBeat > region.startBeat)) {
            throw new Error("a loop region must end after it starts");
        }
        this.reanchor();
        this.loop = region ? { startBeat: region.startBeat, endBeat: region.endBeat } : null;
        this.changed(false);
    }

    /** A constant tempo from now on, without moving the music that is playing. */
    setBpm(bpm: number): void {
        this.reanchor();
        this.tempo.setBpm(bpm);
        this.changed(false);
    }

    /** Replaces the tempo map without moving the music that is playing. */
    setTempoPoints(points: Parameters<TempoMap["setPoints"]>[0]): void {
        this.reanchor();
        this.tempo.setPoints(points);
        this.changed(false);
    }

    on(event: TransportEvent, callback: () => void): () => void {
        this.listeners[event].add(callback);
        return () => this.listeners[event].delete(callback);
    }

    // The anchor is only valid for the tempo map and loop it was made with, so
    // before either changes, anchor again at the current position.
    private reanchor(): void {
        if (this._state !== "playing") return;
        const now = this.clock.now();
        this.anchorBeat = this.positionAt(now);
        this.anchorTime = now;
    }

    // the loop only applies if playback starts before its end
    private loopAfter(beat: number): LoopRegion | null {
        return this.loop && beat < this.loop.endBeat ? this.loop : null;
    }

    private changed(stateChanged: boolean): void {
        this._version++;
        if (stateChanged) this.listeners.state.forEach((cb) => cb());
        this.listeners.timeline.forEach((cb) => cb());
    }
}
