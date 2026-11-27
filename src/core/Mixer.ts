import { globals } from "../globals";
import { Channel } from "./Channel";

export class Mixer {
    readonly ctx: BaseAudioContext;
    private channels: Array<Channel>;
    private master: Channel;

    constructor(ctx: BaseAudioContext = globals.audiocontext, initialChannels = 1) {
        this.ctx = ctx;
        this.channels = [];

        // every channel plays into the master channel, which plays to the speakers
        this.master = new Channel(ctx, ctx.destination);
        this.master.setName("Master");
        for (let i = 0; i < initialChannels; i++) this.newChannel();
    }

    getChannels() {
        return this.channels;
    }

    getMaster() {
        return this.master;
    }

    newChannel(): Channel {
        let channel = new Channel(this.ctx, this.master.getAudioNode());
        channel.setName("Channel " + this.channels.length);
        this.channels.push(channel);
        return channel;
    }

    /** Takes the whole mixer out of the audio graph (a project was closed). */
    dispose() {
        this.channels.forEach((c) => c.dispose());
        this.master.dispose();
    }

    /** A copy of the whole mixer in another audio context (for offline rendering). */
    async cloneTo(ctx: BaseAudioContext): Promise<Mixer> {
        const copy = new Mixer(ctx, 0);
        copy.master = await this.master.cloneTo(ctx, ctx.destination);
        for (const channel of this.channels) {
            copy.channels.push(await channel.cloneTo(ctx, copy.master.getAudioNode()));
        }
        return copy;
    }
}
