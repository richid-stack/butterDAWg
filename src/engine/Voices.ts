import { SchedulableClip, SchedulerHost, StartEvent } from "./Scheduler";

// Voices make the sound for what the scheduler hands out: one buffer source per
// clip play, with a small gain node so it can be faded out instead of cut (a
// hard cut at a non-zero sample is a click).

import { stereoGain } from "./nodes";

export interface PlayableClip extends SchedulableClip {
    /** null while the file is still loading; such clips are skipped */
    readonly buffer: AudioBuffer | null;
    /** where the clip's sound goes (usually its track's node) */
    readonly destination: AudioNode;
}

interface Voice {
    source: AudioBufferSourceNode;
    gain: GainNode;
    when: number;
}

export class Voices implements SchedulerHost<PlayableClip> {
    private active = new Set<Voice>();

    constructor(
        private ctx: BaseAudioContext,
        /** length of the fade at a cut, in seconds */
        private fade = 0.005,
    ) {}

    get activeCount(): number {
        return this.active.size;
    }

    start(event: StartEvent<PlayableClip>): void {
        const buffer = event.clip.buffer;
        if (!buffer) return;
        const now = this.ctx.currentTime;
        let when = event.when;
        let offset = event.offset;
        // If the timer ran so late that the start time has passed, join the
        // clip part-way in rather than playing it late.
        if (when < now) {
            offset += now - when;
            when = now;
        }
        if (offset >= buffer.duration) return;

        const source = new AudioBufferSourceNode(this.ctx, { buffer });
        const gain = stereoGain(this.ctx);
        source.connect(gain);
        gain.connect(event.clip.destination);
        source.start(when, offset);
        if (event.stopAt !== null) {
            const fadeStart = Math.max(when, event.stopAt - this.fade);
            gain.gain.setValueAtTime(1, fadeStart);
            gain.gain.linearRampToValueAtTime(0, event.stopAt);
            source.stop(event.stopAt);
        }

        const voice: Voice = { source, gain, when };
        this.active.add(voice);
        source.onended = () => {
            this.release(voice);
        };
    }

    flush(): void {
        const now = this.ctx.currentTime;
        for (const voice of this.active) {
            if (voice.when > now) {
                // not audible yet: cancel it
                try {
                    voice.source.stop();
                } catch {
                    // already stopped
                }
                this.release(voice);
            } else {
                // audible: fade it out
                voice.gain.gain.cancelScheduledValues(now);
                voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
                voice.gain.gain.linearRampToValueAtTime(0, now + this.fade);
                try {
                    voice.source.stop(now + this.fade);
                } catch {
                    // already stopped
                }
            }
        }
    }

    private release(voice: Voice): void {
        voice.source.disconnect();
        voice.gain.disconnect();
        this.active.delete(voice);
    }
}
