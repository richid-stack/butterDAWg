import { Mixer } from "../core/Mixer";
import { LoopRegion, Transport } from "../engine/Transport";
import { Instrument } from "../instruments/Instrument";
import { PatternData, PlayScope } from "./data";

// The live beat: the instruments of the channel rack and the patterns made for
// them. It is the model the channel rack, the piano roll and the playlist draw
// and edit, and what the arrangement plays.
//
// Notes and patterns are plain data that the editors change in place; every
// change ends with `touch()`, which is how the arrangement knows to rebuild
// its list of notes and how the windows know to draw again.

export class Beat {
    readonly ctx: BaseAudioContext;
    instruments: Instrument[] = [];
    patterns: PatternData[] = [];
    /** goes up with every change, so what is built from the beat can tell it is out of date */
    version = 0;

    private active: string | null = null;
    private mode: PlayScope = "song";
    private listeners = new Set<() => void>();
    /** the song's loop region while the pattern is playing (which borrows the transport's loop); undefined when not in pattern mode */
    private savedLoop: LoopRegion | null | undefined = undefined;

    constructor(
        ctx: BaseAudioContext,
        private transport: Transport | null = null,
    ) {
        this.ctx = ctx;
    }

    // ---- looking things up -------------------------------------------------------

    instrument(id: string): Instrument | undefined {
        return this.instruments.find((i) => i.id === id);
    }

    pattern(id: string): PatternData | undefined {
        return this.patterns.find((p) => p.id === id);
    }

    get activePatternId(): string | null {
        return this.active;
    }

    /** the pattern that is open in the channel rack and the piano roll */
    activePattern(): PatternData | undefined {
        return this.active === null ? undefined : this.pattern(this.active);
    }

    get scope(): PlayScope {
        return this.mode;
    }

    /** An id that no instrument or pattern uses yet: "i1", "i2" ... / "p1", "p2" ... */
    newId(prefix: "i" | "p"): string {
        const used = new Set<string>([...this.instruments.map((i) => i.id), ...this.patterns.map((p) => p.id)]);
        let n = (prefix === "i" ? this.instruments.length : this.patterns.length) + 1;
        while (used.has(prefix + n)) n++;
        return prefix + n;
    }

    // ---- changing it --------------------------------------------------------------

    /** Opens a pattern in the editors (null for none). */
    setActivePattern(id: string | null): void {
        if (id !== null && !this.pattern(id)) id = null;
        if (this.active === id) return;
        this.active = id;
        this.touch();
    }

    /**
     * What the PAT and SONG buttons say. In pattern mode the open pattern plays in a loop and the playlist is
     * silent; the loop is the transport's, so the song's own loop region is put aside and comes back with SONG.
     */
    setScope(scope: PlayScope): void {
        if (scope === this.mode) return;
        this.mode = scope;
        if (this.transport) {
            if (scope === "pattern") {
                this.savedLoop = this.transport.getLoop();
                this.transport.seek(0);
            } else if (this.savedLoop !== undefined) {
                this.transport.setLoop(this.savedLoop);
                this.savedLoop = undefined;
                this.transport.seek(0);
            }
        }
        this.touch();
    }

    /** The song's loop region, wherever it is kept at the moment. This is what a saved project records. */
    songLoop(): LoopRegion | null {
        if (this.savedLoop !== undefined) return this.savedLoop;
        return this.transport ? this.transport.getLoop() : null;
    }

    /** Something changed: the notes, a pattern, the rack, a pattern clip, the scope. */
    touch(): void {
        this.version++;
        this.syncLoop();
        for (const listener of [...this.listeners]) listener();
    }

    /** be told when the beat changed (to draw it again) */
    onChange(callback: () => void): () => void {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    /** in pattern mode the transport loops the open pattern */
    private syncLoop(): void {
        if (!this.transport || this.mode !== "pattern") return;
        const pattern = this.activePattern();
        const want = pattern && pattern.length > 0 ? { startBeat: 0, endBeat: pattern.length } : null;
        const have = this.transport.getLoop();
        if (have?.startBeat === want?.startBeat && have?.endBeat === want?.endBeat) return;
        this.transport.setLoop(want);
    }

    /** Connects every instrument to its mixer channel. */
    connectAll(mixer: Mixer): void {
        for (const instrument of this.instruments) this.connect(instrument, mixer);
    }

    connect(instrument: Instrument, mixer: Mixer): void {
        const channel = instrument.channel === null ? undefined : mixer.getChannels()[instrument.channel];
        instrument.connectTo(channel ? channel.getAudioNode() : null);
    }

    /** Takes the instruments out of the audio graph (a project was closed). */
    dispose(): void {
        for (const instrument of this.instruments) instrument.dispose();
        this.listeners.clear();
    }

    /**
     * A copy in another audio context (for the export). The notes are shared, not copied: nothing changes them while
     * an export reads them. `into` is the mixer the instruments play into.
     */
    cloneTo(ctx: BaseAudioContext, into: Mixer): Beat {
        const copy = new Beat(ctx);
        copy.patterns = this.patterns;
        copy.active = this.active;
        copy.mode = this.mode;
        for (const instrument of this.instruments) copy.instruments.push(instrument.cloneTo(ctx));
        copy.connectAll(into);
        return copy;
    }
}
