// Integration test of the beat tools' sound, in the real app (Electron and its real audio engine).
//
//   xvfb-run -a node scripts/beat-test.cjs        (or: npm run test:beat)
//
// What it proves (the sound side of the Phase 4 gate):
//   1. A note sounds at the beat it is written at, to the sample (at 120 BPM and others).
//   2. Pitch follows the key: an octave up plays twice as fast, 7 keys up is a fifth.
//   3. Velocity changes the loudness in proportion; velocity layers pick the layer for the velocity;
//      round robin takes turns.
//   4. A held (gate) note ends when it ends and then releases; a one-shot plays through.
//   5. A choke group cuts a sound that rings (a closed hat ends an open hat).
//   6. A slide note glides in pitch.
//   7. Ratchets split a note into equal hits, swing delays the off-beat sixteenths, and probability decides the
//      same way every time it is rendered.
//   8. What is played live is what is rendered (a null test against the audio recorded at the output).
//   9. A project with a beat is saved, reopened, and renders to the same audio bit for bit.
//
// Needs Playwright (the Electron driver) and wavefile (dev dependency).
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { WaveFile } = require("wavefile");

let _electron;
try {
  ({ _electron } = require("playwright-core"));
} catch {
  ({ _electron } = require("playwright"));
}

const root = path.resolve(__dirname, "..");
const failures = [];

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures.push(name);
}

// ---- sounds to play ------------------------------------------------------------

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-beat-test-"));
const samples = path.join(scratch, "samples");
fs.mkdirSync(samples, { recursive: true });

function writeWav(name, rate, data) {
  const wav = new WaveFile();
  wav.fromScratch(1, rate, "32f", [Float64Array.from(data)]);
  fs.writeFileSync(path.join(samples, name), wav.toBuffer());
}

const RATE = 44100;
const sine = (freq, amp, seconds) => {
  const out = new Float64Array(Math.round(RATE * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / RATE);
  return out;
};
{
  // a 50 ms block of constant level: easy to find, and its start is the moment the note started
  const burst = new Float64Array(Math.round(RATE * 0.05)).fill(0.5);
  writeWav("burst.wav", RATE, burst);
  writeWav("tone440.wav", RATE, sine(440, 0.5, 1));
  writeWav("tone300.wav", RATE, sine(300, 0.5, 1));
  writeWav("tone600.wav", RATE, sine(600, 0.5, 1));
  writeWav("tone1000.wav", RATE, sine(1000, 0.5, 0.3));
}

// ---- the code that runs inside the app ------------------------------------------

const recorderCode = `
  class Recorder extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.max = options.processorOptions.frames;
      this.first = -1;
      this.n = 0;
      this.l = new Float32Array(this.max);
      this.r = new Float32Array(this.max);
      this.port.onmessage = () => {
        this.port.postMessage({ first: this.first, n: this.n, l: this.l.subarray(0, this.n), r: this.r.subarray(0, this.n) });
      };
    }
    process(inputs) {
      const input = inputs[0];
      if (!input || !input.length) return true;
      if (this.first < 0) this.first = currentFrame;
      const l = input[0], r = input[1] || input[0];
      for (let i = 0; i < l.length && this.n < this.max; i++, this.n++) { this.l[this.n] = l[i]; this.r[this.n] = r[i]; }
      return true;
    }
  }
  registerProcessor("recorder", Recorder);`;

async function run() {
  const env = { ...process.env, BDP_TEST: "1", BDP_USER_DATA: path.join(scratch, "userdata"), BDP_GRANT_READ: samples };
  delete env.NODE_OPTIONS;
  fs.mkdirSync(env.BDP_USER_DATA, { recursive: true });
  const app = await _electron.launch({
    executablePath: require(path.join(root, "node_modules", "electron")),
    args: [root, "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    cwd: root,
    env,
  });
  const page = await app.firstWindow();
  const problems = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push("console error: " + m.text());
  });
  page.on("pageerror", (e) => problems.push("uncaught: " + e.message));
  await page.waitForFunction(() => !!window.__bdp, null, { timeout: 30000 });
  await page.waitForTimeout(800);

  await page.evaluate(
    ({ dir, recorderCode }) => {
      const { globals, beatEdit, renderProject } = window.__bdp;
      const DIR = dir.replace(/\\/g, "/") + "/";
      const rate = 44100;
      window.B = {
        rate,
        edit: beatEdit,
        recorderCode,
        wait: (ms) => new Promise((r) => setTimeout(r, ms)),

        // an empty beat at 120 BPM (a beat is half a second)
        reset() {
          const b = globals.beat;
          globals.engine.transport.stop();
          globals.engine.transport.setLoop(null);
          b.setScope("song");
          for (const i of b.instruments) i.connectTo(null);
          b.instruments = [];
          b.patterns = [];
          b.setActivePattern(null);
          for (const t of globals.playlist.getTracks()) for (const c of [...t.getPatternClips()]) t.removePatternClip(c);
          globals.engine.setBpm(120);
          b.touch();
          window.__bdp.session.history.clear();
        },

        // an instrument that plays these sample files over the whole keyboard
        async inst(name, files, options = {}) {
          const i = beatEdit.addInstrument({ name, paths: files.map((f) => DIR + f), ...options });
          await Promise.all(i.zones.map((z) => z.loaded));
          if (i.zones.some((z) => !z.buffer)) throw new Error("could not load " + files.join(", "));
          return i;
        },
        async zone(instrument, file, settings) {
          const z = beatEdit.addZone(instrument, DIR + file, settings);
          await z.loaded;
          if (!z.buffer) throw new Error("could not load " + file);
          return z;
        },

        // a pattern with these notes, placed on the playlist at `at`; `notes` use the instrument object
        place(notes, { length = 4, clipLength = length, swing, at = 0 } = {}) {
          const p = beatEdit.addPattern("test");
          beatEdit.setPattern(p, "length", length);
          if (swing) beatEdit.setPattern(p, "swing", swing);
          beatEdit.editNotes(p, "notes", (list) => {
            for (const n of notes) {
              const note = { instrument: n.i.id, start: n.at, length: n.len ?? 0.25, pitch: n.pitch ?? 60, velocity: n.vel ?? 1 };
              if (n.ratchet) note.ratchet = n.ratchet;
              if (n.prob !== undefined) note.probability = n.prob;
              if (n.slide) note.slide = n.slide;
              if (n.pan !== undefined) note.pan = n.pan;
              list.push(note);
            }
          });
          beatEdit.placePattern(globals.playlist.getTracks()[1], p, at, clipLength);
          return p;
        },

        async render(options = {}) {
          return renderProject(globals.mixer, globals.playlist, { sampleRate: rate, ...options });
        },

        // where, in seconds, sound starts after silence: groups of samples above `thr`, at least `gap` seconds apart
        onsets(data, thr = 1e-6, gap = 0.01) {
          const out = [];
          let last = -1e9;
          for (let i = 0; i < data.length; i++) {
            if (Math.abs(data[i]) > thr) {
              if (i - last > gap * rate) out.push(i);
              last = i;
            }
          }
          return out;
        },
        // the frequency of a sine, from its zero crossings between two times (seconds)
        freq(data, from, to) {
          const a = Math.round(from * rate), b = Math.round(to * rate);
          let first = -1, lastCross = -1, count = 0;
          for (let i = a + 1; i < b; i++) {
            if (data[i - 1] < 0 && data[i] >= 0) {
              const at = i - 1 + -data[i - 1] / (data[i] - data[i - 1]); // between the samples
              if (first < 0) first = at;
              lastCross = at;
              count++;
            }
          }
          return count < 2 ? 0 : ((count - 1) * rate) / (lastCross - first);
        },
        // how loud a sine of `f` Hz is between two times (a single-bin Fourier transform)
        amp(data, f, from, to) {
          const a = Math.round(from * rate), b = Math.round(to * rate);
          let re = 0, im = 0;
          const w = (2 * Math.PI * f) / rate;
          for (let i = a; i < b; i++) { re += data[i] * Math.cos(w * (i - a)); im -= data[i] * Math.sin(w * (i - a)); }
          return (2 * Math.hypot(re, im)) / (b - a);
        },
        peak(data, from, to) {
          let m = 0;
          for (let i = Math.round(from * rate); i < Math.min(Math.round(to * rate), data.length); i++) m = Math.max(m, Math.abs(data[i]));
          return m;
        },
        async hash(buf) {
          const parts = [];
          for (let c = 0; c < buf.numberOfChannels; c++) parts.push(new Uint8Array(buf.getChannelData(c).slice().buffer));
          const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
          let at = 0;
          for (const p of parts) { all.set(p, at); at += p.length; }
          const digest = await crypto.subtle.digest("SHA-256", all);
          return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
        },
      };
    },
    { dir: samples, recorderCode },
  );
  const info = await page.evaluate(() => ({ rate: window.__bdp.globals.audiocontext.sampleRate, state: window.__bdp.globals.audiocontext.state }));
  console.log(`audio context: ${info.rate} Hz (${info.state})`);

  // ---- 1. timing ---------------------------------------------------------------
  {
    const r = await page.evaluate(async () => {
      B.reset();
      const hit = await B.inst("hit", ["burst.wav"]);
      B.place([{ i: hit, at: 0 }, { i: hit, at: 1 }, { i: hit, at: 2.25 }, { i: hit, at: 3.5 }]);
      const buf = await B.render();
      const d = buf.getChannelData(0);
      return { onsets: B.onsets(d), length: buf.length, peak: B.peak(d, 0, 10) };
    });
    // the sound starts one sample after the note (it rises from silence over a millisecond so that it cannot click)
    const want = [0, 1, 2.25, 3.5].map((b) => Math.round(b * 0.5 * 44100));
    const off = r.onsets.map((o, i) => o - want[i]);
    check("each note starts at its beat, to the sample (120 BPM)", r.onsets.length === 4 && off.every((o) => o >= 0 && o <= 2), `onsets ${r.onsets.join(", ")}; off by ${off.join(", ")} samples`);
    check("a note plays at the level of its velocity", Math.abs(r.peak - 0.5) < 0.01, `peak ${r.peak.toFixed(3)}`);
    check("the export is as long as the sound: the last note and its sample", r.length >= Math.round((3.5 * 0.5 + 0.05) * 44100) && r.length < Math.round((3.5 * 0.5 + 0.2) * 44100), `${r.length} frames`);
  }
  {
    // another tempo: 90 BPM, a beat is 2/3 s
    const r = await page.evaluate(async () => {
      B.reset();
      window.__bdp.globals.engine.setBpm(90);
      const hit = await B.inst("hit", ["burst.wav"]);
      B.place([{ i: hit, at: 0 }, { i: hit, at: 1.5 }]);
      const buf = await B.render();
      return B.onsets(buf.getChannelData(0));
    });
    const want = [0, 1.5].map((b) => Math.round(b * (60 / 90) * 44100));
    check("tempo moves the notes (90 BPM)", r.length === 2 && r.every((o, i) => o - want[i] >= 0 && o - want[i] <= 2), `onsets ${r.join(", ")} want ${want.join(", ")}`);
  }

  // ---- 2. pitch ---------------------------------------------------------------
  {
    const r = await page.evaluate(async () => {
      B.reset();
      const tone = await B.inst("tone", ["tone440.wav"]);
      B.place([{ i: tone, at: 0, pitch: 60 }, { i: tone, at: 4, pitch: 72 }, { i: tone, at: 8, pitch: 48 }, { i: tone, at: 12, pitch: 67 }], { length: 16 });
      const buf = await B.render();
      const d = buf.getChannelData(0);
      return [0, 2, 4, 6].map((s) => B.freq(d, s + 0.1, s + 0.5));
    });
    const want = [440, 880, 220, 440 * 2 ** (7 / 12)];
    check("pitch follows the key: unison, octave up, octave down, a fifth up", r.every((f, i) => Math.abs(f / want[i] - 1) < 0.01), r.map((f) => f.toFixed(1)).join(", ") + " Hz");
  }

  // ---- 3. velocity, layers, round robin ----------------------------------------------
  {
    const r = await page.evaluate(async () => {
      B.reset();
      const tone = await B.inst("tone", ["tone440.wav"]);
      B.place([{ i: tone, at: 0, vel: 1 }, { i: tone, at: 4, vel: 0.5 }, { i: tone, at: 8, vel: 0.25 }], { length: 12 });
      const buf = await B.render();
      const d = buf.getChannelData(0);
      return [0, 2, 4].map((s) => B.amp(d, 440, s + 0.1, s + 0.6));
    });
    check("velocity sets the loudness in proportion", Math.abs(r[0] - 0.5) < 0.01 && Math.abs(r[1] - 0.25) < 0.01 && Math.abs(r[2] - 0.125) < 0.01, r.map((a) => a.toFixed(3)).join(", "));
  }
  {
    const r = await page.evaluate(async () => {
      B.reset();
      const layers = await B.inst("layers", []);
      await B.zone(layers, "tone300.wav", { velLow: 1, velHigh: 63 });
      await B.zone(layers, "tone600.wav", { velLow: 64, velHigh: 127 });
      B.place([{ i: layers, at: 0, vel: 0.3 }, { i: layers, at: 4, vel: 0.9 }], { length: 8 });
      const buf = await B.render();
      const d = buf.getChannelData(0);
      return { soft: [B.amp(d, 300, 0.1, 0.6), B.amp(d, 600, 0.1, 0.6)], loud: [B.amp(d, 300, 2.1, 2.6), B.amp(d, 600, 2.1, 2.6)] };
    });
    check("velocity layers: a soft hit plays the soft sample, a hard hit the hard one",
      r.soft[0] > 0.1 && r.soft[1] < 0.01 && r.loud[1] > 0.3 && r.loud[0] < 0.01,
      `soft: 300 Hz ${r.soft[0].toFixed(3)} 600 Hz ${r.soft[1].toFixed(3)}; loud: 300 Hz ${r.loud[0].toFixed(3)} 600 Hz ${r.loud[1].toFixed(3)}`);
  }
  {
    const r = await page.evaluate(async () => {
      B.reset();
      const rr = await B.inst("rr", []);
      await B.zone(rr, "tone300.wav", { seqLength: 2, seqPosition: 1 });
      await B.zone(rr, "tone600.wav", { seqLength: 2, seqPosition: 2 });
      B.place([{ i: rr, at: 0 }, { i: rr, at: 4 }, { i: rr, at: 8 }], { length: 12 });
      const buf = await B.render();
      const d = buf.getChannelData(0);
      return [0, 2, 4].map((s) => B.amp(d, 300, s + 0.1, s + 0.6) > B.amp(d, 600, s + 0.1, s + 0.6) ? 300 : 600);
    });
    check("round robin takes turns", JSON.stringify(r) === "[300,600,300]", r.join(", "));
  }

  // ---- 4. held notes and one-shots ------------------------------------------------
  {
    const r = await page.evaluate(async () => {
      B.reset();
      const held = await B.inst("held", ["tone440.wav"], { mode: "gate" });
      B.edit.setSampler(held, { release: 0.1 });
      const shot = await B.inst("shot", ["tone440.wav"], { mode: "oneshot" });
      // the held note lasts half a beat (0.25 s); the one-shot has the same note length
      B.place([{ i: held, at: 0, len: 0.5 }, { i: shot, at: 4, len: 0.5 }], { length: 8 });
      const buf = await B.render();
      const d = buf.getChannelData(0);
      return {
        heldDuring: B.amp(d, 440, 0.05, 0.2),
        heldAfter: B.peak(d, 0.4, 1.9),
        shotAfter: B.amp(d, 440, 2.5, 2.9),
      };
    });
    check("a held note sounds for its length and then is quiet", r.heldDuring > 0.45 && r.heldAfter < 0.005, `during ${r.heldDuring.toFixed(3)}, after ${r.heldAfter.toExponential(1)}`);
    check("a one-shot plays through, whatever the note length", r.shotAfter > 0.45, `at 0.5 s ${r.shotAfter.toFixed(3)}`);
  }

  // ---- 5. choke groups -------------------------------------------------------------
  {
    const r = await page.evaluate(async () => {
      const run = async (group) => {
        B.reset();
        const open = await B.inst("open hat", ["tone440.wav"], { chokeGroup: group });
        const closed = await B.inst("closed hat", ["tone1000.wav"], { chokeGroup: group });
        B.place([{ i: open, at: 0 }, { i: closed, at: 1 }], { length: 4 });
        const buf = await B.render();
        const d = buf.getChannelData(0);
        return { before: B.amp(d, 440, 0.1, 0.45), after: B.amp(d, 440, 0.6, 0.95), closed: B.amp(d, 1000, 0.55, 0.75) };
      };
      return { choked: await run(1), free: await run(0) };
    });
    check("a closed hat cuts the open hat", r.choked.before > 0.45 && r.choked.after < 0.01 && r.choked.closed > 0.4, `open hat before ${r.choked.before.toFixed(3)} after ${r.choked.after.toExponential(1)}; closed hat ${r.choked.closed.toFixed(3)}`);
    check("without a choke group the open hat rings on", r.free.after > 0.4, `after ${r.free.after.toFixed(3)}`);
  }

  // ---- 6. slide ------------------------------------------------------------------
  {
    const r = await page.evaluate(async () => {
      B.reset();
      const bass = await B.inst("bass", ["tone440.wav"], { mode: "gate" });
      B.place([{ i: bass, at: 0, len: 1, pitch: 60, slide: { to: 72 } }], { length: 4 });
      const buf = await B.render();
      const d = buf.getChannelData(0);
      return { start: B.freq(d, 0.02, 0.1), middle: B.freq(d, 0.2, 0.3), end: B.freq(d, 0.4, 0.48) };
    });
    check("a slide note glides up an octave over its length", r.start > 430 && r.start < 520 && r.start < r.middle && r.middle < r.end && r.end > 760 && r.end < 880,
      `${r.start.toFixed(0)} -> ${r.middle.toFixed(0)} -> ${r.end.toFixed(0)} Hz`);
  }

  // ---- 7. ratchets, swing, probability -------------------------------------------------
  {
    const r = await page.evaluate(async () => {
      B.reset();
      const hit = await B.inst("hit", ["burst.wav"]);
      B.place([{ i: hit, at: 0, len: 1, ratchet: 4 }], { length: 4 });
      const buf = await B.render();
      return B.onsets(buf.getChannelData(0), 1e-6, 0.02);
    });
    const want = [0, 0.125, 0.25, 0.375].map((s) => Math.round(s * 44100));
    check("a ratchet of 4 makes four equal hits in the note", r.length === 4 && r.every((o, i) => o - want[i] >= 0 && o - want[i] <= 2), `onsets ${r.join(", ")}`);
  }
  {
    const r = await page.evaluate(async () => {
      B.reset();
      const hit = await B.inst("hit", ["burst.wav"]);
      B.place([{ i: hit, at: 0 }, { i: hit, at: 0.25 }, { i: hit, at: 0.5 }, { i: hit, at: 0.75 }], { length: 4, swing: 2 / 3 });
      const buf = await B.render();
      return B.onsets(buf.getChannelData(0), 1e-6, 0.02);
    });
    // a beat is half a second; with triplet swing the second sixteenth of each pair is at 2/3 of the eighth: 1/3 beat
    const want = [0, 1 / 3, 0.5, 0.5 + 1 / 3].map((b) => Math.round(b * 0.5 * 44100));
    check("swing delays the off-beat sixteenths, not the others", r.length === 4 && r.every((o, i) => o - want[i] >= 0 && o - want[i] <= 2), `onsets ${r.join(", ")} want ${want.join(", ")}`);
  }
  {
    const r = await page.evaluate(async () => {
      B.reset();
      const hit = await B.inst("hit", ["burst.wav"]);
      const notes = [];
      for (let i = 0; i < 64; i++) notes.push({ i: hit, at: i * 0.25, len: 0.25, prob: 0.5 });
      B.place(notes, { length: 16, clipLength: 32 }); // the pattern twice
      const a = await B.render();
      const b = await B.render();
      const onsets = B.onsets(a.getChannelData(0), 1e-6, 0.02);
      const half = 16 * 0.5 * 44100;
      const firstLoop = onsets.filter((o) => o < half).map((o) => Math.round(o / (0.25 * 0.5 * 44100)));
      const secondLoop = onsets.filter((o) => o >= half).map((o) => Math.round((o - half) / (0.25 * 0.5 * 44100)));
      return { same: (await B.hash(a)) === (await B.hash(b)), count: onsets.length, differ: JSON.stringify(firstLoop) !== JSON.stringify(secondLoop) };
    });
    check("probability: rendering twice gives the same audio", r.same);
    check("probability: about half the notes play, and each loop decides on its own", r.count > 128 * 0.35 && r.count < 128 * 0.65 && r.differ, `${r.count} of 128`);
  }

  // ---- 8. live equals rendered ----------------------------------------------------
  {
    const r = await page.evaluate(async ({ recorderCode }) => {
      const { globals } = window.__bdp;
      const ctx = globals.audiocontext;
      B.reset();
      const tone = await B.inst("bass", ["tone440.wav"], { mode: "gate" });
      B.edit.setSampler(tone, { release: 0.08, attack: 0.01 });
      const hit = await B.inst("hit", ["burst.wav"]);
      const open = await B.inst("open", ["tone300.wav"], { chokeGroup: 2 });
      const closed = await B.inst("closed", ["tone1000.wav"], { chokeGroup: 2 });
      B.place(
        [
          { i: tone, at: 0, len: 1, pitch: 55, slide: { to: 67, at: 0.5 }, vel: 0.9 },
          { i: tone, at: 1.5, len: 0.5, pitch: 48, vel: 0.7 },
          { i: hit, at: 0.25, pan: -0.5 }, { i: hit, at: 1, ratchet: 3, len: 0.5 }, { i: hit, at: 2.75, pan: 0.5, vel: 0.6 },
          { i: open, at: 2 }, { i: closed, at: 2.5 },
        ],
        { length: 4, swing: 0.6 },
      );
      // two instruments on two channels with different faders
      globals.mixer.getChannels()[1].setVolume(0.7, false);
      globals.mixer.getChannels()[2].setPanning(1.2);

      await ctx.resume();
      const url = URL.createObjectURL(new Blob([recorderCode], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url);
      const frames = Math.round(ctx.sampleRate * 6);
      const rec = new AudioWorkletNode(ctx, "recorder", { numberOfInputs: 1, numberOfOutputs: 0, processorOptions: { frames } });
      globals.mixer.getMaster().getOutputNode().connect(rec);
      // pitch automation (the slide) is sampled per 128-frame block, so a start on that grid is sample-identical to the export
      const start = Math.ceil(((ctx.currentTime + 0.4) * ctx.sampleRate) / 128) * 128;
      globals.engine.transport.seek(0);
      globals.engine.transport.playAt(start / ctx.sampleRate);
      await B.wait(3600); // two seconds of music and the tails
      globals.engine.transport.stop();
      await B.wait(200);
      const got = await new Promise((resolve) => {
        rec.port.onmessage = (e) => resolve(e.data);
        rec.port.postMessage("dump");
      });
      globals.mixer.getMaster().getOutputNode().disconnect(rec);

      const buf = await B.render({ sampleRate: ctx.sampleRate });
      const offset = start - got.first;
      let worst = 0, peak = 0;
      for (let c = 0; c < 2; c++) {
        const a = buf.getChannelData(c), live = c === 0 ? got.l : got.r;
        for (let i = 0; i < a.length; i++) {
          worst = Math.max(worst, Math.abs(a[i] - live[i + offset]));
          peak = Math.max(peak, Math.abs(a[i]));
        }
      }
      return { worst, peak, seconds: buf.length / buf.sampleRate };
    }, { recorderCode });
    check("the beat makes sound", r.peak > 0.3, `peak ${r.peak.toFixed(3)}`);
    check("what is played live is what is rendered (null test)", r.worst < 2e-3, `largest difference ${r.worst.toExponential(2)} against a peak of ${r.peak.toFixed(2)}`);
  }

  // ---- 9. save, reopen ---------------------------------------------------------------
  {
    const dir = path.join(scratch, "project-a");
    await app.evaluate((_, d) => { globalThis.__bdpTestDialogs = d; }, { save: [dir], open: [dir] });
    const before = await page.evaluate(async () => {
      const { session } = window.__bdp;
      B.reset();
      const bass = await B.inst("808", ["tone440.wav"], { mode: "gate" });
      const layers = await B.inst("layers", []);
      await B.zone(layers, "tone300.wav", { velLow: 1, velHigh: 63, seqLength: 2, seqPosition: 1 });
      await B.zone(layers, "tone600.wav", { velLow: 64, velHigh: 127 });
      B.edit.setSampler(bass, { release: 0.2, attack: 0.005, chokeGroup: 3 });
      B.place([{ i: bass, at: 0, len: 1, slide: { to: 67 } }, { i: layers, at: 2, vel: 0.9 }, { i: layers, at: 3, vel: 0.2, ratchet: 2, prob: 0.8 }], { length: 8, swing: 0.58 });
      const ok = await session.saveAs();
      const d = session.capture();
      delete d.savedAt;
      return { ok, data: JSON.stringify(d), hash: await B.hash(await B.render()) };
    });
    check("the project with a beat saves", before.ok === true);
    check("the saved project holds the rack, the pattern and its clip", /"patterns"/.test(before.data) && /"rack"/.test(before.data) && /"patternClips"/.test(before.data));
    // forget everything, then open it from disk
    const after = await page.evaluate(async () => {
      const { session } = window.__bdp;
      B.reset();
      await session.history.clear();
      const ok = await session.openProject();
      await B.wait(500);
      const { globals } = window.__bdp;
      await Promise.all(globals.beat.instruments.flatMap((i) => i.zones.map((z) => z.loaded)));
      const d = session.capture();
      delete d.savedAt;
      return { ok, data: JSON.stringify(d), hash: await B.hash(await B.render()), instruments: globals.beat.instruments.length };
    });
    check("the project reopens", after.ok === true && after.instruments === 2);
    check("the reopened project is identical, value for value", after.data === before.data);
    check("the reopened project renders to the same audio, bit for bit", after.hash === before.hash);
  }

  check("no console errors or uncaught exceptions", problems.length === 0, problems.slice(0, 3).join(" | "));
  await app.close();
}

run()
  .catch((e) => {
    console.error("beat test crashed:", e);
    failures.push("crashed");
  })
  .finally(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
    if (failures.length) {
      console.log(`\n${failures.length} check(s) failed`);
      process.exit(1);
    }
    console.log("\nall checks passed");
  });
