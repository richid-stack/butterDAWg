import { Peaks } from "./Peaks";

// Reads audio files into AudioBuffers with the browser's own decoder. That
// handles WAV (8, 16, 24 and 32-bit, float), MP3, FLAC and OGG, any channel
// count and any sample rate; the decoder converts to the audio device's rate.
// Decoded files are kept in a cache so dragging the same kick onto the playlist
// fifty times reads and decodes it once.

export interface DecodedAudio {
    buffer: AudioBuffer;
    peaks: Peaks;
}

export type ReadBytes = (path: string) => Promise<ArrayBuffer>;

/** file extensions the app treats as audio */
export const AUDIO_EXTENSIONS = ["wav", "mp3", "flac", "ogg"];

export function isAudioFile(name: string): boolean {
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    return name.includes(".") && AUDIO_EXTENSIONS.includes(ext);
}

export async function decodeAudio(ctx: BaseAudioContext, bytes: ArrayBuffer): Promise<DecodedAudio> {
    // decodeAudioData takes ownership of the bytes it is given
    const buffer = await ctx.decodeAudioData(bytes);
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    return { buffer, peaks: Peaks.fromChannels(channels) };
}

export class SampleCache {
    private entries = new Map<string, Promise<DecodedAudio>>();
    private sizes = new Map<string, number>();

    constructor(
        private ctx: BaseAudioContext,
        private read: ReadBytes,
        /** when the decoded audio held here passes this many bytes, the least recently used files are dropped */
        private maxBytes = 512 * 1024 * 1024,
    ) {}

    load(path: string): Promise<DecodedAudio> {
        const cached = this.entries.get(path);
        if (cached) {
            // mark as recently used
            this.entries.delete(path);
            this.entries.set(path, cached);
            return cached;
        }
        const loading = this.read(path)
            .then((bytes) => decodeAudio(this.ctx, bytes))
            .then((decoded) => {
                this.sizes.set(path, decoded.buffer.length * decoded.buffer.numberOfChannels * 4);
                this.trim(path);
                return decoded;
            })
            .catch((err) => {
                // do not keep failures: the file may be fixed and tried again
                this.entries.delete(path);
                throw err;
            });
        this.entries.set(path, loading);
        return loading;
    }

    private trim(keep: string): void {
        let total = 0;
        for (const size of this.sizes.values()) total += size;
        for (const path of this.entries.keys()) {
            if (total <= this.maxBytes) break;
            if (path === keep) continue;
            total -= this.sizes.get(path) ?? 0;
            this.entries.delete(path);
            this.sizes.delete(path);
        }
    }
}
