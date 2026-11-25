import { globals } from "../globals";
import { renderTimeline } from "../engine/OfflineRender";
import { Mixer } from "./Mixer";
import { Playlist } from "./Playlist";

// Renders the project (the playlist, played through the mixer) to audio,
// faster than real time. It copies the mixer and the playlist into an offline
// audio context and plays that copy with the same scheduler live playback
// uses, so the result matches what you hear.

export interface RenderProjectOptions {
    /** sample rate of the result (default: the audio device's) */
    sampleRate?: number;
    /** where to start, in beats (default 0) */
    startBeat?: number;
    /** where to stop, in beats (default: where the last clip ends) */
    endBeat?: number;
    /** seconds of silence to add after the end, for reverb and delay tails (default 0) */
    tailSeconds?: number;
    /** see OfflineRender.TimelineRender.mode */
    mode?: "upfront" | "incremental";
}

export async function renderProject(
    mixer: Mixer = globals.mixer,
    playlist: Playlist = globals.playlist,
    options: RenderProjectOptions = {},
): Promise<AudioBuffer> {
    const tempo = globals.engine.transport.tempo;
    const startBeat = options.startBeat ?? 0;

    // the end of the last clip, unless the caller said where to stop
    let endBeat = options.endBeat;
    if (endBeat === undefined) {
        endBeat = startBeat;
        for (const clip of playlist.getClips()) {
            const s = tempo.secondsAt(clip.startBeat) + clip.durationSeconds;
            endBeat = Math.max(endBeat, tempo.beatAt(s));
        }
    }
    const seconds = Math.max(0, tempo.secondsAt(endBeat) - tempo.secondsAt(startBeat)) + (options.tailSeconds ?? 0);
    const sampleRate = options.sampleRate ?? globals.audiocontext.sampleRate;
    const frames = Math.max(1, Math.ceil(seconds * sampleRate));

    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: frames, sampleRate });
    const offlineMixer = await mixer.cloneTo(ctx);
    const offlinePlaylist = playlist.cloneTo(ctx, mixer, offlineMixer);
    return renderTimeline({
        ctx,
        tempo,
        clips: [...offlinePlaylist.getClips()],
        startBeat,
        mode: options.mode,
    });
}
