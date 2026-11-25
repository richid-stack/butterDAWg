import { Connectable, globals } from "../globals";
import { peakOf, rmsOf } from "../engine/dsp";
import { stereoGain } from "../engine/nodes";
import { Plugin } from "./Plugin";

// A mixer channel. The sound path is
//
//   input -> plugins (in slot order, skipping bypassed ones) -> pan -> fader -> meter -> output
//
// and the output goes to the master channel (or, for the master, to the speakers).

export const PLUGIN_SLOTS = 10;

export class Channel implements Connectable {
    readonly ctx: BaseAudioContext;
    private input: GainNode;
    private plugins: Array<Plugin | null>;
    private panner: StereoPannerNode;
    private fader: GainNode;
    private meter: AnalyserNode;
    private output: GainNode;
    private meterBuffer: Float32Array<ArrayBuffer>;
    private volume = 1; // linear gain, 1 = 0 dB
    private panning = 1; // 0.5 (left) .. 1 (centre) .. 1.5 (right), as the interface uses it
    private enabled = true;
    private name = "";

    constructor(ctx: BaseAudioContext = globals.audiocontext, destination: AudioNode = ctx.destination) {
        this.ctx = ctx;
        this.input = stereoGain(ctx);
        this.plugins = Array.from({ length: PLUGIN_SLOTS }, (): Plugin => null);
        // equal-power panning: the centre is not louder or quieter than the sides
        this.panner = new StereoPannerNode(ctx);
        this.fader = new GainNode(ctx);
        // the analyser measures the level after the plugins and the fader
        this.meter = new AnalyserNode(ctx);
        this.output = new GainNode(ctx);
        this.meterBuffer = new Float32Array(this.meter.fftSize);

        this.panner.connect(this.fader);
        this.fader.connect(this.meter);
        this.meter.connect(this.output);
        this.output.connect(destination);
        this.rebuildChain();
    }

    /** Sets the fader gain (linear; 1 is 0 dB). `smooth` avoids clicks while it is being dragged. */
    setVolume(v: number, smooth = true) {
        this.volume = v;
        this.setParam(this.fader.gain, v, smooth);
    }

    getVolume() {
        return this.volume;
    }

    getPanning() {
        return this.panning;
    }

    setPanning(p: number) {
        this.panning = p;
        this.panner.pan.value = Math.max(-1, Math.min(1, (p - 1) * 2));
    }

    /** an inactive channel is silent */
    setActive(active: boolean, smooth = true) {
        this.enabled = active;
        this.setParam(this.output.gain, active ? 1 : 0, smooth);
    }

    isActive() {
        return this.enabled;
    }

    getName() {
        return this.name;
    }

    setName(name: string) {
        this.name = name;
    }

    getAudioNode(): AudioNode {
        return this.input;
    }

    /** where the channel's finished sound leaves it (for meters and recorders to listen to) */
    getOutputNode(): AudioNode {
        return this.output;
    }

    getPlugins() {
        return this.plugins;
    }

    addPlugin(plugin: Plugin, index?: number) {
        // use the first empty slot if no slot was asked for
        if (index === undefined) {
            index = this.plugins.findIndex((v) => v === null);
        }
        if (index === -1) {
            alert("all plugin slots are full");
            return;
        }
        // TODO this has to go at some point
        if (this.plugins[index] !== null) {
            alert("there is already a plugin in slot " + index);
            return;
        }
        this.plugins[index] = plugin;
        this.rebuildChain();
        // the plugin's node does not exist until its module has loaded
        plugin.ready.then(() => this.rebuildChain());
    }

    removePlugin(index: number) {
        this.plugins[index] = null;
        this.rebuildChain();
    }

    setPluginBypassed(index: number, bypassed: boolean) {
        const plugin = this.plugins[index];
        if (!plugin) return;
        plugin.bypassed = bypassed;
        this.rebuildChain();
    }

    /** the level of the last few milliseconds: the highest absolute sample, 0..1 and above */
    getPeak(): number {
        this.meter.getFloatTimeDomainData(this.meterBuffer);
        return peakOf(this.meterBuffer);
    }

    getRms(): number {
        this.meter.getFloatTimeDomainData(this.meterBuffer);
        return rmsOf(this.meterBuffer);
    }

    /** the last block of output samples (the buffer is reused; copy it if you keep it) */
    getFloatTimeDomainData(): Float32Array {
        this.meter.getFloatTimeDomainData(this.meterBuffer);
        return this.meterBuffer;
    }

    /** A copy of this channel in another audio context, with copies of its plugins. */
    async cloneTo(ctx: BaseAudioContext, destination: AudioNode): Promise<Channel> {
        const copy = new Channel(ctx, destination);
        copy.name = this.name;
        copy.setVolume(this.volume, false);
        copy.setPanning(this.panning);
        copy.setActive(this.enabled, false);
        for (let i = 0; i < this.plugins.length; i++) {
            if (this.plugins[i]) copy.plugins[i] = await this.plugins[i].cloneTo(ctx);
        }
        copy.rebuildChain();
        return copy;
    }

    // Joins input -> active plugins -> panner from the plugin list, so adding,
    // removing, reordering or bypassing never has to work out which neighbour
    // to disconnect from.
    private rebuildChain() {
        this.input.disconnect();
        for (const plugin of this.plugins) {
            if (plugin && plugin.isReady()) plugin.getAudioNode().disconnect();
        }
        let previous: AudioNode = this.input;
        for (const plugin of this.plugins) {
            if (!plugin || !plugin.isReady() || plugin.bypassed) continue;
            previous.connect(plugin.getAudioNode());
            previous = plugin.getAudioNode();
        }
        previous.connect(this.panner);
    }

    private setParam(param: AudioParam, value: number, smooth: boolean) {
        if (smooth && this.ctx instanceof AudioContext) {
            param.setTargetAtTime(value, this.ctx.currentTime, 0.01);
        } else {
            param.value = value;
        }
    }
}
