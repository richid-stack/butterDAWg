import { globals } from "../globals";
import { PlayableClip } from "../engine/Voices";
import { Peaks } from "../engine/Peaks";
import { Track } from "./Track";
import type { AssetData } from "../project/schema";

// An audio clip on the playlist: one placement of an audio file. Its position
// is in beats, so changing the tempo moves the music but not the clips. Its
// length is in seconds, because that is how long the file is.

export interface SampleSource {
    /** where to read the file from */
    path: string;
    /** the name to show */
    title: string;
}

export class Sample implements PlayableClip {
    /** where the file is read from; it changes when the file is collected into the project folder */
    path: string;
    private name: string;
    private start = 0; // beats
    private audio: AudioBuffer | null = null;
    private waveform: Peaks | null = null;
    private loadError: unknown = null;
    private listeners = new Set<() => void>();

    /** the track this clip is on; set by Track.addSample */
    track: Track | null = null;
    /**
     * Set when the project says where the file is but the place cannot be worked out (a project folder that is
     * gone). The clip stays, and is saved again with this record, so the arrangement is not lost.
     */
    missingAsset: AssetData | null = null;
    /** resolves when the file has been read and decoded */
    readonly loaded: Promise<void>;

    constructor(source: SampleSource) {
        this.path = source.path;
        this.name = source.title;
        this.loaded = globals.engine.samples
            .load(this.path)
            .then((decoded) => {
                this.audio = decoded.buffer;
                this.waveform = decoded.peaks;
            })
            .catch((err) => {
                this.loadError = err;
                console.error("could not load " + this.path, err);
            })
            .then(() => this.listeners.forEach((cb) => cb()));
    }

    get startBeat(): number {
        return this.start;
    }

    setStartBeat(beat: number) {
        this.start = beat;
    }

    getStartBeat() {
        return this.start;
    }

    get buffer(): AudioBuffer | null {
        return this.audio;
    }

    get durationSeconds(): number {
        return this.audio ? this.audio.duration : 0;
    }

    get destination(): AudioNode {
        if (!this.track) throw new Error("clip is not on a track");
        return this.track.getAudioNode();
    }

    isLoaded() {
        return this.audio !== null;
    }

    hasFailed() {
        return this.loadError !== null;
    }

    getPeaks(): Peaks | null {
        return this.waveform;
    }

    /** how many beats the clip lasts at the current tempo, counted from where it starts */
    getDurationBeats(): number {
        const tempo = globals.engine.transport.tempo;
        const end = tempo.beatAt(tempo.secondsAt(this.start) + this.durationSeconds);
        return end - this.start;
    }

    getName() {
        return this.name;
    }

    setName(name: string) {
        this.name = name;
    }

    /** called once the file has loaded (or failed to) */
    onLoaded(callback: () => void): () => void {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    /** a copy on another track that shares the decoded audio */
    cloneFor(track: Track): Sample {
        const copy = Object.create(Sample.prototype) as Sample;
        Object.assign(copy, {
            path: this.path,
            name: this.name,
            start: this.start,
            audio: this.audio,
            waveform: this.waveform,
            loadError: this.loadError,
            listeners: new Set(),
            track: null,
            missingAsset: this.missingAsset,
            loaded: this.loaded,
        });
        track.addSample(copy);
        return copy;
    }
}
