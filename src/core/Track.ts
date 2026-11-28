import { Color } from "../ui/misc/Color";
import { Connectable, globals } from "../globals";
import { Sample } from "./Sample";
import { stereoGain } from "../engine/nodes";
import type { PatternClipData } from "../beat/data";

// A playlist track holds clips. All its clips play into one node, which goes to
// one mixer channel. The track does not play anything itself; the scheduler
// starts its clips (see engine/Scheduler.ts).

export class Track implements Connectable {
    readonly ctx: BaseAudioContext;
    private audionode: GainNode;
    private samples: Array<Sample>;
    private patterns: PatternClipData[] = [];
    private enabled: boolean;
    private target: Connectable | null = null;

    // ui stuff
    public title: string;
    public color: Color;

    constructor(ctx: BaseAudioContext = globals.audiocontext) {
        this.ctx = ctx;
        this.enabled = true;
        this.samples = [];

        this.title = "";
        this.color = new Color("#646e73");

        this.audionode = stereoGain(ctx);
    }

    isActive() {
        return this.enabled;
    }

    /** a disabled track is muted; its clips keep their place and time */
    setActive(active: boolean) {
        this.enabled = active;
        if (this.ctx instanceof AudioContext) {
            this.audionode.gain.setTargetAtTime(active ? 1 : 0, this.ctx.currentTime, 0.005);
        } else {
            this.audionode.gain.value = active ? 1 : 0;
        }
    }

    getSamples() {
        return this.samples;
    }

    removeSample(sample: Sample) {
        const i = this.samples.indexOf(sample);
        if (i !== -1) this.samples.splice(i, 1);
        if (sample.track === this) sample.track = null;
    }

    /** Puts a clip on the track: at the end, or at `index` (to put a clip back where it was). */
    addSample(sample: Sample, index?: number) {
        sample.track = this;
        if (index === undefined || index < 0 || index >= this.samples.length) this.samples.push(sample);
        else this.samples.splice(index, 0, sample);
    }

    /** the pattern clips on this track (their notes play through the instruments, not through the track) */
    getPatternClips(): PatternClipData[] {
        return this.patterns;
    }

    addPatternClip(clip: PatternClipData, index?: number) {
        if (index === undefined || index < 0 || index >= this.patterns.length) this.patterns.push(clip);
        else this.patterns.splice(index, 0, clip);
    }

    removePatternClip(clip: PatternClipData) {
        const i = this.patterns.indexOf(clip);
        if (i !== -1) this.patterns.splice(i, 1);
    }

    /** Sends this track's sound to one place; an earlier connection is dropped. */
    connect(object: Connectable) {
        this.audionode.disconnect();
        this.audionode.connect(object.getAudioNode());
        this.target = object;
    }

    /** Sends this track's sound nowhere (the track is silent until it is connected again). */
    disconnect() {
        this.audionode.disconnect();
        this.target = null;
    }

    getTarget(): Connectable | null {
        return this.target;
    }

    getAudioNode(): AudioNode {
        return this.audionode;
    }

    /** Takes the track out of the audio graph (a project was closed). */
    dispose() {
        this.disconnect();
    }

    /**
     * A copy in another audio context, with copies of its clips. `route` says
     * which channel in the new mixer takes the place of the track's channel.
     */
    cloneTo(ctx: BaseAudioContext, route: (target: Connectable) => Connectable | null): Track {
        const copy = new Track(ctx);
        copy.title = this.title;
        copy.color = this.color;
        copy.setActive(this.enabled);
        if (this.target) {
            const target = route(this.target);
            if (target) copy.connect(target);
        }
        // (cloneFor puts the copy on the track itself)
        for (const sample of this.samples) sample.cloneFor(copy);
        copy.patterns = this.patterns.map((c) => ({ ...c }));
        return copy;
    }
}
