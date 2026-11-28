import { Mixer } from "../core/Mixer";
import { Transport } from "../engine/Transport";
import { Instrument, Zone } from "../instruments/Instrument";
import type { AssetData } from "../project/schema";
import { Beat } from "./Beat";
import { BeatData, clonePattern, InstrumentData, ZoneData } from "./data";

// The beat to project data and back. The files the zones play are assets of the
// project, like the clips', so how an asset is recorded and found is passed in.

/** what is needed of a file for it to be recorded: where it is, or the record to keep when it cannot be found */
export interface FileRef {
    path: string;
    missingAsset?: AssetData | null;
}

export function captureBeat(beat: Beat, assetFor: (file: FileRef) => string): BeatData {
    const instruments: InstrumentData[] = beat.instruments.map((instrument) => {
        const { mode, attack, decay, sustain, release, chokeGroup, keySwitch } = instrument.sampler;
        const sampler: InstrumentData["sampler"] = {
            zones: instrument.zones.map((zone): ZoneData => ({ ...copySettings(zone), asset: assetFor(zone) })),
            mode,
            attack,
            decay,
            sustain,
            release,
            chokeGroup,
        };
        if (keySwitch) sampler.keySwitch = { ...keySwitch };
        return {
            id: instrument.id,
            name: instrument.name,
            color: instrument.color,
            channel: instrument.channel,
            volume: instrument.getVolume(),
            pan: instrument.getPan(),
            muted: instrument.isMuted(),
            sampler,
        };
    });
    return {
        rack: { instruments },
        patterns: beat.patterns.map(clonePattern),
        activePattern: beat.activePatternId,
        scope: beat.scope,
    };
}

function copySettings(zone: Zone): Omit<ZoneData, "asset"> {
    const s = zone.settings;
    const copy = { ...s, loop: s.loop ? { ...s.loop } : null };
    if (s.env) copy.env = { ...s.env };
    return copy;
}

export interface BeatRestore {
    beat: Beat;
    /** every zone that was made, to wait for their files and to report the ones that could not be read */
    zones: Zone[];
}

/**
 * Builds the beat a project describes. `resolve` finds the file of an asset: its absolute path, or null when it cannot
 * be placed (a project folder that is not known); `found` is told about each file that was placed.
 */
export function restoreBeat(
    data: BeatData | undefined,
    ctx: BaseAudioContext,
    transport: Transport,
    mixer: Mixer,
    assets: ReadonlyMap<string, AssetData>,
    resolve: (asset: AssetData) => string | null,
    found: (asset: AssetData, absolute: string) => void,
): BeatRestore {
    const beat = new Beat(ctx, transport);
    const zones: Zone[] = [];
    if (!data) return { beat, zones };
    for (const d of data.rack.instruments) {
        const { zones: zoneData, ...settings } = d.sampler;
        const instrument = new Instrument(ctx, d.id, d.name, d.color, settings);
        instrument.channel = d.channel;
        instrument.setVolume(d.volume, false);
        instrument.setPan(d.pan);
        instrument.setMuted(d.muted, false);
        for (const z of zoneData) {
            const asset = assets.get(z.asset);
            if (!asset) continue; // validateProject makes sure the asset exists
            const { asset: _asset, ...zoneSettings } = z;
            void _asset;
            const absolute = resolve(asset);
            // like a clip whose file cannot be placed: the zone is kept, silent, with the record it came with
            const zone = new Zone(zoneSettings, absolute ?? "missing://" + asset.path, absolute !== null);
            if (absolute === null) {
                zone.missingAsset = asset;
                zone.loadError = new Error("the project folder is not known");
            } else {
                found(asset, absolute);
            }
            instrument.addZone(zone);
            zones.push(zone);
        }
        beat.instruments.push(instrument);
    }
    beat.patterns = data.patterns.map(clonePattern);
    beat.connectAll(mixer);
    return { beat, zones };
}
