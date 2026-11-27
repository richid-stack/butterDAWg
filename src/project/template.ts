// What a new project starts as. It is project data like any other, so "New"
// goes through the same code as "Open".

import { emptyChannel, newProjectData, ProjectData, TrackData } from "./schema";

export const DEFAULT_TRACKS = 15;
export const DEFAULT_CHANNELS = 5;
export const DEFAULT_BPM = 150;
const DEFAULT_TRACK_COLOUR = "#646e73";

export function defaultProjectData(appVersion: string, name = "Untitled"): ProjectData {
    const data = newProjectData(appVersion, name);
    data.tempo = { points: [{ beat: 0, bpm: DEFAULT_BPM }] };
    data.mixer.channels = Array.from({ length: DEFAULT_CHANNELS }, (_, i) => emptyChannel("Channel " + i));
    data.tracks = Array.from({ length: DEFAULT_TRACKS }, (_, i): TrackData => ({
        title: "Track " + i,
        color: DEFAULT_TRACK_COLOUR,
        enabled: true,
        // as before: the first track plays into the first channel; the others are not routed until the user routes them
        route: i === 0 ? { to: "channel", index: 0 } : null,
        clips: [],
    }));
    data.view = { xsnap: 20 };
    return data;
}
