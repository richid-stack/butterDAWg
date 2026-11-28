import { ReadBytes, SampleCache } from "./AudioLoader";
import { ClipProvider, Scheduler } from "./Scheduler";
import { TempoMap } from "./TempoMap";
import { Transport } from "./Transport";
import { AnyClip, CompositeHost, NoteHost } from "./NoteHost";
import { Voices } from "./Voices";

// The live audio engine: one audio context, the transport that says where we
// are in the song, the scheduler that starts clips on time, and the cache of
// decoded samples. The rest of the app asks the engine to play, pause or seek
// and reads the position from it; nothing else keeps time.

export interface EngineOptions {
    /** starting tempo */
    bpm?: number;
    /** how the engine reads sample files */
    readBytes: ReadBytes;
}

export class Engine {
    readonly ctx: AudioContext;
    readonly transport: Transport;
    readonly samples: SampleCache;
    readonly voices: Voices;
    /** plays notes (the instruments of the channel rack) */
    readonly notes: NoteHost;
    readonly scheduler: Scheduler<AnyClip>;

    /** seconds between pressing play and the first sound, so a clip on beat 0 starts on time */
    startDelay = 0.06;

    private provider: ClipProvider<AnyClip> = { getClips: () => [] };

    constructor(options: EngineOptions) {
        // let the audio device choose its own sample rate; files are converted to it
        this.ctx = new AudioContext({ latencyHint: "interactive" });
        const clock = { now: () => this.ctx.currentTime };
        this.transport = new Transport(clock, new TempoMap(options.bpm ?? 120));
        this.samples = new SampleCache(this.ctx, options.readBytes);
        this.voices = new Voices(this.ctx);
        this.notes = new NoteHost(this.ctx);
        this.scheduler = new Scheduler<AnyClip>(this.transport, clock, { getClips: () => this.provider.getClips() }, new CompositeHost(this.voices, this.notes));
        this.scheduler.start();
    }

    /** where the clips and notes come from (the arrangement: the playlist's audio and the patterns' notes) */
    setProvider(provider: ClipProvider<AnyClip>): void {
        this.provider = provider;
    }

    async play(): Promise<void> {
        if (this.ctx.state !== "running") await this.ctx.resume();
        // Start on a boundary of the audio engine's 128-frame blocks. Pitch automation (a slide, a glide) is sampled
        // once per block, so a sound that starts on the same grid as the export comes out sample for sample the same.
        const rate = this.ctx.sampleRate;
        const block = 128;
        const frame = Math.ceil(((this.ctx.currentTime + this.startDelay) * rate) / block - 1e-9) * block;
        this.transport.playAt(frame / rate);
    }

    pause(): void {
        this.transport.pause();
    }

    /** back to where playing started */
    stop(): void {
        this.transport.stop();
    }

    async toggle(): Promise<void> {
        if (this.transport.isPlaying) this.pause();
        else await this.play();
    }

    seek(beat: number): void {
        this.transport.seek(beat);
    }

    setBpm(bpm: number): void {
        this.transport.setBpm(bpm);
    }

    /**
     * The position to show on screen, in beats. It is the position of the sound
     * that is coming out of the speakers now, which is a little behind the
     * position that is being scheduled.
     */
    displayPosition(): number {
        const heard = this.ctx.getOutputTimestamp().contextTime;
        const now = this.ctx.currentTime;
        const t = heard > 0 && heard <= now ? heard : now - (this.ctx.baseLatency || 0);
        return this.transport.positionAt(t);
    }
}
