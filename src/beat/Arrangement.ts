import { Playlist } from "../core/Playlist";
import { AnyClip, NoteClip } from "../engine/NoteHost";
import { ClipProvider } from "../engine/Scheduler";
import { TempoMap } from "../engine/TempoMap";
import { Instrument } from "../instruments/Instrument";
import { Beat } from "./Beat";
import { PatternClipData, PatternData } from "./data";
import { NoteEventData, notesOfPattern, notesOfSong } from "./flatten";

// What the scheduler plays: the audio clips of the playlist, and the notes of
// the patterns placed on it. In pattern mode it is the notes of the open
// pattern alone. The list of notes is worked out once and kept until the beat
// changes, because the scheduler asks for it many times a second.

/** one note on the timeline, played by one instrument */
export class NoteEvent implements NoteClip {
    readonly kind = "note" as const;

    constructor(
        readonly data: NoteEventData,
        readonly target: Instrument,
        private tempo: () => TempoMap,
    ) {}

    get startBeat(): number {
        return this.data.startBeat;
    }

    get lengthBeats(): number {
        return this.data.lengthBeats;
    }

    /** the length depends on the tempo, so it is asked of the tempo map as it is now */
    get durationSeconds(): number {
        return this.tempo().secondsBetween(this.data.startBeat, this.data.startBeat + this.data.lengthBeats);
    }

    get pitch() {
        return this.data.pitch;
    }
    get velocity() {
        return this.data.velocity;
    }
    get pan() {
        return this.data.pan;
    }
    get slideTo() {
        return this.data.slideTo;
    }
    get slideAt() {
        return this.data.slideAt;
    }
    get seq() {
        return this.data.seq;
    }
}

export class Arrangement implements ClipProvider<AnyClip> {
    private notesCache: NoteEvent[] = [];
    private cacheKey = "";

    constructor(
        private playlist: Playlist,
        private beat: Beat,
        private tempo: () => TempoMap,
    ) {}

    *getClips(): Iterable<AnyClip> {
        if (this.beat.scope === "song") yield* this.playlist.getClips();
        yield* this.notes();
    }

    /** every note that plays, in time order */
    notes(): NoteEvent[] {
        const key = this.beat.version + ":" + this.beat.scope + ":" + this.playlist.getTracks().map((t) => (t.isActive() ? 1 : 0)).join("");
        if (key !== this.cacheKey) {
            this.notesCache = this.build();
            this.cacheKey = key;
        }
        return this.notesCache;
    }

    private build(): NoteEvent[] {
        const beat = this.beat;
        let events: NoteEventData[];
        if (beat.scope === "pattern") {
            const open = beat.activePattern();
            events = open ? notesOfPattern(open) : [];
        } else {
            const patterns = new Map<string, PatternData>(beat.patterns.map((p) => [p.id, p]));
            const placements: PatternClipData[] = [];
            // a muted track keeps its pattern clips but they do not play
            for (const track of this.playlist.getTracks()) if (track.isActive()) placements.push(...track.getPatternClips());
            events = notesOfSong(patterns, placements);
        }
        const out: NoteEvent[] = [];
        for (const event of events) {
            const instrument = beat.instrument(event.instrument);
            if (instrument) out.push(new NoteEvent(event, instrument, this.tempo));
        }
        return out;
    }
}
