// Every edit of the beat that the user can make, each one a step that can be undone (see project/edit.ts for how
// commands work). The notes are plain data that the editors change while the mouse moves; they use
// `noteGesture()` to make one drag one step, and `editNotes()` for an edit made in one go.

import { Track } from "../core/Track";
import { globals } from "../globals";
import { gesture, Gesture } from "../project/edit";
import { session } from "../project/session";
import { Instrument, SamplerSettings, Zone } from "../instruments/Instrument";
import { Beat } from "./Beat";
import {
    cloneNote,
    clonePattern,
    emptySampler,
    NoteData,
    PatternClipData,
    PatternData,
    SamplerMode,
    STEPS_PER_BEAT,
    ZoneSettings,
} from "./data";

const history = () => session.history;
const beat = (): Beat => globals.beat;

/** colours for new instruments and patterns, taken in turn */
const COLOURS = ["#c77d5a", "#8aa05a", "#5a8fc7", "#b0689a", "#c7b35a", "#5ac7b0", "#8f7ac7", "#c75a6b"];

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- notes --------------------------------------------------------------------

const copyNotes = (notes: NoteData[]) => notes.map(cloneNote);

/** Changes a pattern's notes in one go; `change` edits the list in place. Returns false if nothing changed. */
export function editNotes(pattern: PatternData, label: string, change: (notes: NoteData[]) => void): boolean {
    const before = copyNotes(pattern.notes);
    change(pattern.notes);
    const after = copyNotes(pattern.notes);
    if (sameJson(before, after)) return false;
    history().record({
        label,
        undo: () => {
            pattern.notes = copyNotes(before);
            beat().touch();
        },
        redo: () => {
            pattern.notes = copyNotes(after);
            beat().touch();
        },
    });
    beat().touch();
    return true;
}

/** Watches a pattern's notes while the mouse is dragging them; `end()` makes the drag one undo step. */
export function noteGesture(pattern: PatternData, label: string): Gesture {
    return gesture<NoteData[]>(
        label,
        () => copyNotes(pattern.notes),
        (notes) => {
            pattern.notes = copyNotes(notes);
            beat().touch();
        },
        sameJson,
    );
}

// ---- patterns -----------------------------------------------------------------

export function addPattern(name?: string, steps = 16): PatternData {
    const b = beat();
    const id = b.newId("p");
    const pattern: PatternData = {
        id,
        name: name ?? "Pattern " + (b.patterns.length + 1),
        color: COLOURS[b.patterns.length % COLOURS.length],
        length: steps / STEPS_PER_BEAT,
        notes: [],
    };
    const previous = b.activePatternId;
    history().execute({
        label: "Add pattern",
        redo: () => {
            b.patterns.push(pattern);
            b.setActivePattern(pattern.id);
            b.touch();
        },
        undo: () => {
            b.patterns.splice(b.patterns.indexOf(pattern), 1);
            b.setActivePattern(previous);
            b.touch();
        },
    });
    return pattern;
}

/** A copy of a pattern, as a new pattern (the notes are copied, so changing one does not change the other). */
export function duplicatePattern(source: PatternData): PatternData {
    const b = beat();
    const copy = clonePattern(source);
    copy.id = b.newId("p");
    copy.name = source.name + " copy";
    const previous = b.activePatternId;
    history().execute({
        label: "Duplicate pattern",
        redo: () => {
            b.patterns.push(copy);
            b.setActivePattern(copy.id);
            b.touch();
        },
        undo: () => {
            b.patterns.splice(b.patterns.indexOf(copy), 1);
            b.setActivePattern(previous);
            b.touch();
        },
    });
    return copy;
}

/** Deletes a pattern and the clips that play it. */
export function deletePattern(pattern: PatternData): void {
    const b = beat();
    const index = b.patterns.indexOf(pattern);
    if (index === -1) return;
    const clips: Array<{ track: Track; clip: PatternClipData; at: number }> = [];
    for (const track of globals.playlist.getTracks()) {
        track.getPatternClips().forEach((clip, at) => {
            if (clip.pattern === pattern.id) clips.push({ track, clip, at });
        });
    }
    const wasActive = b.activePatternId === pattern.id;
    history().execute({
        label: "Delete pattern",
        redo: () => {
            for (const { track, clip } of clips) track.removePatternClip(clip);
            b.patterns.splice(b.patterns.indexOf(pattern), 1);
            if (wasActive) b.setActivePattern(b.patterns[0]?.id ?? null);
            b.touch();
        },
        undo: () => {
            b.patterns.splice(index, 0, pattern);
            for (const { track, clip, at } of [...clips].reverse()) track.addPatternClip(clip, at);
            if (wasActive) b.setActivePattern(pattern.id);
            b.touch();
        },
    });
}

/** Sets one value of a pattern (its name, colour, length, swing); undoable as one step. */
export function setPattern<K extends "name" | "color" | "length" | "swing">(pattern: PatternData, key: K, value: PatternData[K], label?: string): void {
    const had = key in pattern;
    const before = pattern[key];
    if (before === value) return;
    const put = (v: PatternData[K] | undefined, present: boolean) => {
        if (present) pattern[key] = v as PatternData[K];
        else delete pattern[key];
        beat().touch();
    };
    history().execute({
        label: label ?? "Change pattern " + key,
        redo: () => put(value, true),
        undo: () => put(before, had),
    });
}

// ---- pattern clips (patterns on the playlist) ----------------------------------

export function placePattern(track: Track, pattern: PatternData, startBeat: number, length = pattern.length): PatternClipData {
    const clip: PatternClipData = { pattern: pattern.id, startBeat: Math.max(0, startBeat), length };
    history().execute({
        label: "Place pattern",
        redo: () => {
            track.addPatternClip(clip);
            beat().touch();
        },
        undo: () => {
            track.removePatternClip(clip);
            beat().touch();
        },
    });
    return clip;
}

export interface PatternClipPlace {
    clip: PatternClipData;
    track: Track;
    index: number;
    startBeat: number;
    length: number;
}

export function patternClipPlace(clip: PatternClipData): PatternClipPlace | null {
    for (const track of globals.playlist.getTracks()) {
        const index = track.getPatternClips().indexOf(clip);
        if (index !== -1) return { clip, track, index, startBeat: clip.startBeat, length: clip.length };
    }
    return null;
}

/** A pattern clip was moved or resized by dragging (it is already at its new place): keep it as one step. */
export function recordPatternClipChange(from: PatternClipPlace, label = "Move pattern"): void {
    const to = patternClipPlace(from.clip);
    if (!to) return;
    if (to.track === from.track && to.startBeat === from.startBeat && to.length === from.length) return;
    const clip = from.clip;
    const put = (at: PatternClipPlace, other: PatternClipPlace) => {
        if (at.track !== other.track) {
            other.track.removePatternClip(clip);
            at.track.addPatternClip(clip, at.index);
        }
        clip.startBeat = at.startBeat;
        clip.length = at.length;
        beat().touch();
    };
    history().record({ label, undo: () => put(from, to), redo: () => put(to, from) });
    beat().touch();
}

export function deletePatternClips(clips: PatternClipData[]): void {
    const places = clips.map(patternClipPlace).filter((p): p is PatternClipPlace => p !== null);
    if (places.length === 0) return;
    history().execute({
        label: places.length === 1 ? "Delete pattern clip" : "Delete pattern clips",
        redo: () => {
            places.forEach((p) => p.track.removePatternClip(p.clip));
            beat().touch();
        },
        undo: () => {
            [...places].reverse().forEach((p) => p.track.addPatternClip(p.clip, p.index));
            beat().touch();
        },
    });
}

// ---- instruments ---------------------------------------------------------------

export interface NewInstrument {
    name: string;
    /** the sample files; one file is one zone over the whole keyboard */
    paths?: string[];
    mode?: SamplerMode;
    color?: string;
    chokeGroup?: number;
    /** the key at which the sample sounds as recorded (default middle C) */
    rootKey?: number;
    /** a mixer channel by number, null for none; by default the first channel nothing else plays into (a new one if all are taken) */
    channel?: number | null;
}

/** the settings of a zone that covers the whole keyboard */
export function wholeKeyboardZone(rootKey = 60): ZoneSettings {
    return { keyLow: 0, keyHigh: 127, rootKey, velLow: 1, velHigh: 127, loop: null, tune: 0, volume: 1, pan: 0 };
}

export function addInstrument(spec: NewInstrument): Instrument {
    const b = beat();
    const mixer = globals.mixer;
    const instrument = new Instrument(b.ctx, b.newId("i"), spec.name, spec.color ?? COLOURS[b.instruments.length % COLOURS.length], samplerFor(spec));
    for (const path of spec.paths ?? []) instrument.addZone(new Zone(wholeKeyboardZone(spec.rootKey ?? 60), path));

    // the first channel that nothing plays into; a new channel when they are all taken
    let channel: number | null;
    let created = false;
    if (spec.channel !== undefined) {
        channel = spec.channel;
    } else {
        const used = new Set<number>();
        for (const other of b.instruments) if (other.channel !== null) used.add(other.channel);
        const taken = (i: number) => used.has(i) || globals.playlist.getTracks().some((t) => t.getTarget() === mixer.getChannels()[i]);
        const free = mixer.getChannels().findIndex((_, i) => !taken(i));
        channel = free;
        if (free === -1) {
            channel = mixer.getChannels().length;
            created = true;
        }
    }
    instrument.channel = channel;
    let made = false;
    history().execute({
        label: "Add instrument " + spec.name,
        redo: () => {
            // the new channel is made once; undoing leaves it (an empty channel does no harm), redoing finds it again
            if (created && !made) {
                mixer.newChannel().setName(spec.name);
                made = true;
            }
            b.instruments.push(instrument);
            b.connect(instrument, mixer);
            b.touch();
        },
        undo: () => {
            b.instruments.splice(b.instruments.indexOf(instrument), 1);
            instrument.connectTo(null);
            b.touch();
        },
    });
    return instrument;
}

function samplerFor(spec: NewInstrument): SamplerSettings {
    const { zones, ...settings } = emptySampler(spec.mode ?? "oneshot");
    void zones;
    if (spec.chokeGroup !== undefined) settings.chokeGroup = spec.chokeGroup;
    return settings;
}

/** Removes an instrument and all the notes that it plays, in every pattern. */
export function removeInstrument(instrument: Instrument): void {
    const b = beat();
    const index = b.instruments.indexOf(instrument);
    if (index === -1) return;
    const notes = b.patterns.map((p) => ({ pattern: p, before: copyNotes(p.notes) }));
    history().execute({
        label: "Remove instrument " + instrument.name,
        redo: () => {
            for (const { pattern } of notes) pattern.notes = pattern.notes.filter((n) => n.instrument !== instrument.id);
            b.instruments.splice(b.instruments.indexOf(instrument), 1);
            instrument.connectTo(null);
            b.touch();
        },
        undo: () => {
            b.instruments.splice(index, 0, instrument);
            for (const { pattern, before } of notes) pattern.notes = copyNotes(before);
            b.connect(instrument, globals.mixer);
            b.touch();
        },
    });
}

export function renameInstrument(instrument: Instrument, name: string): void {
    const before = instrument.name;
    if (before === name) return;
    history().execute({
        label: "Rename instrument",
        redo: () => {
            instrument.name = name;
            beat().touch();
        },
        undo: () => {
            instrument.name = before;
            beat().touch();
        },
    });
}

export function setInstrumentColor(instrument: Instrument, color: string): void {
    const before = instrument.color;
    if (before === color) return;
    history().execute({
        label: "Change instrument colour",
        redo: () => {
            instrument.color = color;
            beat().touch();
        },
        undo: () => {
            instrument.color = before;
            beat().touch();
        },
    });
}

export function setInstrumentMuted(instrument: Instrument, muted: boolean): void {
    if (instrument.isMuted() === muted) return;
    history().execute({
        label: muted ? "Mute instrument" : "Unmute instrument",
        redo: () => {
            instrument.setMuted(muted);
            beat().touch();
        },
        undo: () => {
            instrument.setMuted(!muted);
            beat().touch();
        },
    });
}

export function routeInstrument(instrument: Instrument, channel: number | null): void {
    const before = instrument.channel;
    if (before === channel) return;
    const put = (c: number | null) => {
        instrument.channel = c;
        beat().connect(instrument, globals.mixer);
        beat().touch();
    };
    history().execute({ label: "Route instrument", redo: () => put(channel), undo: () => put(before) });
}

export function instrumentVolumeGesture(instrument: Instrument): Gesture {
    return gesture("Change instrument volume", () => instrument.getVolume(), (v) => instrument.setVolume(v));
}

export function instrumentPanGesture(instrument: Instrument): Gesture {
    return gesture("Change instrument pan", () => instrument.getPan(), (p) => instrument.setPan(p));
}

/** Changes the sampler's own settings (mode, envelope, choke group, key switch range); one undo step. */
export function setSampler(instrument: Instrument, patch: Partial<SamplerSettings>, label = "Change instrument"): void {
    const before = { ...instrument.sampler };
    const after = { ...before, ...patch };
    if (sameJson(before, after)) return;
    const put = (s: SamplerSettings) => {
        instrument.sampler = { ...s };
        beat().touch();
    };
    history().execute({ label, redo: () => put(after), undo: () => put(before) });
}

/** Adds a sample to an instrument as a zone (over the whole keyboard unless `settings` say otherwise). */
export function addZone(instrument: Instrument, path: string, settings: Partial<ZoneSettings> = {}): Zone {
    const zone = new Zone({ ...wholeKeyboardZone(), ...settings }, path);
    history().execute({
        label: "Add sample",
        redo: () => {
            instrument.addZone(zone);
            beat().touch();
        },
        undo: () => {
            instrument.removeZone(zone);
            beat().touch();
        },
    });
    return zone;
}

export function removeZone(instrument: Instrument, zone: Zone): void {
    const index = instrument.zones.indexOf(zone);
    if (index === -1) return;
    history().execute({
        label: "Remove sample",
        redo: () => {
            instrument.removeZone(zone);
            beat().touch();
        },
        undo: () => {
            instrument.addZone(zone, index);
            beat().touch();
        },
    });
}

export function setZone(zone: Zone, patch: Partial<ZoneSettings>, label = "Change sample"): void {
    const before = { ...zone.settings };
    const after = { ...before, ...patch };
    if (sameJson(before, after)) return;
    const put = (s: ZoneSettings) => {
        zone.settings = { ...s };
        beat().touch();
    };
    history().execute({ label, redo: () => put(after), undo: () => put(before) });
}
