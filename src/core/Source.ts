import { globals } from "../globals";

/*
    A decoded audio file for the code that works on whole files (the audio
    graph window). Use `await Source.load(path)`; files are decoded by the
    engine's sample cache, at the audio device's rate, with all their channels.
*/

export class Source {
    private path: string;
    private filename: string;
    private audio_buffer: AudioBuffer;

    private constructor(path: string, buffer: AudioBuffer) {
        this.path = path;
        this.filename = path.substring(path.lastIndexOf("/") + 1);
        this.audio_buffer = buffer;
    }

    static async load(path: string): Promise<Source> {
        const decoded = await globals.engine.samples.load(path);
        return new Source(path, decoded.buffer);
    }

    getName() {
        return this.filename.substring(0, this.filename.lastIndexOf("."));
    }

    getChannels() {
        return this.audio_buffer.numberOfChannels;
    }

    getChannel(index: number) {
        return this.audio_buffer.getChannelData(index);
    }

    getAudioBuffer() {
        return this.audio_buffer;
    }

    /** length in seconds */
    getLength() {
        return this.audio_buffer.duration;
    }
}
