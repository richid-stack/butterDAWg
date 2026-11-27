import { globals } from "../globals";
import { ClipProvider } from "../engine/Scheduler";
import { PlayableClip } from "../engine/Voices";
import { Mixer } from "./Mixer";
import { Track } from "./Track";

export class Playlist implements ClipProvider<PlayableClip> {
    readonly ctx: BaseAudioContext;
    private tracks: Array<Track>;
    private listeners = new Set<() => void>();

    constructor(ctx: BaseAudioContext = globals.audiocontext) {
        this.ctx = ctx;
        this.tracks = [];
    }

    getTrackCount() {
        return this.tracks.length;
    }

    getTracks() {
        return this.tracks;
    }

    newTrack() {
        let track = new Track(this.ctx);
        this.tracks.push(track);
        return track;
    }

    /** every clip on every track; this is what the scheduler plays */
    *getClips(): Iterable<PlayableClip> {
        for (const track of this.tracks) {
            for (const sample of track.getSamples()) yield sample;
        }
    }

    /** Takes every track out of the audio graph (a project was closed). */
    dispose() {
        this.tracks.forEach((t) => t.dispose());
        this.listeners.clear();
    }

    getIndexOfTrack(track: Track) {
        return this.tracks.indexOf(track);
    }

    /** be told when something about the playlist changed that the view should redraw (e.g. a file finished loading) */
    onChange(callback: () => void): () => void {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    notifyChanged() {
        this.listeners.forEach((cb) => cb());
    }

    /**
     * A copy in another audio context (for offline rendering). `from` is the
     * mixer the tracks are routed into now and `into` its copy.
     */
    cloneTo(ctx: BaseAudioContext, from: Mixer, into: Mixer): Playlist {
        const copy = new Playlist(ctx);
        const route = (target: unknown) => {
            if (target === from.getMaster()) return into.getMaster();
            const i = from.getChannels().indexOf(target as never);
            return i === -1 ? null : into.getChannels()[i];
        };
        for (const track of this.tracks) copy.tracks.push(track.cloneTo(ctx, route));
        return copy;
    }
}
