// The live project (mixer, playlist, plugins, tempo) to project data and back.
//
//   capture()  reads the live objects into a ProjectData; nothing is changed
//   restore()  replaces the live objects with the ones a ProjectData describes
//
// The data is the model: the engine plays what restore() built from it, and
// capture() of that is the same data again.

import { globals } from "../globals";
import { Channel } from "../core/Channel";
import { Mixer } from "../core/Mixer";
import { Playlist } from "../core/Playlist";
import { Plugin } from "../core/Plugin";
import { Sample } from "../core/Sample";
import { Arrangement } from "../beat/Arrangement";
import { Beat } from "../beat/Beat";
import { captureBeat, FileRef, restoreBeat } from "../beat/persist";
import { Color } from "../ui/misc/Color";
import {
    AssetBook,
    AssetMeta,
    baseName,
    classify,
    defaultMeta,
    LicenceManifest,
    Roots,
    toAbsolute,
} from "./assets";
import { AssetData, ChannelData, CURRENT_VERSION, PROJECT_FORMAT, ProjectData, TrackData } from "./schema";

export const assetBook = new AssetBook();

/** the licence record of the app's library, once it has been read */
let manifest: LicenceManifest | null = null;
export function setLicenceManifest(m: LicenceManifest | null): void {
    manifest = m;
}

/** what is recorded for a file: what was remembered about it, or what the library record says */
export function metaFor(absolute: string, roots: Roots): AssetMeta {
    return assetBook.get(absolute) ?? defaultMeta(absolute, roots, manifest);
}

/** every audio file the project uses: the clips' and the instruments' zones' (these are what is copied when collecting) */
export function usedFiles(): Array<FileRef & { path: string }> {
    const files: Array<FileRef & { path: string }> = [...(globals.playlist.getClips() as Iterable<Sample>)];
    for (const instrument of globals.beat?.instruments ?? []) files.push(...instrument.zones);
    return files;
}

export interface CaptureOptions extends Roots {
    name: string;
    appVersion: string;
}

export function captureChannel(channel: Channel): ChannelData {
    return {
        name: channel.getName(),
        volume: channel.getVolume(),
        panning: channel.getPanning(),
        active: channel.isActive(),
        plugins: channel.getPlugins().map((plugin) =>
            plugin ? { path: plugin.pluginPath, bypassed: plugin.bypassed, params: plugin.getParams() } : null,
        ),
    };
}

export function capture(options: CaptureOptions): ProjectData {
    const mixer = globals.mixer;
    const playlist = globals.playlist;
    const transport = globals.engine.transport;
    const roots: Roots = { appRoot: options.appRoot, projectDir: options.projectDir };

    // every file the clips use becomes one asset, in the order the clips first use it
    const assets: AssetData[] = [];
    const idByPath = new Map<string, string>();
    const assetFor = (sample: FileRef): string => {
        // a clip whose file cannot be found keeps the record it came with
        const missing = sample.missingAsset;
        const key = missing ? "missing:" + missing.location + ":" + missing.path : sample.path;
        const known = idByPath.get(key);
        if (known) return known;
        const id = "a" + (assets.length + 1);
        if (missing) {
            assets.push({ ...missing, id });
        } else {
            const absolute = sample.path;
            const { location, path } = classify(absolute, roots);
            const meta = metaFor(absolute, roots);
            const asset: AssetData = { id, location, path, name: baseName(absolute), source: meta.source, licence: meta.licence };
            if (meta.sha256) asset.sha256 = meta.sha256;
            if (meta.credit) asset.credit = meta.credit;
            assets.push(asset);
        }
        idByPath.set(key, id);
        return id;
    };

    const channels = mixer.getChannels();
    const tracks: TrackData[] = playlist.getTracks().map((track) => {
        const target = track.getTarget();
        let route: TrackData["route"] = null;
        if (target === mixer.getMaster()) route = { to: "master" };
        else if (target && channels.indexOf(target as Channel) !== -1) route = { to: "channel", index: channels.indexOf(target as Channel) };
        return {
            title: track.title,
            color: track.color.color,
            enabled: track.isActive(),
            route,
            clips: track.getSamples().map((sample) => ({
                asset: assetFor(sample),
                startBeat: sample.getStartBeat(),
                name: sample.getName(),
            })),
            ...(track.getPatternClips().length > 0 ? { patternClips: track.getPatternClips().map((c) => ({ ...c })) } : {}),
        };
    });

    // (in pattern mode the transport's loop is the pattern's; the song's own loop is kept aside)
    const loop = globals.beat ? globals.beat.songLoop() : transport.getLoop();
    return {
        format: PROJECT_FORMAT,
        version: CURRENT_VERSION,
        appVersion: options.appVersion,
        name: options.name,
        savedAt: new Date().toISOString(),
        tempo: { points: transport.tempo.getPoints().map((p) => ({ beat: p.beat, bpm: p.bpm })) },
        loop: loop ? { startBeat: loop.startBeat, endBeat: loop.endBeat } : null,
        assets,
        tracks,
        mixer: { master: captureChannel(mixer.getMaster()), channels: channels.map(captureChannel) },
        view: { xsnap: globals.xsnap },
        ...(beatHasContent(globals.beat) ? { beat: captureBeat(globals.beat, assetFor) } : {}),
    };
}

/** a project with nothing in the rack and no patterns is saved without a beat part, as before */
function beatHasContent(beat: Beat | undefined): beat is Beat {
    return !!beat && (beat.instruments.length > 0 || beat.patterns.length > 0);
}

/** the part of a project that is edited by the user, for comparing two states (not the save time or app version) */
export function contentOf(data: ProjectData): unknown {
    const { savedAt, appVersion, ...rest } = data;
    return rest;
}

/** the hook that forgets key switches when the timeline jumps, for the beat of the open project */
let unhookSwitches: (() => void) | null = null;

export interface RestoreResult {
    /** Resolves when every clip's file has been read. Lists the clips whose file could not be read. */
    loaded: Promise<{ missingFiles: string[] }>;
    /** plugins that could not be loaded (their slot and settings are kept) */
    missingPlugins: string[];
}

function applyChannel(channel: Channel, data: ChannelData, plugins: Plugin[]): void {
    channel.setName(data.name);
    channel.setVolume(data.volume, false);
    channel.setPanning(data.panning);
    channel.setActive(data.active, false);
    data.plugins.forEach((p, slot) => {
        if (!p) return;
        const plugin = new Plugin(p.path);
        plugin.setParams(p.params);
        plugin.bypassed = p.bypassed;
        channel.addPlugin(plugin, slot);
        plugins.push(plugin);
    });
}

/**
 * Replaces the live mixer, playlist, tempo and loop with what `data` describes.
 * `data` must have passed validateProject. The caller tells the windows to
 * rebuild afterwards.
 */
export async function restore(data: ProjectData, roots: Roots): Promise<RestoreResult> {
    const engine = globals.engine;
    const ctx = engine.ctx;

    // ---- build the new mixer and playlist next to the old ones
    const mixer = new Mixer(ctx, 0);
    data.mixer.channels.forEach(() => mixer.newChannel());
    const plugins: Plugin[] = [];
    applyChannel(mixer.getMaster(), data.mixer.master, plugins);
    data.mixer.channels.forEach((c, i) => applyChannel(mixer.getChannels()[i], c, plugins));

    const playlist = new Playlist(ctx);
    const samples: Sample[] = [];
    const assets = new Map(data.assets.map((a) => [a.id, a]));
    for (const trackData of data.tracks) {
        const track = playlist.newTrack();
        track.title = trackData.title;
        track.color = new Color(trackData.color);
        track.setActive(trackData.enabled);
        if (trackData.route) {
            track.connect(trackData.route.to === "master" ? mixer.getMaster() : mixer.getChannels()[trackData.route.index]);
        }
        for (const placed of trackData.patternClips ?? []) track.addPatternClip({ ...placed });
        for (const clip of trackData.clips) {
            const asset = assets.get(clip.asset);
            if (!asset) continue; // validateProject makes sure the asset exists
            // A project asset has no place until the project has a folder (recovered work whose folder is gone). The
            // clip is kept, as a clip with a missing file, so that saving does not drop it from the arrangement.
            const absolute = toAbsolute(asset, roots);
            const sample = new Sample({ path: absolute ?? "missing://" + asset.path, title: clip.name });
            if (absolute === null) sample.missingAsset = asset;
            sample.setStartBeat(clip.startBeat);
            track.addSample(sample);
            samples.push(sample);
            if (absolute !== null) {
                const meta: Parameters<AssetBook["remember"]>[1] = { source: asset.source, licence: asset.licence };
                if (asset.credit) meta.credit = asset.credit;
                if (asset.sha256) meta.sha256 = asset.sha256;
                assetBook.remember(absolute, meta);
            }
        }
    }

    // ---- the instruments and patterns, with their files
    const remember = (asset: AssetData, absolute: string) => {
        const meta: Parameters<AssetBook["remember"]>[1] = { source: asset.source, licence: asset.licence };
        if (asset.credit) meta.credit = asset.credit;
        if (asset.sha256) meta.sha256 = asset.sha256;
        assetBook.remember(absolute, meta);
    };
    const { beat, zones } = restoreBeat(data.beat, ctx, engine.transport, mixer, assets, (asset) => toAbsolute(asset, roots), remember);

    // ---- plugins load their code in the background; wait, so that the swap below happens in one go with nothing
    // half-loaded, and the windows are never asked to draw a project they do not have the parts of
    const settled = await Promise.allSettled(plugins.map((p) => p.ready));
    const missingPlugins = plugins.filter((_, i) => settled[i].status === "rejected").map((p) => p.pluginPath);

    // ---- swap them in (nothing may be playing while the project underneath is swapped)
    engine.stop();
    engine.seek(0);
    const old = { mixer: globals.mixer, playlist: globals.playlist, beat: globals.beat };
    globals.mixer = mixer;
    globals.playlist = playlist;
    globals.beat = beat;
    engine.setProvider(new Arrangement(playlist, beat, () => engine.transport.tempo));
    unhookSwitches?.();
    // a key switch is forgotten when the timeline jumps, so that playing from any place sounds the same
    unhookSwitches = engine.notes.onFlush(() => beat.instruments.forEach((i) => (i.switchNote = null)));
    engine.transport.setTempoPoints(data.tempo.points);
    engine.transport.setLoop(data.loop);
    // (these two borrow the transport's loop in pattern mode, so they come after it is set)
    beat.setActivePattern(data.beat?.activePattern ?? null);
    beat.setScope(data.beat?.scope ?? "song");
    globals.xsnap = data.view?.xsnap ?? 20;
    // let anything that was sounding fade out before its nodes go
    if (old.mixer) setTimeout(() => { old.playlist?.dispose(); old.beat?.dispose(); old.mixer.dispose(); }, 250);

    const missing = (file: { path: string; missingAsset?: AssetData | null }) => (file.missingAsset ? file.missingAsset.path + " (the project folder is not known)" : file.path);
    const loaded = Promise.all([...samples.map((s) => s.loaded), ...zones.map((z) => z.loaded)]).then(() => ({
        missingFiles: [...samples.filter((s) => s.hasFailed()), ...zones.filter((z) => z.hasFailed())].map(missing),
    }));
    return { loaded, missingPlugins };
}
