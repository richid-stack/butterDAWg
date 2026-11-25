import { Clock, Transport } from "./Transport";

// The scheduler turns "clip X starts at beat 17" into "start the buffer at
// audio-clock time 8.4312". It runs on a timer, but it never plays anything at
// the moment the timer fires. Each tick it looks a little way ahead of the audio
// clock (the look-ahead) and hands every clip that starts inside that window to
// the voices with an exact start time. A late or jittery timer therefore moves
// nothing, as long as it fires again before the look-ahead runs out.
//
// This file is plain logic with no Web Audio types; the voices that actually
// make sound are in Voices.ts.

/** what the scheduler needs to know about a clip */
export interface SchedulableClip {
    /** where the clip starts, in beats */
    readonly startBeat: number;
    /** how long the clip plays, in seconds (audio clips have a fixed length) */
    readonly durationSeconds: number;
}

export interface ClipProvider<C extends SchedulableClip = SchedulableClip> {
    getClips(): Iterable<C>;
}

/** one clip to play, with exact times on the audio clock */
export interface StartEvent<C extends SchedulableClip = SchedulableClip> {
    clip: C;
    /** audio-clock time to start at */
    when: number;
    /** seconds into the clip to start from (not zero when playing starts in the middle of a clip) */
    offset: number;
    /** audio-clock time to stop at because the loop ends first, or null to play to the end */
    stopAt: number | null;
}

export interface SchedulerOptions {
    /** how far ahead of the clock to schedule, in seconds */
    lookahead?: number;
    /** how often the timer fires, in milliseconds */
    intervalMs?: number;
}

export interface SchedulerHost<C extends SchedulableClip = SchedulableClip> {
    /** play this clip */
    start(event: StartEvent<C>): void;
    /** the timeline jumped: drop everything that is scheduled but not yet audible, and fade out what is playing */
    flush(): void;
    /** the tempo changed: drop what is scheduled but not yet audible, and let what is playing carry on */
    flushPending(): void;
}

export class Scheduler<C extends SchedulableClip = SchedulableClip> {
    readonly lookahead: number;
    readonly intervalMs: number;

    private transport: Transport;
    private clock: Clock;
    private provider: ClipProvider<C>;
    private host: SchedulerHost<C>;
    private timer: ReturnType<typeof setInterval> | null = null;

    // the part of the timeline already handed out: everything before
    // (cursorBeat at cursorTime) has been scheduled
    private seenVersion = -1;
    private seenJumpVersion = -1;
    private cursorBeat = 0;
    private cursorTime = 0;
    // true right after playing starts, a seek or a loop wrap, when clips that
    // are already under way have to be started part-way in
    private jumped = true;

    constructor(
        transport: Transport,
        clock: Clock,
        provider: ClipProvider<C>,
        host: SchedulerHost<C>,
        options: SchedulerOptions = {},
    ) {
        this.transport = transport;
        this.clock = clock;
        this.provider = provider;
        this.host = host;
        this.lookahead = options.lookahead ?? 0.15;
        this.intervalMs = options.intervalMs ?? 25;
    }

    /** Runs tick() on a timer. */
    start(): void {
        if (this.timer !== null) return;
        this.timer = setInterval(() => this.tick(), this.intervalMs);
    }

    stop(): void {
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
    }

    /**
     * Schedules everything that starts between the end of the previous tick and
     * `now + lookahead`. Safe to call as often or as late as you like.
     */
    tick(): void {
        if (this.transport.version !== this.seenVersion) {
            const jumpedTimeline = this.transport.jumpVersion !== this.seenJumpVersion;
            this.seenVersion = this.transport.version;
            this.seenJumpVersion = this.transport.jumpVersion;
            // A seek, play, stop or loop change drops all sound and starts over. A
            // tempo change only moves what has not started yet: a clip that is
            // already sounding is audio of fixed length, so it plays on, and
            // restarting it would need to know how long it had really played
            // (the tempo map no longer says).
            if (jumpedTimeline) this.host.flush();
            else this.host.flushPending();
            if (!this.transport.isPlaying) return;
            const anchor = this.transport.anchor;
            this.cursorBeat = anchor.beat;
            this.cursorTime = anchor.time;
            this.jumped = jumpedTimeline;
        }
        if (!this.transport.isPlaying) return;

        const tempo = this.transport.tempo;
        const horizon = this.clock.now() + this.lookahead;

        // Several passes only happen when the loop wraps inside the window.
        // The pass limit stops a broken loop region from spinning forever.
        for (let pass = 0; this.cursorTime < horizon && pass < 1000; pass++) {
            const loop = this.transport.getLoop();
            let segEndTime = horizon;
            let segEndBeat = tempo.advance(this.cursorBeat, horizon - this.cursorTime);
            let wraps = false;
            if (loop && this.cursorBeat < loop.endBeat && segEndBeat >= loop.endBeat) {
                segEndBeat = loop.endBeat;
                segEndTime = this.cursorTime + tempo.secondsBetween(this.cursorBeat, loop.endBeat);
                wraps = true;
            }

            // a clip that would play past the end of the loop is cut off there
            const loopEndTime =
                loop && this.cursorBeat < loop.endBeat
                    ? this.cursorTime + tempo.secondsBetween(this.cursorBeat, loop.endBeat)
                    : null;

            for (const clip of this.provider.getClips()) {
                const start = clip.startBeat;
                let when: number;
                let offset: number;
                if (start >= this.cursorBeat && start < segEndBeat) {
                    when = this.cursorTime + tempo.secondsBetween(this.cursorBeat, start);
                    offset = 0;
                } else if (this.jumped && start < this.cursorBeat) {
                    // already under way at the jump: start part-way in, if any of it is left
                    offset = tempo.secondsBetween(start, this.cursorBeat);
                    if (offset >= clip.durationSeconds) continue;
                    when = this.cursorTime;
                } else {
                    continue;
                }
                const endsAt = when + (clip.durationSeconds - offset);
                this.host.start({
                    clip,
                    when,
                    offset,
                    stopAt: loopEndTime !== null && endsAt > loopEndTime ? loopEndTime : null,
                });
            }

            this.jumped = false;
            this.cursorBeat = segEndBeat;
            this.cursorTime = segEndTime;
            if (wraps && loop) {
                this.cursorBeat = loop.startBeat;
                this.jumped = true;
            }
        }
    }
}
