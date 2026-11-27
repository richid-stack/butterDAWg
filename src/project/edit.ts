// Every edit the user can make goes through here, so every edit can be undone.
//
// There are two kinds of edit:
//   - a single action (toggle a track, add a plugin): `session.history.execute()`
//     runs it and keeps it.
//   - a gesture (dragging a clip or a fader): the UI changes the live project
//     while the mouse moves, and `gesture()` remembers what it was at the start
//     and compares at the end, so one drag is one undo step.
//
// Commands hold the live objects they changed (a track, a clip, a plugin), so
// undoing a deletion brings back the very same clip. The history is cleared
// whenever a project is opened, so no command outlives its objects.

import { Channel } from "../core/Channel";
import { Plugin } from "../core/Plugin";
import { Sample } from "../core/Sample";
import { Track } from "../core/Track";
import { globals } from "../globals";
import { Color } from "../ui/misc/Color";
import { session } from "./session";
import type { TempoPoint } from "../engine/TempoMap";

const history = () => session.history;

// ---- gestures -----------------------------------------------------------------

export interface Gesture {
    /** the gesture is over: if the value is different now, it becomes one undo step */
    end(): void;
}

/**
 * Starts watching a value that a gesture is about to change. `read` gets the
 * value, `apply` sets it (what undo and redo use). Call `end()` when the
 * gesture finishes.
 */
export function gesture<T>(label: string, read: () => T, apply: (value: T) => void, same: (a: T, b: T) => boolean = Object.is): Gesture {
    const before = read();
    let ended = false;
    return {
        end() {
            if (ended) return;
            ended = true;
            const after = read();
            if (same(before, after)) return;
            history().record({ label, undo: () => apply(before), redo: () => apply(after) });
        },
    };
}

const sameParams = (a: Record<string, number>, b: Record<string, number>) => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (a[k] !== b[k]) return false;
    return true;
};

const sameTempo = (a: readonly TempoPoint[], b: readonly TempoPoint[]) =>
    a.length === b.length && a.every((p, i) => p.beat === b[i].beat && p.bpm === b[i].bpm);

// ---- tempo --------------------------------------------------------------------

export function tempoGesture(): Gesture {
    const transport = globals.engine.transport;
    return gesture<readonly TempoPoint[]>(
        "Change tempo",
        () => transport.tempo.getPoints().map((p) => ({ ...p })),
        (points) => transport.setTempoPoints(points),
        sameTempo,
    );
}

// ---- mixer channels -----------------------------------------------------------

export function volumeGesture(channel: Channel): Gesture {
    return gesture("Change volume", () => channel.getVolume(), (v) => channel.setVolume(v));
}

export function panGesture(channel: Channel): Gesture {
    return gesture("Change panning", () => channel.getPanning(), (p) => channel.setPanning(p));
}

export function setChannelActive(channel: Channel, active: boolean): void {
    if (channel.isActive() === active) return;
    history().execute({
        label: active ? "Unmute channel" : "Mute channel",
        redo: () => channel.setActive(active),
        undo: () => channel.setActive(!active),
    });
}

export function renameChannel(channel: Channel, name: string): void {
    const before = channel.getName();
    if (before === name) return;
    history().execute({ label: "Rename channel", redo: () => channel.setName(name), undo: () => channel.setName(before) });
}

// ---- plugins ------------------------------------------------------------------

export function addPlugin(channel: Channel, slot: number, plugin: Plugin): void {
    history().execute({
        label: "Add " + plugin.name,
        redo: () => channel.addPlugin(plugin, slot),
        undo: () => channel.removePlugin(slot),
    });
}

export function removePlugin(channel: Channel, slot: number): void {
    const plugin = channel.getPlugins()[slot];
    if (!plugin) return;
    history().execute({
        label: "Remove " + plugin.name,
        redo: () => channel.removePlugin(slot),
        undo: () => channel.addPlugin(plugin, slot),
    });
}

export function setPluginBypassed(channel: Channel, slot: number, bypassed: boolean): void {
    const plugin = channel.getPlugins()[slot];
    if (!plugin || plugin.bypassed === bypassed) return;
    history().execute({
        label: (bypassed ? "Bypass " : "Enable ") + plugin.name,
        redo: () => channel.setPluginBypassed(slot, bypassed),
        undo: () => channel.setPluginBypassed(slot, !bypassed),
    });
}

/** watches a plugin's parameters while its window is being used (see PluginWindow) */
export function pluginParamsGesture(plugin: Plugin): Gesture {
    return gesture<Record<string, number>>(
        "Change " + plugin.name,
        () => plugin.getParams(),
        (params) => plugin.setParams(params),
        sameParams,
    );
}

// ---- tracks -------------------------------------------------------------------

export function setTrackColor(track: Track, color: string): void {
    const before = track.color.color;
    if (before === color) return;
    history().execute({
        label: "Change track colour",
        redo: () => (track.color = new Color(color)),
        undo: () => (track.color = new Color(before)),
    });
}

export function renameTrack(track: Track, title: string): void {
    const before = track.title;
    if (before === title) return;
    history().execute({ label: "Rename track", redo: () => (track.title = title), undo: () => (track.title = before) });
}

/** Mutes or unmutes tracks as one step ("solo" changes several at once). */
export function setTracksActive(changes: Array<[Track, boolean]>, label = "Mute track"): void {
    const real = changes.filter(([track, active]) => track.isActive() !== active);
    if (real.length === 0) return;
    const before = real.map(([track]) => track.isActive());
    history().execute({
        label,
        redo: () => real.forEach(([track, active]) => track.setActive(active)),
        undo: () => real.forEach(([track], i) => track.setActive(before[i])),
    });
}

export function routeTrack(track: Track, target: Channel): void {
    const before = track.getTarget();
    if (before === target) return;
    history().execute({
        label: "Route track",
        redo: () => track.connect(target),
        undo: () => (before ? track.connect(before) : track.disconnect()),
    });
}

// ---- clips --------------------------------------------------------------------

/** A clip was dropped on the playlist from the browser (it is already on its track): keep it as one step. */
export function recordAddClip(sample: Sample): void {
    const track = sample.track;
    if (!track) return;
    history().record({
        label: "Add clip",
        redo: () => track.addSample(sample),
        undo: () => track.removeSample(sample),
    });
}

export interface ClipPlace {
    sample: Sample;
    track: Track;
    index: number;
    startBeat: number;
}

export function clipPlace(sample: Sample): ClipPlace | null {
    const track = sample.track;
    if (!track) return null;
    return { sample, track, index: track.getSamples().indexOf(sample), startBeat: sample.getStartBeat() };
}

/** A clip was dragged (it is already at its new place): keep it as one step. */
export function recordMoveClip(from: ClipPlace): void {
    const sample = from.sample;
    const to = clipPlace(sample);
    if (!to) return;
    if (to.track === from.track && to.startBeat === from.startBeat) return;
    history().record({
        label: "Move clip",
        undo: () => {
            if (to.track !== from.track) {
                to.track.removeSample(sample);
                from.track.addSample(sample, from.index);
            }
            sample.setStartBeat(from.startBeat);
        },
        redo: () => {
            if (to.track !== from.track) {
                from.track.removeSample(sample);
                to.track.addSample(sample);
            }
            sample.setStartBeat(to.startBeat);
        },
    });
}

export function deleteClips(samples: Sample[]): void {
    const places = samples.map(clipPlace).filter((p): p is ClipPlace => p !== null);
    if (places.length === 0) return;
    history().execute({
        label: places.length === 1 ? "Delete clip" : "Delete clips",
        redo: () => places.forEach((p) => p.track.removeSample(p.sample)),
        // put them back from the last to the first, so every clip returns to its own index
        undo: () => [...places].reverse().forEach((p) => p.track.addSample(p.sample, p.index)),
    });
}

// ---- undo and redo ------------------------------------------------------------

export function undo(): boolean {
    return history().undo();
}

export function redo(): boolean {
    return history().redo();
}
