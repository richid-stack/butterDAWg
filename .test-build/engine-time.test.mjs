// test/engine-time.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// src/engine/TempoMap.ts
var MIN_BPM = 1;
var MAX_BPM = 999;
var TempoMap = class _TempoMap {
  points = [];
  // seconds from beat 0 to each point; always as long as `points`
  startSeconds = [];
  constructor(bpm = 120) {
    this.setPoints([{ beat: 0, bpm }]);
  }
  /** the tempo at the start of the project */
  get bpm() {
    return this.points[0].bpm;
  }
  getPoints() {
    return this.points;
  }
  /** one constant tempo for the whole project */
  setBpm(bpm) {
    this.setPoints([{ beat: 0, bpm }]);
  }
  /**
   * Replaces the whole map. Points are sorted by beat; the first one is moved
   * to beat 0 so every beat has a tempo.
   */
  setPoints(points) {
    if (points.length === 0) {
      throw new Error("a tempo map needs at least one point");
    }
    const sorted = points.map((p) => ({ beat: p.beat, bpm: clampBpm(p.bpm) })).sort((a, b) => a.beat - b.beat);
    sorted[0].beat = 0;
    this.points = sorted.filter((p, i) => i === sorted.length - 1 || sorted[i + 1].beat !== p.beat);
    this.startSeconds = [0];
    for (let i = 1; i < this.points.length; i++) {
      const prev = this.points[i - 1];
      this.startSeconds.push(
        this.startSeconds[i - 1] + (this.points[i].beat - prev.beat) * 60 / prev.bpm
      );
    }
  }
  bpmAt(beat) {
    return this.points[this.indexForBeat(beat)].bpm;
  }
  /** seconds from beat 0 to `beat` (negative beats extend the first tempo backwards) */
  secondsAt(beat) {
    const i = this.indexForBeat(beat);
    const p = this.points[i];
    return this.startSeconds[i] + (beat - p.beat) * 60 / p.bpm;
  }
  /** the beat that is `seconds` after beat 0 */
  beatAt(seconds) {
    const i = this.indexForSeconds(seconds);
    const p = this.points[i];
    return p.beat + (seconds - this.startSeconds[i]) * p.bpm / 60;
  }
  /** how long it takes to play from beat `a` to beat `b` */
  secondsBetween(a, b) {
    return this.secondsAt(b) - this.secondsAt(a);
  }
  /** the beat reached `seconds` after starting from `beat` */
  advance(beat, seconds) {
    return this.beatAt(this.secondsAt(beat) + seconds);
  }
  copy() {
    const t = new _TempoMap();
    t.setPoints(this.points);
    return t;
  }
  indexForBeat(beat) {
    let lo = 0;
    let hi = this.points.length - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (this.points[mid].beat <= beat) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  indexForSeconds(seconds) {
    let lo = 0;
    let hi = this.startSeconds.length - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (this.startSeconds[mid] <= seconds) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
};
function clampBpm(bpm) {
  if (!Number.isFinite(bpm)) return 120;
  return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
}

// src/engine/Transport.ts
var Transport = class {
  tempo;
  clock;
  _state = "stopped";
  anchorBeat = 0;
  anchorTime = 0;
  restBeat = 0;
  // where playback starts from, and where it rests when not playing
  returnBeat = 0;
  // where stop() puts the position back to
  loop = null;
  _version = 0;
  listeners = {
    state: /* @__PURE__ */ new Set(),
    timeline: /* @__PURE__ */ new Set()
  };
  constructor(clock, tempo = new TempoMap()) {
    this.clock = clock;
    this.tempo = tempo;
  }
  get state() {
    return this._state;
  }
  get isPlaying() {
    return this._state === "playing";
  }
  /**
   * Goes up every time the timeline jumps or changes speed (play, pause, seek,
   * tempo change, loop change). The scheduler restarts its look-ahead when it
   * sees a new number.
   */
  get version() {
    return this._version;
  }
  /** the position now, in beats */
  get position() {
    return this.positionAt(this.clock.now());
  }
  /**
   * The position at a clock time, in beats. While playing, a loop region
   * brings the position back to its start every time it passes its end.
   */
  positionAt(time) {
    if (this._state !== "playing") return this.restBeat;
    const elapsed = Math.max(0, time - this.anchorTime);
    const loop = this.loopAfter(this.anchorBeat);
    if (!loop) return this.tempo.advance(this.anchorBeat, elapsed);
    const firstPass = this.tempo.secondsBetween(this.anchorBeat, loop.endBeat);
    if (elapsed < firstPass) return this.tempo.advance(this.anchorBeat, elapsed);
    const period = this.tempo.secondsBetween(loop.startBeat, loop.endBeat);
    return this.tempo.advance(loop.startBeat, (elapsed - firstPass) % period);
  }
  /** the anchor the scheduler walks forward from: at `time` the position was `beat` */
  get anchor() {
    return { beat: this.anchorBeat, time: this.anchorTime };
  }
  getLoop() {
    return this.loop ? { ...this.loop } : null;
  }
  /** Starts playing from the current position, `delay` seconds from now. */
  play(delay = 0) {
    if (this._state === "playing") return;
    if (this._state === "stopped") this.returnBeat = this.restBeat;
    this.anchorBeat = this.restBeat;
    this.anchorTime = this.clock.now() + delay;
    this._state = "playing";
    this.changed(true);
  }
  /** Stops playing and keeps the position. */
  pause() {
    if (this._state !== "playing") return;
    this.restBeat = this.position;
    this._state = "paused";
    this.changed(true);
  }
  /** Stops playing and goes back to where playing last started from. */
  stop() {
    this._state = "stopped";
    this.restBeat = this.returnBeat;
    this.changed(true);
  }
  /** Moves to a beat; keeps playing if it was playing. */
  seek(beat) {
    const target = Math.max(0, beat);
    this.restBeat = target;
    this.returnBeat = target;
    if (this._state === "playing") {
      this.anchorBeat = target;
      this.anchorTime = this.clock.now();
    }
    this.changed(false);
  }
  /** Sets (or with `null` clears) the loop region, in beats. */
  setLoop(region) {
    if (region && !(region.endBeat > region.startBeat)) {
      throw new Error("a loop region must end after it starts");
    }
    this.reanchor();
    this.loop = region ? { startBeat: region.startBeat, endBeat: region.endBeat } : null;
    this.changed(false);
  }
  /** A constant tempo from now on, without moving the music that is playing. */
  setBpm(bpm) {
    this.reanchor();
    this.tempo.setBpm(bpm);
    this.changed(false);
  }
  /** Replaces the tempo map without moving the music that is playing. */
  setTempoPoints(points) {
    this.reanchor();
    this.tempo.setPoints(points);
    this.changed(false);
  }
  on(event, callback) {
    this.listeners[event].add(callback);
    return () => this.listeners[event].delete(callback);
  }
  // The anchor is only valid for the tempo map and loop it was made with, so
  // before either changes, anchor again at the current position.
  reanchor() {
    if (this._state !== "playing") return;
    const now = this.clock.now();
    this.anchorBeat = this.positionAt(now);
    this.anchorTime = now;
  }
  // the loop only applies if playback starts before its end
  loopAfter(beat) {
    return this.loop && beat < this.loop.endBeat ? this.loop : null;
  }
  changed(stateChanged) {
    this._version++;
    if (stateChanged) this.listeners.state.forEach((cb) => cb());
    this.listeners.timeline.forEach((cb) => cb());
  }
};

// src/engine/Scheduler.ts
var Scheduler = class {
  lookahead;
  intervalMs;
  transport;
  clock;
  provider;
  host;
  timer = null;
  // the part of the timeline already handed out: everything before
  // (cursorBeat at cursorTime) has been scheduled
  seenVersion = -1;
  cursorBeat = 0;
  cursorTime = 0;
  // true right after playing starts, a seek or a loop wrap, when clips that
  // are already under way have to be started part-way in
  jumped = true;
  constructor(transport, clock, provider, host, options = {}) {
    this.transport = transport;
    this.clock = clock;
    this.provider = provider;
    this.host = host;
    this.lookahead = options.lookahead ?? 0.15;
    this.intervalMs = options.intervalMs ?? 25;
  }
  /** Runs tick() on a timer. */
  start() {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }
  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
  /**
   * Schedules everything that starts between the end of the previous tick and
   * `now + lookahead`. Safe to call as often or as late as you like.
   */
  tick() {
    if (this.transport.version !== this.seenVersion) {
      this.seenVersion = this.transport.version;
      this.host.flush();
      if (!this.transport.isPlaying) return;
      const anchor = this.transport.anchor;
      this.cursorBeat = anchor.beat;
      this.cursorTime = anchor.time;
      this.jumped = true;
    }
    if (!this.transport.isPlaying) return;
    const tempo = this.transport.tempo;
    const horizon = this.clock.now() + this.lookahead;
    for (let pass = 0; this.cursorTime < horizon && pass < 1e3; pass++) {
      const loop = this.transport.getLoop();
      let segEndTime = horizon;
      let segEndBeat = tempo.advance(this.cursorBeat, horizon - this.cursorTime);
      let wraps = false;
      if (loop && this.cursorBeat < loop.endBeat && segEndBeat >= loop.endBeat) {
        segEndBeat = loop.endBeat;
        segEndTime = this.cursorTime + tempo.secondsBetween(this.cursorBeat, loop.endBeat);
        wraps = true;
      }
      const loopEndTime = loop && this.cursorBeat < loop.endBeat ? this.cursorTime + tempo.secondsBetween(this.cursorBeat, loop.endBeat) : null;
      for (const clip of this.provider.getClips()) {
        const start = clip.startBeat;
        let when;
        let offset;
        if (start >= this.cursorBeat && start < segEndBeat) {
          when = this.cursorTime + tempo.secondsBetween(this.cursorBeat, start);
          offset = 0;
        } else if (this.jumped && start < this.cursorBeat) {
          offset = tempo.secondsBetween(start, this.cursorBeat);
          if (offset >= clip.durationSeconds) continue;
          when = this.cursorTime;
        } else {
          continue;
        }
        const endsAt = when + (clip.durationSeconds - offset);
        this.host.start({
          clip,
          when,
          offset,
          stopAt: loopEndTime !== null && endsAt > loopEndTime ? loopEndTime : null
        });
      }
      this.jumped = false;
      this.cursorBeat = segEndBeat;
      this.cursorTime = segEndTime;
      if (wraps && loop) {
        this.cursorBeat = loop.startBeat;
        this.jumped = true;
      }
    }
  }
};

// test/helpers.ts
var FakeClock = class {
  time = 0;
  now() {
    return this.time;
  }
};

// test/engine-time.test.ts
var close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);
test("tempo map: constant tempo converts beats and seconds both ways", () => {
  const t = new TempoMap(120);
  close(t.secondsAt(1), 0.5);
  close(t.secondsAt(8), 4);
  close(t.beatAt(4), 8);
  close(t.secondsBetween(2, 10), 4);
  close(t.advance(3, 1.5), 6);
  close(t.secondsAt(-2), -1);
});
test("tempo map: tempo changes are honoured in both directions", () => {
  const t = new TempoMap(120);
  t.setPoints([
    { beat: 0, bpm: 120 },
    { beat: 8, bpm: 60 },
    { beat: 12, bpm: 240 }
  ]);
  close(t.secondsAt(8), 4);
  close(t.secondsAt(12), 8);
  close(t.secondsAt(16), 9);
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
    { beat: 0, bpm: 5e3 }
  ]);
  assert.equal(t.bpmAt(0), 999);
  assert.equal(t.bpmAt(4), 100);
  assert.throws(() => t.setPoints([]));
});
test("transport: position follows the clock, pauses and seeks", () => {
  const clock = new FakeClock();
  const tr = new Transport(clock, new TempoMap(120));
  assert.equal(tr.state, "stopped");
  clock.time = 10;
  tr.play();
  clock.time = 12;
  close(tr.position, 4);
  tr.pause();
  clock.time = 20;
  close(tr.position, 4);
  tr.play();
  clock.time = 21;
  close(tr.position, 6);
  tr.seek(1);
  close(tr.position, 1);
  clock.time = 22;
  close(tr.position, 3);
  tr.stop();
  close(tr.position, 1);
});
test("transport: a tempo change mid-playback does not move the position", () => {
  const clock = new FakeClock();
  const tr = new Transport(clock, new TempoMap(120));
  tr.play();
  clock.time = 2;
  tr.setBpm(60);
  close(tr.position, 4);
  clock.time = 4;
  close(tr.position, 6);
});
test("transport: loop wraps the position", () => {
  const clock = new FakeClock();
  const tr = new Transport(clock, new TempoMap(120));
  tr.setLoop({ startBeat: 4, endBeat: 8 });
  tr.seek(2);
  tr.play();
  clock.time = 1;
  close(tr.position, 4);
  clock.time = 2.5;
  close(tr.position, 7);
  clock.time = 3;
  close(tr.position, 4);
  clock.time = 3 + 2 * 3.5 + 0.25;
  close(tr.position, 4 + (3.5 * 2 + 0.25) % 2 * 2);
  assert.throws(() => tr.setLoop({ startBeat: 4, endBeat: 4 }));
});
function setup(clips, bpm = 120) {
  const clock = new FakeClock();
  const tr = new Transport(clock, new TempoMap(bpm));
  const events = [];
  let flushes = 0;
  const sched = new Scheduler(
    tr,
    clock,
    { getClips: () => clips },
    { start: (e) => events.push(e), flush: () => flushes++ },
    { lookahead: 0.1 }
  );
  return { clock, tr, sched, events, flushes: () => flushes };
}
test("scheduler: clips get exact start times regardless of how late ticks are", () => {
  const clips = [0, 1, 2, 3, 4].map((b2) => ({ id: "c" + b2, startBeat: b2 * 4, durationSeconds: 0.2 }));
  const a = setup(clips);
  a.clock.time = 5;
  a.tr.play();
  for (let i = 0; i < 1100; i++) {
    a.clock.time = 5 + i * 0.01;
    a.sched.tick();
  }
  const b = setup(clips);
  b.clock.time = 5;
  b.tr.play();
  let t = 5;
  let seed = 7;
  while (t < 16) {
    seed = seed * 16807 % 2147483647;
    t += 5e-3 + seed / 2147483647 * 0.09;
    b.clock.time = t;
    b.sched.tick();
  }
  assert.equal(a.events.length, 5);
  assert.deepEqual(
    b.events.map((e) => [e.clip.id, e.when]),
    a.events.map((e) => [e.clip.id, e.when])
  );
  close(a.events[1].when, 5 + 2);
});
test("scheduler: a five-minute loop has no drift", () => {
  const clips = Array.from({ length: 8 }, (_, b) => ({ id: "b" + b, startBeat: b, durationSeconds: 0.1 }));
  const { clock, tr, sched, events } = setup(clips, 120);
  tr.setLoop({ startBeat: 0, endBeat: 8 });
  clock.time = 0;
  tr.play();
  const rng = /* @__PURE__ */ (() => {
    let s = 99;
    return () => (s = s * 16807 % 2147483647) / 2147483647;
  })();
  let t = 0;
  while (t < 300) {
    t += 0.01 + rng() * 0.08;
    clock.time = t;
    sched.tick();
  }
  assert.ok(events.length >= 8 * (300 / 4) - 8, "scheduled " + events.length);
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
  const clips = [{ id: "long", startBeat: 0, durationSeconds: 4 }];
  const { clock, tr, sched, events } = setup(clips);
  tr.seek(2);
  clock.time = 10;
  tr.play();
  sched.tick();
  assert.equal(events.length, 1);
  close(events[0].offset, 1);
  close(events[0].when, 10);
  const done = setup([{ id: "short", startBeat: 0, durationSeconds: 0.5 }]);
  done.tr.seek(2);
  done.clock.time = 10;
  done.tr.play();
  done.sched.tick();
  assert.equal(done.events.length, 0);
});
test("scheduler: clips that run past the loop end are cut at the loop end", () => {
  const clips = [{ id: "pad", startBeat: 0, durationSeconds: 10 }];
  const { clock, tr, sched, events } = setup(clips);
  tr.setLoop({ startBeat: 0, endBeat: 4 });
  clock.time = 0;
  tr.play();
  for (let t = 0; t <= 4.5; t += 0.05) {
    clock.time = t;
    sched.tick();
  }
  assert.ok(events.length >= 2);
  close(events[0].when, 0);
  close(events[0].stopAt, 2);
  close(events[1].when, 2);
});
test("scheduler: seeking or changing tempo flushes and re-times what comes next", () => {
  const clips = [{ id: "k", startBeat: 8, durationSeconds: 0.1 }];
  const { clock, tr, sched, events, flushes } = setup(clips);
  clock.time = 0;
  tr.play();
  sched.tick();
  const before = flushes();
  clock.time = 3.95;
  sched.tick();
  assert.equal(events.length, 1);
  close(events[0].when, 4);
  tr.setBpm(60);
  sched.tick();
  assert.ok(flushes() > before);
  clock.time = 4;
  sched.tick();
  clock.time = 5;
  sched.tick();
  const last = events[events.length - 1];
  close(last.when, 3.95 + (8 - 7.9) * 1, 1e-9);
});
