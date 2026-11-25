import { ReadBytes, SampleCache } from "./AudioLoader";
import { ClipProvider, Scheduler } from "./Scheduler";
import { TempoMap } from "./TempoMap";
import { Transport } from "./Transport";
import { PlayableClip, Voices } from "./Voices";

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
    readonly scheduler: Scheduler<PlayableClip>;

    /** seconds between pressing play and the first sound, so a clip on beat 0 starts on time */
    startDelay = 0.06;

    private provider: ClipProvider<PlayableClip> = { getClips: () => [] };

    constructor(options: EngineOptions) {
        // let the audio device choose its own sample rate; files are converted to it
        this.ctx = new AudioContext({ latencyHint: "interactive" });
        const clock = { now: () => this.ctx.currentTime };
        this.transport = new Transport(clock, new TempoMap(options.bpm ?? 120));
        this.samples = new SampleCache(this.ctx, options.readBytes);
        this.voices = new Voices(this.ctx);
        this.scheduler = new Scheduler<PlayableClip>(this.transport, clock, { getClips: () => this.provider.getClips() }, this.voices);
        this.scheduler.start();
    }

    /** where the clips come from (the playlist) */
    setProvider(provider: ClipProvider<PlayableClip>): void {
        this.provider = provider;
    }

    async play(): Promise<void> {
        if (this.ctx.state !== "running") await this.ctx.resume();
        this.transport.play(this.startDelay);
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
