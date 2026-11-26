import { test } from "node:test";
import assert from "node:assert/strict";
import {
    CURRENT_VERSION,
    PROJECT_FORMAT,
    PLUGIN_SLOTS,
    ProjectData,
    ProjectError,
    emptyChannel,
    isSafeRelativePath,
    migrateProject,
    newProjectData,
    parseProject,
    serializeProject,
} from "../src/project/schema";

function sample(): ProjectData {
    const p = newProjectData("1.0.0", "My beat");
    p.savedAt = "2026-11-26T10:00:00.000Z";
    p.tempo.points = [
        { beat: 0, bpm: 140 },
        { beat: 32, bpm: 150.5 },
    ];
    p.loop = { startBeat: 0, endBeat: 16 };
    p.assets = [
        { id: "a1", location: "app", path: "files/samples/kick1.wav", name: "kick1.wav", source: { kind: "library" }, licence: "CC0" },
        {
            id: "a2", location: "project", path: "assets/chop.wav", name: "chop.wav", sha256: "a".repeat(64),
            source: { kind: "chopped", parent: "a1", startSeconds: 0.5, endSeconds: 1.25 }, licence: null, credit: "someone",
        },
        { id: "a3", location: "external", path: "/home/me/kits/snare.wav", name: "snare.wav", source: { kind: "imported", from: "kit" }, licence: "own" },
    ];
    const ch = emptyChannel("Drums");
    ch.volume = 0.8;
    ch.panning = 1.25;
    ch.plugins[2] = { path: "plugins/Gain.bdp", bypassed: true, params: { level: 0.375 } };
    p.mixer.channels = [ch, emptyChannel("Bass")];
    p.tracks = [
        { title: "Kick", color: "#d96a5c", enabled: true, route: { to: "channel", index: 0 }, clips: [{ asset: "a1", startBeat: 0, name: "kick1.wav" }, { asset: "a1", startBeat: 3.5, name: "kick1.wav" }] },
        { title: "Muted", color: "#646e73", enabled: false, route: { to: "master" }, clips: [] },
        { title: "Nowhere", color: "#646e73", enabled: true, route: null, clips: [] },
    ];
    p.view = { xsnap: 40 };
    return p;
}

function rejects(mutate: (p: any) => void, message: RegExp) {
    const p: any = sample();
    mutate(p);
    assert.throws(() => parseProject(JSON.stringify(p)), (e: any) => e instanceof ProjectError && message.test(e.message), String(message));
}

test("project: a project survives save and load exactly", () => {
    const p = sample();
    assert.deepEqual(parseProject(serializeProject(p)), p);
});

test("project: numbers keep every digit through the file", () => {
    const p = sample();
    p.tempo.points[1].bpm = 150.123456789012;
    p.tracks[0].clips[1].startBeat = 3.3333333333333335;
    const back = parseProject(serializeProject(p));
    assert.equal(back.tempo.points[1].bpm, 150.123456789012);
    assert.equal(back.tracks[0].clips[1].startBeat, 3.3333333333333335);
});

test("project: a new project is valid and empty", () => {
    const p = newProjectData("1.0.0");
    assert.doesNotThrow(() => serializeProject(p));
    assert.equal(p.version, CURRENT_VERSION);
    assert.equal(p.mixer.master.plugins.length, PLUGIN_SLOTS);
});

test("project: damaged and foreign files are refused with a message", () => {
    assert.throws(() => parseProject("{not json"), /damaged/);
    assert.throws(() => parseProject("[]"), /not a butterDAWg project/);
    assert.throws(() => parseProject(JSON.stringify({ format: "something-else", version: 1 })), /not a butterDAWg project/);
    assert.throws(() => parseProject(JSON.stringify({ format: PROJECT_FORMAT })), /version/);
    assert.throws(() => parseProject(JSON.stringify({ format: PROJECT_FORMAT, version: 1.5 })), /version/);
});

test("project: a file from a newer app is refused, not half-read", () => {
    const p: any = sample();
    p.version = CURRENT_VERSION + 1;
    assert.throws(() => parseProject(JSON.stringify(p)), /newer butterDAWg/);
});

test("project: bad values are named by where they are", () => {
    rejects((p) => (p.mixer.channels[0].volume = 9), /mixer\.channels\[0\]\.volume/);
    rejects((p) => (p.mixer.channels[0].volume = null), /volume: must be a number/);
    rejects((p) => (p.mixer.master.panning = 2), /mixer\.master\.panning/);
    rejects((p) => (p.tracks[0].color = "red"), /tracks\[0\]\.color/);
    rejects((p) => (p.tracks[0].clips[0].startBeat = -1), /startBeat/);
    rejects((p) => (p.tracks[0].clips[0].asset = "nope"), /"nope" is not an asset/);
    rejects((p) => (p.tracks[0].route = { to: "channel", index: 5 }), /there is no channel 5/);
    rejects((p) => (p.tracks[0].route = { to: "somewhere" }), /unknown destination/);
    rejects((p) => (p.loop = { startBeat: 8, endBeat: 8 }), /end after it starts/);
    rejects((p) => (p.tempo.points = []), /at least one tempo/);
    rejects((p) => (p.tempo.points[0].beat = 4), /first tempo must be at beat 0/);
    rejects((p) => (p.tempo.points[1].beat = 0), /in order/);
    rejects((p) => (p.tempo.points[0].bpm = 0), /bpm/);
    rejects((p) => (p.assets[1].id = "a1"), /used by two assets/);
    rejects((p) => (p.assets[1].source.parent = "missing"), /not an asset of this project/);
    rejects((p) => (p.assets[0].sha256 = "xyz"), /64 hex/);
    rejects((p) => (p.assets[0].source.kind = "stolen"), /unknown source/);
    rejects((p) => p.mixer.channels[0].plugins.push(null), /at most 10 slots/);
    rejects((p) => (p.mixer.channels[0].plugins[2].params.level = "loud"), /params\.level/);
});

test("project: paths cannot leave their folder", () => {
    assert.ok(isSafeRelativePath("assets/kick.wav"));
    assert.ok(!isSafeRelativePath("../secret.wav"));
    assert.ok(!isSafeRelativePath("assets/../../secret.wav"));
    assert.ok(!isSafeRelativePath("/etc/passwd"));
    assert.ok(!isSafeRelativePath("C:\\Windows\\x.wav"));
    assert.ok(!isSafeRelativePath("assets//x.wav"));
    assert.ok(!isSafeRelativePath(""));
    rejects((p) => (p.assets[0].path = "files/../../etc/passwd"), /inside the app folder/);
    rejects((p) => (p.assets[1].path = "elsewhere/chop.wav"), /assets folder/);
    rejects((p) => (p.assets[1].path = "assets/../../chop.wav"), /inside the project folder/);
    rejects((p) => (p.mixer.channels[0].plugins[2].path = "/tmp/evil.bdp"), /plugins folder/);
    rejects((p) => (p.mixer.channels[0].plugins[2].path = "plugins/../main.js"), /plugins folder/);
});

test("project: old files are upgraded one version at a time", () => {
    // a pretend history: version 1 had "tempo": 140; version 2 made it "bpm"; version 3 renamed it "tempoBpm"
    const migrations = [
        (raw: any) => { raw.bpm = raw.tempo; delete raw.tempo; return raw; },
        (raw: any) => { raw.tempoBpm = raw.bpm; delete raw.bpm; return raw; },
    ];
    const old = { format: PROJECT_FORMAT, version: 1, tempo: 140 };
    const result = migrateProject(old, migrations, 3);
    assert.deepEqual(result, { format: PROJECT_FORMAT, version: 3, tempoBpm: 140 });
    assert.deepEqual(old, { format: PROJECT_FORMAT, version: 1, tempo: 140 }, "the original is not touched");
    // starting part-way
    assert.deepEqual(migrateProject({ format: PROJECT_FORMAT, version: 2, bpm: 90 }, migrations, 3), { format: PROJECT_FORMAT, version: 3, tempoBpm: 90 });
    // a missing step is reported
    assert.throws(() => migrateProject({ format: PROJECT_FORMAT, version: 1 }, [], 2), /no way to upgrade/);
});
