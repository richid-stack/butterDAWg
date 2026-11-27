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
import { Color } from "../ui/misc/Color";
import {
    AssetBook,
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
    const assetFor = (absolute: string): string => {
        const known = idByPath.get(absolute);
        if (known) return known;
        const { location, path } = classify(absolute, roots);
        const meta = assetBook.get(absolute) ?? defaultMeta(absolute, roots, manifest);
        const id = "a" + (assets.length + 1);
        const asset: AssetData = { id, location, path, name: baseName(absolute), source: meta.source, licence: meta.licence };
        if (meta.sha256) asset.sha256 = meta.sha256;
        if (meta.credit) asset.credit = meta.credit;
        assets.push(asset);
        idByPath.set(absolute, id);
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
                asset: assetFor(sample.path),
                startBeat: sample.getStartBeat(),
                name: sample.getName(),
            })),
        };
    });

    const loop = transport.getLoop();
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
    };
}

/** the part of a project that is edited by the user, for comparing two states (not the save time or app version) */
export function contentOf(data: ProjectData): unknown {
    const { savedAt, appVersion, ...rest } = data;
    return rest;
}

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

    // nothing may be playing while the project underneath is swapped
    engine.stop();
    engine.seek(0);

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
        for (const clip of trackData.clips) {
            const asset = assets.get(clip.asset);
            const absolute = asset ? toAbsolute(asset, roots) : null;
            if (!asset || absolute === null) continue; // validateProject makes sure the asset exists; a project asset needs the project folder
            const sample = new Sample({ path: absolute, title: clip.name });
            sample.setStartBeat(clip.startBeat);
            track.addSample(sample);
            samples.push(sample);
            const meta: Parameters<AssetBook["remember"]>[1] = { source: asset.source, licence: asset.licence };
            if (asset.credit) meta.credit = asset.credit;
            if (asset.sha256) meta.sha256 = asset.sha256;
            assetBook.remember(absolute, meta);
        }
    }

    // ---- swap them in
    const old = { mixer: globals.mixer, playlist: globals.playlist };
    globals.mixer = mixer;
    globals.playlist = playlist;
    engine.setProvider(playlist);
    engine.transport.setTempoPoints(data.tempo.points);
    engine.transport.setLoop(data.loop);
    globals.xsnap = data.view?.xsnap ?? 20;
    // let anything that was sounding fade out before its nodes go
    if (old.mixer) setTimeout(() => { old.playlist?.dispose(); old.mixer.dispose(); }, 250);

    // ---- plugins load their code in the background; wait so the project is complete when this returns
    const settled = await Promise.allSettled(plugins.map((p) => p.ready));
    const missingPlugins = plugins.filter((_, i) => settled[i].status === "rejected").map((p) => p.pluginPath);

    const loaded = Promise.all(samples.map((s) => s.loaded)).then(() => ({
        missingFiles: samples.filter((s) => s.hasFailed()).map((s) => s.path),
    }));
    return { loaded, missingPlugins };
}
