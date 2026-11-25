import { test } from "node:test";
import assert from "node:assert/strict";
import { TempoMap } from "../src/engine/TempoMap";
import { Transport } from "../src/engine/Transport";
import { Scheduler, SchedulableClip, StartEvent } from "../src/engine/Scheduler";
import { FakeClock } from "./helpers";

const close = (a: number, b: number, eps = 1e-9) =>
    assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

test("tempo map: constant tempo converts beats and seconds both ways", () => {
    const t = new TempoMap(120);
    close(t.secondsAt(1), 0.5);
    close(t.secondsAt(8), 4);
    close(t.beatAt(4), 8);
    close(t.secondsBetween(2, 10), 4);
    close(t.advance(3, 1.5), 6);
    close(t.secondsAt(-2), -1); // before the start the first tempo continues
});

test("tempo map: tempo changes are honoured in both directions", () => {
    const t = new TempoMap(120);
    t.setPoints([
        { beat: 0, bpm: 120 },
        { beat: 8, bpm: 60 },
        { beat: 12, bpm: 240 },
    ]);
    close(t.secondsAt(8), 4); // 8 beats at 120 bpm
    close(t.secondsAt(12), 8); // + 4 beats at 60 bpm
    close(t.secondsAt(16), 9); // + 4 beats at 240 bpm
    for (const beat of [0, 3.3, 8, 9.9, 12, 15.25, 40]) {
        close(t.beatAt(t.secondsAt(beat)), beat);
    }
    assert.equal(t.bpmAt(7.99), 120);
    assert.equal(t.bpmAt(8), 60);
});

test("tempo map: odd input is tidied up", () => {
    const t = new TempoMap();
    t.setPoints([
        { beat: 4, bpm: 90 },
        { beat: 4, bpm: 100 },
        { beat: 0, bpm: 5000 },
    ]);
    assert.equal(t.bpmAt(0), 999); // clamped
    assert.equal(t.bpmAt(4), 100); // later point at the same beat wins
    assert.throws(() => t.setPoints([]));
});

test("transport: position follows the clock, pauses and seeks", () => {
    const clock = new FakeClock();
    const tr = new Transport(clock, new TempoMap(120));
    assert.equal(tr.state, "stopped");
    clock.time = 10;
    tr.play();
    clock.time = 12; // 2 s at 120 bpm = 4 beats
    close(tr.position, 4);
    tr.pause();
    clock.time = 20;
    close(tr.position, 4); // held
    tr.play();
    clock.time = 21;
    close(tr.position, 6);
    tr.seek(1);
    close(tr.position, 1);
    clock.time = 22;
    close(tr.position, 3);
    tr.stop();
    close(tr.position, 1); // back to where it was seeked to
});

test("transport: playAt starts at an exact clock time, whatever the clock says now", () => {
    const clock = new FakeClock();
    const tr = new Transport(clock, new TempoMap(120));
    clock.time = 10.123;
    tr.playAt(11);
    close(tr.position, 0); // waits at the start until the start time comes
    clock.time = 12;
    close(tr.position, 2); // one second after the start
    tr.stop();
    close(tr.position, 0);
});

test("transport: a tempo change mid-playback does not move the position", () => {
    const clock = new FakeClock();
    const tr = new Transport(clock, new TempoMap(120));
    tr.play();
    clock.time = 2; // beat 4
    tr.setBpm(60);
    close(tr.position, 4);
    clock.time = 4; // 2 s at 60 bpm = 2 more beats
    close(tr.position, 6);
});

test("transport: loop wraps the position", () => {
    const clock = new FakeClock();
    const tr = new Transport(clock, new TempoMap(120));
    tr.setLoop({ startBeat: 4, endBeat: 8 });
    tr.seek(2);
    tr.play();
    clock.time = 1; // beat 4
    close(tr.position, 4);
    clock.time = 2.5; // beat 7
    close(tr.position, 7);
    clock.time = 3; // beat 8 wraps to 4
    close(tr.position, 4);
    clock.time = 3 + 2 * 3.5 + 0.25; // three and a half loops later
    close(tr.position, 4 + ((3.5 * 2 + 0.25) % 2) * 2);
    assert.throws(() => tr.setLoop({ startBeat: 4, endBeat: 4 }));
});

// ---- scheduler ----------------------------------------------------------

interface TestClip extends SchedulableClip {
    id: string;
}

function setup(clips: TestClip[], bpm = 120) {
    const clock = new FakeClock();
    const tr = new Transport(clock, new TempoMap(bpm));
    const events: StartEvent<TestClip>[] = [];
    let flushes = 0;
    let pendingFlushes = 0;
    const sched = new Scheduler<TestClip>(
        tr,
        clock,
        { getClips: () => clips },
        { start: (e) => events.push(e), flush: () => flushes++, flushPending: () => pendingFlushes++ },
        { lookahead: 0.1 },
    );
    return { clock, tr, sched, events, flushes: () => flushes, pendingFlushes: () => pendingFlushes };
}

test("scheduler: clips get exact start times regardless of how late ticks are", () => {
    const clips: TestClip[] = [0, 1, 2, 3, 4].map((b) => ({ id: "c" + b, startBeat: b * 4, durationSeconds: 0.2 }));
    // reference run: tick every 10 ms
    const a = setup(clips);
    a.clock.time = 5;
    a.tr.play();
    for (let i = 0; i < 1100; i++) {
        a.clock.time = 5 + i * 0.01;
        a.sched.tick();
    }
    // jittery run: irregular gaps, never longer than the look-ahead
    const b = setup(clips);
    b.clock.time = 5;
    b.tr.play();
    let t = 5;
    let seed = 7;
    while (t < 16) {
        seed = (seed * 16807) % 2147483647;
        t += 0.005 + (seed / 2147483647) * 0.09;
        b.clock.time = t;
        b.sched.tick();
    }
    assert.equal(a.events.length, 5);
    assert.deepEqual(
        b.events.map((e) => [e.clip.id, e.when]),
        a.events.map((e) => [e.clip.id, e.when]),
    );
    // beat 4 at 120 bpm is 2 s after the start at clock time 5
    close(a.events[1].when, 5 + 2);
});

test("scheduler: a five-minute loop has no drift", () => {
    // one clip every beat for 8 beats, looped for 300 s of audio-clock time
    const clips: TestClip[] = Array.from({ length: 8 }, (_, b) => ({ id: "b" + b, startBeat: b, durationSeconds: 0.1 }));
    const { clock, tr, sched, events } = setup(clips, 120);
    tr.setLoop({ startBeat: 0, endBeat: 8 });
    clock.time = 0;
    tr.play();
    const rng = (() => {
        let s = 99;
        return () => (s = (s * 16807) % 2147483647) / 2147483647;
    })();
    let t = 0;
    while (t < 300) {
        t += 0.01 + rng() * 0.08; // timer jitter
        clock.time = t;
        sched.tick();
    }
    assert.ok(events.length >= 8 * (300 / 4) - 8, "scheduled " + events.length);
    // every start lands on exactly (loop number * 4 s + beat * 0.5 s)
    let worst = 0;
    events.forEach((e, i) => {
        const loopNo = Math.floor(i / 8);
        const beat = i % 8;
        worst = Math.max(worst, Math.abs(e.when - (loopNo * 4 + beat * 0.5)));
        assert.equal(e.clip.id, "b" + beat, "order at event " + i);
    });
    assert.ok(worst < 1e-9, "worst error " + worst + " s");
});

test("scheduler: starting in the middle of a clip plays the rest of it", () => {
    const clips: TestClip[] = [{ id: "long", startBeat: 0, durationSeconds: 4 }];
    const { clock, tr, sched, events } = setup(clips);
    tr.seek(2); // 1 s into a 4 s clip
    clock.time = 10;
    tr.play();
    sched.tick();
    assert.equal(events.length, 1);
    close(events[0].offset, 1);
    close(events[0].when, 10);
    // a clip that has already finished is not started
    const done = setup([{ id: "short", startBeat: 0, durationSeconds: 0.5 }]);
    done.tr.seek(2);
    done.clock.time = 10;
    done.tr.play();
    done.sched.tick();
    assert.equal(done.events.length, 0);
});

test("scheduler: clips that run past the loop end are cut at the loop end", () => {
    const clips: TestClip[] = [{ id: "pad", startBeat: 0, durationSeconds: 10 }];
    const { clock, tr, sched, events } = setup(clips);
    tr.setLoop({ startBeat: 0, endBeat: 4 }); // 2 s long
    clock.time = 0;
    tr.play();
    for (let t = 0; t <= 4.5; t += 0.05) {
        clock.time = t;
        sched.tick();
    }
    assert.ok(events.length >= 2);
    close(events[0].when, 0);
    close(events[0].stopAt, 2);
    close(events[1].when, 2); // restarts at the top of the loop
});

test("scheduler: seeking flushes everything and a tempo change re-times what comes next", () => {
    const clips: TestClip[] = [{ id: "k", startBeat: 8, durationSeconds: 0.1 }];
    const { clock, tr, sched, events, flushes, pendingFlushes } = setup(clips);
    clock.time = 0;
    tr.play();
    sched.tick();
    const before = pendingFlushes();
    const flushesBefore = flushes();
    clock.time = 3.95; // beat 7.9, the clip is 0.05 s away: scheduled
    sched.tick();
    assert.equal(events.length, 1);
    close(events[0].when, 4);
    tr.setBpm(60); // beat 8 is now one more second away
    sched.tick();
    // only what had not started yet was dropped; nothing that is sounding was touched
    assert.equal(pendingFlushes(), before + 1);
    assert.equal(flushes(), flushesBefore);
    clock.time = 4.0;
    sched.tick();
    clock.time = 5.0;
    sched.tick();
    const last = events[events.length - 1];
    close(last.when, 3.95 + (8 - 7.9) * 1, 1e-9); // 0.1 beat at 60 bpm = 0.1 s
});

test("scheduler: a tempo change while a clip is sounding does not restart it", () => {
    // a ten-second clip from beat 0; at beat 4 (2 s in at 120 bpm) the tempo halves
    const clips: TestClip[] = [
        { id: "long", startBeat: 0, durationSeconds: 10 },
        { id: "next", startBeat: 8, durationSeconds: 0.1 },
    ];
    const { clock, tr, sched, events, flushes, pendingFlushes } = setup(clips);
    clock.time = 0;
    tr.play();
    sched.tick();
    assert.equal(events.length, 1);
    close(events[0].when, 0);
    clock.time = 2; // beat 4
    sched.tick();
    tr.setBpm(60);
    sched.tick();
    clock.time = 3.95;
    sched.tick();
    // the long clip was not started again (not at the wrong offset either)...
    assert.equal(events.filter((e) => e.clip.id === "long").length, 1);
    assert.equal(flushes(), 1); // only the flush when playing started
    assert.ok(pendingFlushes() >= 1);
    // ...and the next clip comes where the new tempo puts it: 4 beats after beat 4 at 60 bpm
    clock.time = 6.05;
    sched.tick();
    const next = events.find((e) => e.clip.id === "next");
    assert.ok(next);
    close(next.when, 2 + 4, 1e-9);
});

test("scheduler: seeking while a clip sounds starts it part-way in at the real position", () => {
    const clips: TestClip[] = [{ id: "long", startBeat: 0, durationSeconds: 10 }];
    const { clock, tr, sched, events } = setup(clips);
    clock.time = 0;
    tr.play();
    sched.tick();
    clock.time = 1;
    tr.seek(6); // 3 s into the clip at 120 bpm
    sched.tick();
    const last = events[events.length - 1];
    close(last.offset, 3);
    close(last.when, 1);
});
