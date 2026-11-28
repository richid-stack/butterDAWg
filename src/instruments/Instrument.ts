import { globals } from "../globals";
import { stereoGain } from "../engine/nodes";
import { NotePlay, NoteTarget, NoteVoice } from "../engine/NoteHost";
import { SamplerData, SamplerMode, ZoneSettings, emptySampler } from "../beat/data";
import { Envelope, MIN_RELEASE } from "./envelope";
import { isKeySwitch, pickZones, playbackRate, velocityGain } from "./zones";
import type { AssetData } from "../project/schema";

// An instrument of the channel rack: a sampler. It owns its zones (which sample
// plays for which keys and velocities), the envelope and the volume, and turns
// a note into sound: a buffer source at the right speed, shaped by the
// envelope, panned and sent to the mixer channel it is routed to. The same
// code makes the sound live and in the export.

/** one sample of an instrument, with where it came from */
export class Zone {
    settings: ZoneSettings;
    /** where the file is read from; changes when the file is collected into the project folder */
    path: string;
    buffer: AudioBuffer | null = null;
    /** resolves when the file has been read and decoded, or has failed */
    loaded: Promise<void> = Promise.resolve();
    loadError: unknown = null;
    /** like Sample.missingAsset: the record to keep when the place of the file cannot be worked out */
    missingAsset: AssetData | null = null;

    constructor(settings: ZoneSettings, path: string, load = true) {
        this.settings = settings;
        this.path = path;
        if (load) {
            this.loaded = globals.engine.samples
                .load(path)
                .then((decoded) => {
                    this.buffer = decoded.buffer;
                })
                .catch((err) => {
                    this.loadError = err;
                    console.error("could not load " + path, err);
                });
        }
    }

    hasFailed(): boolean {
        return this.loadError !== null;
    }

    cloneFor(): Zone {
        const copy = new Zone({ ...this.settings, loop: this.settings.loop ? { ...this.settings.loop } : null, env: this.settings.env ? { ...this.settings.env } : undefined }, this.path, false);
        copy.buffer = this.buffer;
        copy.loaded = this.loaded;
        copy.loadError = this.loadError;
        copy.missingAsset = this.missingAsset;
        return copy;
    }
}

/** the settings that make an instrument a drum pad or a bass, except its zones */
export type SamplerSettings = Omit<SamplerData, "zones">;

export class Instrument implements NoteTarget {
    id: string;
    name: string;
    color: string;
    sampler: SamplerSettings;
    zones: Zone[] = [];
    /** which key switch is active (an articulation); null before one has been played */
    switchNote: number | null = null;

    private ctx: BaseAudioContext;
    private volume = 1;
    private pan = 0;
    private muted = false;
    private out: GainNode;
    private panner: StereoPannerNode;
    private destination: AudioNode | null = null;
    /** the mixer channel it plays into, by number; the rack keeps the connection up to date */
    channel: number | null = null;

    constructor(ctx: BaseAudioContext, id: string, name: string, color = "#808080", sampler: SamplerSettings = emptySampler()) {
        this.ctx = ctx;
        this.id = id;
        this.name = name;
        this.color = color;
        const { zones, ...settings } = sampler as SamplerData;
        void zones;
        this.sampler = settings;
        this.out = stereoGain(ctx);
        this.panner = new StereoPannerNode(ctx);
        this.out.connect(this.panner);
    }

    get chokeGroup(): number {
        return this.sampler.chokeGroup;
    }

    getVolume() {
        return this.volume;
    }

    getPan() {
        return this.pan;
    }

    isMuted() {
        return this.muted;
    }

    setVolume(v: number, smooth = true) {
        this.volume = v;
        this.applyGain(smooth);
    }

    setPan(p: number) {
        this.pan = Math.max(-1, Math.min(1, p));
        this.panner.pan.value = this.pan;
    }

    setMuted(m: boolean, smooth = true) {
        this.muted = m;
        this.applyGain(smooth);
    }

    /** where the sound goes (a mixer channel's input); null disconnects it */
    connectTo(destination: AudioNode | null) {
        if (this.destination) this.panner.disconnect(this.destination);
        this.destination = destination;
        if (destination) this.panner.connect(destination);
    }

    addZone(zone: Zone, index = this.zones.length) {
        this.zones.splice(index, 0, zone);
    }

    removeZone(zone: Zone) {
        const i = this.zones.indexOf(zone);
        if (i !== -1) this.zones.splice(i, 1);
    }

    /** true while any of its samples is still being read */
    hasUnloaded(): boolean {
        return this.zones.some((z) => !z.buffer && !z.loadError);
    }

    // ---- making sound -------------------------------------------------------------

    play(note: NotePlay): NoteVoice[] {
        const range = this.sampler.keySwitch;
        if (isKeySwitch(note.pitch, range)) {
            // a key switch chooses an articulation and makes no sound
            this.switchNote = note.pitch;
            return [];
        }
        const active = this.switchNote ?? range?.default ?? null;
        const zones = pickZones(this.zones, { pitch: note.pitch, velocity: note.velocity, seq: note.seq, switchNote: active }, (z) => z.settings);
        const voices: NoteVoice[] = [];
        for (const zone of zones) {
            // a sample that has not loaded yet cannot sound; the note is skipped rather than played late
            if (!zone.buffer) continue;
            voices.push(new SamplerVoice(this.ctx, zone, this.sampler.mode, this.sampler, note, this.out));
        }
        return voices;
    }

    /**
     * How long a note is heard, in seconds from its start: a drum plays its whole sample, a held note lasts as
     * long as the note and then its release. The export uses it to know where the sound ends.
     */
    soundSeconds(pitch: number, velocity: number, seq: number, noteSeconds: number): number {
        const range = this.sampler.keySwitch;
        if (isKeySwitch(pitch, range)) return 0;
        const active = this.switchNote ?? range?.default ?? null;
        let longest = 0;
        for (const zone of pickZones(this.zones, { pitch, velocity, seq, switchNote: active }, (z) => z.settings)) {
            if (!zone.buffer) continue;
            if (this.sampler.mode === "gate") {
                longest = Math.max(longest, noteSeconds + Math.max((zone.settings.env ?? this.sampler).release, 0.005));
            } else {
                const rate = Math.max(playbackRate(zone.settings, pitch), 0.05);
                longest = Math.max(longest, zone.buffer.duration / rate);
            }
        }
        return longest;
    }

    private applyGain(smooth: boolean) {
        const target = this.muted ? 0 : this.volume;
        if (smooth && this.ctx instanceof AudioContext) this.out.gain.setTargetAtTime(target, this.ctx.currentTime, 0.01);
        else this.out.gain.value = target;
    }

    dispose() {
        this.out.disconnect();
        this.panner.disconnect();
        this.destination = null;
    }

    /** A copy in another audio context (for the export), sharing the decoded samples. It is not connected to anything yet. */
    cloneTo(ctx: BaseAudioContext): Instrument {
        const copy = new Instrument(ctx, this.id, this.name, this.color, {
            ...this.sampler,
            keySwitch: this.sampler.keySwitch ? { ...this.sampler.keySwitch } : undefined,
        });
        copy.channel = this.channel;
        copy.setVolume(this.volume, false);
        copy.setPan(this.pan);
        copy.setMuted(this.muted, false);
        for (const zone of this.zones) copy.zones.push(zone.cloneFor());
        return copy;
    }
}

/** the sound of one note of a sampler */
class SamplerVoice implements NoteVoice {
    readonly when: number;
    private source: AudioBufferSourceNode;
    private env: GainNode;
    private pan: StereoPannerNode;
    private envelope: Envelope;
    private ended = false;
    private callbacks: Array<() => void> = [];

    constructor(
        ctx: BaseAudioContext,
        zone: Zone,
        mode: SamplerMode,
        sampler: SamplerSettings,
        note: NotePlay,
        destination: AudioNode,
    ) {
        const z = zone.settings;
        const buffer = zone.buffer as AudioBuffer;
        const e = z.env ?? sampler;
        const when = note.when;
        this.when = when;

        // ---- the source, at the speed that gives the pitch
        const rate = playbackRate(z, note.pitch);
        const loop = mode === "gate" && z.loop && z.loop.end > z.loop.start ? z.loop : null;
        this.source = new AudioBufferSourceNode(ctx, {
            buffer,
            playbackRate: rate,
            loop: loop !== null,
            loopStart: loop ? loop.start : 0,
            loopEnd: loop ? loop.end : 0,
        });
        if (note.slideTo !== null && note.slideTo !== note.pitch) {
            // the glide runs from `slideAt` of the way through the note to its end
            const from = when + Math.max(0, Math.min(1, note.slideAt)) * note.duration;
            const to = Math.max(when + note.duration, from + 0.01);
            this.source.playbackRate.setValueAtTime(rate, from);
            this.source.playbackRate.exponentialRampToValueAtTime(playbackRate(z, note.slideTo), to);
        }

        // ---- the envelope: attack, decay to the sustain level, and for held notes a release
        const peak = z.volume * velocityGain(note.velocity, z.veltrack ?? 1);
        this.envelope = new Envelope(when, peak, e);
        this.env = stereoGain(ctx);

        // ---- the panning of this note: the zone's and the note's
        this.pan = new StereoPannerNode(ctx, { pan: Math.max(-1, Math.min(1, z.pan + note.pan)) });
        this.source.connect(this.env);
        this.env.connect(this.pan);
        this.pan.connect(destination);

        this.source.start(when);
        if (mode === "gate") {
            // held for the length of the note, then released
            let off = when + Math.max(note.duration, 0);
            if (note.stopAt !== null) off = Math.min(off, note.stopAt);
            this.envelope.release(off, Math.max(e.release, MIN_RELEASE));
        } else if (note.stopAt !== null) {
            this.envelope.cut(note.stopAt, 0.005);
        }
        this.schedule();
        this.source.onended = () => this.finish();
    }

    /** puts the envelope's straight lines on the gain, and stops the source when they have reached silence */
    private schedule(): void {
        const g = this.env.gain;
        const points = this.envelope.points();
        g.cancelScheduledValues(0);
        g.setValueAtTime(points[0][1], points[0][0]);
        for (let i = 1; i < points.length; i++) g.linearRampToValueAtTime(points[i][1], points[i][0]);
        const end = this.envelope.endsAt;
        if (end !== null) {
            try {
                this.source.stop(end + 0.02);
            } catch {
                // already stopped
            }
        }
    }

    cut(at: number, fade: number): void {
        if (this.ended) return;
        // the level is worked out from the envelope, not asked of the audio engine: this works for a sound that has
        // not started, and gives the same line live and in the export
        this.envelope.cut(at, fade);
        this.schedule();
    }

    cancel(): void {
        try {
            this.source.stop();
        } catch {
            // already stopped
        }
        this.finish();
    }

    onEnded(callback: () => void): void {
        if (this.ended) callback();
        else this.callbacks.push(callback);
    }

    private finish(): void {
        if (this.ended) return;
        this.ended = true;
        this.source.disconnect();
        this.env.disconnect();
        this.pan.disconnect();
        for (const cb of this.callbacks) cb();
        this.callbacks = [];
    }
}
