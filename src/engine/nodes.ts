// Audio nodes that are set up the same way everywhere in the engine.

/**
 * A gain node that always carries two channels. A mono signal that reaches it
 * is copied to left and right at the same level, so a mono file and a stereo
 * file play at the same loudness, and the level of a sound never depends on
 * what else happens to be connected to the same node (with the default
 * settings, a node's channel count follows its busiest input, so a mono kick
 * would get quieter or louder when a stereo clip started on the same track).
 */
export function stereoGain(ctx: BaseAudioContext): GainNode {
    return new GainNode(ctx, { channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers" });
}
