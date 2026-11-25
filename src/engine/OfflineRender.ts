import { Scheduler } from "./Scheduler";
import { TempoMap } from "./TempoMap";
import { Transport } from "./Transport";
import { PlayableClip, Voices } from "./Voices";

// Renders a timeline faster than real time with an OfflineAudioContext. It
// uses the same transport, scheduler and voices as live playback, so what you
// export is what you heard.

export interface TimelineRender {
    /** the offline context; the graph the clips play into must already be built in it */
    ctx: OfflineAudioContext;
    tempo: TempoMap;
    clips: PlayableClip[];
    /** beat to start from (default 0) */
    startBeat?: number;
    /**
     * "upfront" hands every clip to the audio engine at once, which is fastest.
     * "incremental" feeds clips a little at a time as the render advances, the
     * same way live playback does; it exists so tests can prove both give the
     * same audio.
     */
    mode?: "upfront" | "incremental";
    /** for "incremental": seconds between scheduler ticks (default 0.05) */
    tickSeconds?: number;
    /** for "incremental": scheduler look-ahead in seconds (default 0.15) */
    lookahead?: number;
}

export async function renderTimeline(job: TimelineRender): Promise<AudioBuffer> {
    const { ctx, tempo, clips } = job;
    const clock = { now: () => ctx.currentTime };
    const transport = new Transport(clock, tempo);
    transport.seek(job.startBeat ?? 0);
    transport.play(0);

    const lengthSeconds = ctx.length / ctx.sampleRate;
    const incremental = job.mode === "incremental";
    const scheduler = new Scheduler<PlayableClip>(
        transport,
        clock,
        { getClips: () => clips },
        new Voices(ctx),
        { lookahead: incremental ? (job.lookahead ?? 0.15) : lengthSeconds + 1 },
    );

    scheduler.tick(); // everything that starts at time 0 (and, "upfront", everything)
    if (incremental) {
        // suspend times must be multiples of the render quantum and all different
        const quantum = 128 / ctx.sampleRate;
        const stepQuanta = Math.max(1, Math.round((job.tickSeconds ?? 0.05) / quantum));
        for (let q = stepQuanta; q * quantum < lengthSeconds; q += stepQuanta) {
            ctx.suspend(q * quantum).then(() => {
                scheduler.tick();
                ctx.resume();
            });
        }
    }
    return ctx.startRendering();
}

/** the audio of a rendered buffer as plain arrays, one per channel */
export function channelsOf(buffer: AudioBuffer): Float32Array[] {
    const out: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
    return out;
}
