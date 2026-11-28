import { SchedulableClip, SchedulerHost, StartEvent } from "./Scheduler";
import { PlayableClip, Voices } from "./Voices";

// Notes are played by instruments, not by buffers on a track. The scheduler
// hands a note to this host at the exact time it is due; the host asks the
// instrument to make its sound, and keeps track of what is sounding so that a
// seek can fade it out, a tempo change can drop what has not started, and a
// choke group (a closed hat that ends an open hat) can cut a sound that is
// still ringing.

/** one note, with the times it has to be played at */
export interface NotePlay {
    /** audio-clock time to start at */
    when: number;
    /** seconds the note is held, for instruments that hold (gate) */
    duration: number;
    /** MIDI note number */
    pitch: number;
    /** 0..1 */
    velocity: number;
    /** -1..1 */
    pan: number;
    /** pitch to glide to (a slide note), and how far into the note the glide starts, 0..1 */
    slideTo: number | null;
    slideAt: number;
    /** how many notes this instrument played before this one, counted from the start of the song */
    seq: number;
    /** audio-clock time the loop ends, when the note would last past it */
    stopAt: number | null;
}

/** the sound of one note, as the host sees it */
export interface NoteVoice {
    /** audio-clock time it starts at */
    readonly when: number;
    /** fade out and stop at `at` */
    cut(at: number, fade: number): void;
    /** it has not started yet: remove it */
    cancel(): void;
    /** called when it has ended by itself or been cut, so the host stops keeping track of it */
    onEnded(callback: () => void): void;
}

/** what plays notes: an instrument */
export interface NoteTarget {
    /** instruments with the same non-zero group cut each other off */
    readonly chokeGroup: number;
    play(note: NotePlay): NoteVoice[];
}

/** a note on the timeline, as the scheduler sees it */
export interface NoteClip extends SchedulableClip {
    readonly kind: "note";
    readonly target: NoteTarget;
    readonly pitch: number;
    readonly velocity: number;
    readonly pan: number;
    readonly slideTo: number | null;
    readonly slideAt: number;
    readonly seq: number;
}

export type AnyClip = PlayableClip | NoteClip;

export function isNote(clip: AnyClip): clip is NoteClip {
    return (clip as NoteClip).kind === "note";
}

/** a note that was already under way when playing started in the middle of it is not started late, only joined notes within this are */
const CHASE_LIMIT = 0.02;

interface Playing {
    voice: NoteVoice;
    group: number;
}

export class NoteHost implements SchedulerHost<NoteClip> {
    private active = new Set<Playing>();
    private flushListeners = new Set<() => void>();

    constructor(
        private ctx: BaseAudioContext,
        /** length of the fade at a cut, in seconds */
        private fade = 0.005,
        /** the fade for a choke group, which has to be quick but not a click */
        private chokeFade = 0.012,
    ) {}

    get activeCount(): number {
        return this.active.size;
    }

    start(event: StartEvent<NoteClip>): void {
        // A note is a hit, not a recording: when playing starts in the middle of one, it is not played from the middle.
        if (event.offset > CHASE_LIMIT) return;
        const clip = event.clip;
        const now = this.ctx.currentTime;
        const when = Math.max(event.when, now); // a late timer plays it now, not in the past

        const group = clip.target.chokeGroup;
        if (group > 0) {
            for (const playing of this.active) {
                if (playing.group === group && playing.voice.when <= when) playing.voice.cut(when, this.chokeFade);
            }
        }

        const voices = clip.target.play({
            when,
            duration: Math.max(clip.durationSeconds, 0.001),
            pitch: clip.pitch,
            velocity: clip.velocity,
            pan: clip.pan,
            slideTo: clip.slideTo,
            slideAt: clip.slideAt,
            seq: clip.seq,
            stopAt: event.stopAt,
        });
        for (const voice of voices) {
            const playing: Playing = { voice, group };
            this.active.add(playing);
            voice.onEnded(() => this.active.delete(playing));
        }
    }

    /** Plays a note now (a pad pressed, a key on the piano roll); returns what sounds so a held key can be released. */
    playNow(target: NoteTarget, note: Omit<NotePlay, "when" | "stopAt" | "seq"> & { seq?: number }): NoteVoice[] {
        const when = this.ctx.currentTime + 0.005;
        const group = target.chokeGroup;
        if (group > 0) {
            for (const playing of this.active) if (playing.group === group) playing.voice.cut(when, this.chokeFade);
        }
        const voices = target.play({ seq: 0, ...note, when, stopAt: null });
        for (const voice of voices) {
            const playing: Playing = { voice, group };
            this.active.add(playing);
            voice.onEnded(() => this.active.delete(playing));
        }
        return voices;
    }

    /** be told when the timeline jumped (a seek, stop, or loop change), which is when a key switch is forgotten */
    onFlush(callback: () => void): () => void {
        this.flushListeners.add(callback);
        return () => this.flushListeners.delete(callback);
    }

    flush(): void {
        const now = this.ctx.currentTime;
        for (const playing of [...this.active]) {
            if (playing.voice.when > now) playing.voice.cancel();
            else playing.voice.cut(now, this.fade);
        }
        for (const listener of [...this.flushListeners]) listener();
    }

    flushPending(): void {
        const now = this.ctx.currentTime;
        for (const playing of [...this.active]) {
            if (playing.voice.when > now) {
                playing.voice.cancel();
                this.active.delete(playing);
            }
        }
    }
}

/** Sends each clip to the part that plays it: audio clips to the voices, notes to the note host. */
export class CompositeHost implements SchedulerHost<AnyClip> {
    constructor(
        readonly voices: Voices,
        readonly notes: NoteHost,
    ) {}

    start(event: StartEvent<AnyClip>): void {
        if (isNote(event.clip)) this.notes.start(event as StartEvent<NoteClip>);
        else this.voices.start(event as StartEvent<PlayableClip>);
    }

    flush(): void {
        this.voices.flush();
        this.notes.flush();
    }

    flushPending(): void {
        this.voices.flushPending();
        this.notes.flushPending();
    }
}
