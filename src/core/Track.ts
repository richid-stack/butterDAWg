import { Color } from "../ui/misc/Color";
import { Connectable, globals } from "../globals";
import { Sample } from "./Sample";
import { stereoGain } from "../engine/nodes";

// A playlist track holds clips. All its clips play into one node, which goes to
// one mixer channel. The track does not play anything itself; the scheduler
// starts its clips (see engine/Scheduler.ts).

export class Track implements Connectable {
    readonly ctx: BaseAudioContext;
    private audionode: GainNode;
    private samples: Array<Sample>;
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

    addSample(sample: Sample) {
        sample.track = this;
        this.samples.push(sample);
    }

    /** Sends this track's sound to one place; an earlier connection is dropped. */
    connect(object: Connectable) {
        this.audionode.disconnect();
        this.audionode.connect(object.getAudioNode());
        this.target = object;
    }

    getTarget(): Connectable | null {
        return this.target;
    }

    getAudioNode(): AudioNode {
        return this.audionode;
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
        return copy;
    }
}
