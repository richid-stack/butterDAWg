// Integration test of the audio engine, in the real app (Electron + its real audio engine).
//
//   xvfb-run -a node scripts/engine-test.cjs [--long]       (or: npm run test:engine)
//
// What it proves (the Phase 2 gate):
//   1. Files of any format, channel count and sample rate decode correctly: the
//      right channels, the right length, the right content, at the device rate.
//   2. Stereo files play and render correctly at any output sample rate.
//   3. The rendered audio equals what plays live: a project is played in real
//      time and recorded at the master output, then rendered offline, and the
//      two are subtracted. Both render orders (all at once, or a little at a
//      time like live playback) must also agree.
//   4. A looping clip stays on the beat: the onsets recorded from real-time
//      playback are measured against the ideal grid, and must not drift.
//      Default 20 s; `--long` runs 5 minutes.
//   5. The exported WAV file contains exactly the audio that was rendered.
//
// Generated audio goes to files/.test/ (git-ignored) and is removed afterwards.
// Needs Playwright (the Electron driver), wavefile (dev dependency) and ffmpeg
// (optional: without it the MP3/FLAC/OGG checks are skipped).
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { WaveFile } = require("wavefile");

let _electron;
try {
  ({ _electron } = require("playwright-core"));
} catch {
  ({ _electron } = require("playwright"));
}

const root = path.resolve(__dirname, "..");
const fixtures = path.join(root, "files", ".test");
const long = process.argv.includes("--long");
const failures = [];

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures.push(name);
}

// ---- test audio ----------------------------------------------------------

function sine(freq, amp, rate, seconds) {
  const out = new Float64Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function writeWav(name, rate, bits, channels) {
  const wav = new WaveFile();
  // wavefile takes integer samples for integer depths; scale to the full range
  // (8-bit WAV files are unsigned, centred on 128)
  const max = 2 ** (bits - 1) - 1;
  const ints = channels.map((c) => Array.from(c, (v) => Math.round(v * max) + (bits === 8 ? 128 : 0)));
  wav.fromScratch(channels.length, rate, String(bits), channels.length === 1 ? ints[0] : ints);
  fs.writeFileSync(path.join(fixtures, name), wav.toBuffer());
}

// what each file holds, so the checks below know what to expect
const expected = {};

function makeFixtures() {
  fs.rmSync(fixtures, { recursive: true, force: true });
  fs.mkdirSync(fixtures, { recursive: true });

  writeWav("stereo-48k.wav", 48000, 16, [sine(440, 0.5, 48000, 1), sine(880, 0.5, 48000, 1)]);
  expected["stereo-48k.wav"] = { channels: 2, seconds: 1, tones: [[440, 0.5], [880, 0.5]] };

  writeWav("mono-22k.wav", 22050, 16, [sine(1000, 0.5, 22050, 0.5)]);
  expected["mono-22k.wav"] = { channels: 1, seconds: 0.5, tones: [[1000, 0.5]] };

  // sound in the left channel only, 24-bit, at a high rate
  writeWav("left-only-96k.wav", 96000, 24, [sine(3000, 0.4, 96000, 1), new Float64Array(96000)]);
  expected["left-only-96k.wav"] = { channels: 2, seconds: 1, tones: [[3000, 0.4], null] };

  writeWav("stereo-8k-8bit.wav", 8000, 8, [sine(500, 0.4, 8000, 1), sine(1500, 0.4, 8000, 1)]);
  expected["stereo-8k-8bit.wav"] = { channels: 2, seconds: 1, tones: [[500, 0.4], [1500, 0.4]], tolerance: 0.05 };

  // long mono tones, for the tests where something changes while a clip is sounding
  writeWav("long-tone.wav", 44100, 16, [sine(440, 0.5, 44100, 4)]);
  writeWav("late-tone.wav", 44100, 16, [sine(440, 0.5, 44100, 3)]);

  // a single click: one sample of 0.9 and then silence, for measuring timing
  const click = new Float64Array(8820);
  click[0] = 0.9;
  writeWav("click.wav", 44100, 16, [click]);

  // compressed formats, made from the 48 kHz stereo file
  let ffmpeg = true;
  for (const ext of ["flac", "ogg", "mp3"]) {
    try {
      execFileSync("ffmpeg", ["-v", "error", "-y", "-i", path.join(fixtures, "stereo-48k.wav"), path.join(fixtures, "stereo-48k." + ext)]);
      // lossy formats lose a little and add padding to the length
      expected["stereo-48k." + ext] = {
        channels: 2,
        seconds: 1,
        tones: [[440, 0.5], [880, 0.5]],
        tolerance: ext === "flac" ? 0.02 : 0.08,
        lengthSlack: ext === "flac" ? 0.002 : 0.1,
      };
    } catch {
      ffmpeg = false;
    }
  }
  if (!ffmpeg) console.log("note: ffmpeg is not available, MP3/FLAC/OGG checks are skipped");
}

// ---- the code that runs inside the app -------------------------------------
// Everything below this line until `run` is sent to the renderer as text.

const inPage = {
  // how loud a sine of `freq` is in a channel (a single-bin Fourier transform)
  toneAmp: `(data, rate, freq, from = 0, to = data.length) => {
    let re = 0, im = 0;
    const w = (2 * Math.PI * freq) / rate;
    for (let i = from; i < to; i++) { re += data[i] * Math.cos(w * (i - from)); im -= data[i] * Math.sin(w * (i - from)); }
    return (2 * Math.hypot(re, im)) / (to - from);
  }`,
  // a worklet that records the master output, and one that finds clicks in it
  recorderCode: `
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
    registerProcessor("recorder", Recorder);`,
  onsetCode: `
    class Onsets extends AudioWorkletProcessor {
      constructor() {
        super();
        this.found = [];
        this.hits = []; // every sample that is not silent: a click is one or two of these
        this.pending = null;
        this.quiet = 1e9;
        this.port.onmessage = () => this.port.postMessage({ found: this.found, hits: this.hits });
      }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (!ch) return true;
        for (let i = 0; i < ch.length; i++) {
          const v = Math.abs(ch[i]);
          if (v > 1e-4 && this.hits.length < 20000) this.hits.push([currentFrame + i, ch[i]]);
          if (this.pending) {
            this.pending.s.push(v);
            if (this.pending.s.length >= 4) { this.found.push(this.pending); this.pending = null; this.quiet = 0; }
            continue;
          }
          this.quiet++;
          if (v > 0.15 && this.quiet > 2205) this.pending = { frame: currentFrame + i, s: [v] };
        }
        return true;
      }
    }
    registerProcessor("onsets", Onsets);`,
};

async function run() {
  makeFixtures();

  const env = { ...process.env, BDP_TEST: "1" };
  delete env.NODE_OPTIONS;
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
  await page.reload();
  await page.waitForFunction(() => !!window.__bdp, null, { timeout: 20000 });
  await page.waitForTimeout(1000);

  // helpers in the page
  await page.evaluate(
    ({ toneAmp, recorderCode, onsetCode }) => {
      window.T = {
        toneAmp: eval(toneAmp),
        modules: new Set(),
        async addModule(code) {
          if (window.T.modules.has(code)) return;
          window.T.modules.add(code);
          const url = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
          await window.__bdp.globals.audiocontext.audioWorklet.addModule(url);
        },
        recorderCode,
        onsetCode,
        wait: (ms) => new Promise((r) => setTimeout(r, ms)),
        // a frame number on the audio clock to start playing at, on a whole sample
        startFrame(leadSeconds) {
          const ctx = window.__bdp.globals.audiocontext;
          return Math.ceil((ctx.currentTime + leadSeconds) * ctx.sampleRate);
        },
        // empty the playlist so each test starts from nothing
        clearProject() {
          const { globals } = window.__bdp;
          globals.engine.transport.stop();
          globals.engine.transport.setLoop(null);
          for (const track of globals.playlist.getTracks()) {
            for (const s of [...track.getSamples()]) track.removeSample(s);
          }
        },
        async place(trackIndex, file, beat) {
          const { globals, Sample } = window.__bdp;
          const s = new Sample({ path: "files/.test/" + file, title: file });
          s.setStartBeat(beat);
          globals.playlist.getTracks()[trackIndex].addSample(s);
          await s.loaded;
          if (!s.isLoaded()) throw new Error("could not load " + file);
          return s;
        },
      };
    },
    inPage,
  );
  const info = await page.evaluate(() => {
    const ctx = window.__bdp.globals.audiocontext;
    return { rate: ctx.sampleRate, state: ctx.state };
  });
  console.log(`audio context: ${info.rate} Hz (${info.state})`);

  // ---- 1. decoding ---------------------------------------------------------
  for (const [file, want] of Object.entries(expected)) {
    const got = await page.evaluate(
      async ({ file, want }) => {
        const { globals } = window.__bdp;
        const { buffer } = await globals.engine.samples.load("files/.test/" + file);
        const amps = [];
        const skip = Math.round(buffer.sampleRate * 0.1); // lossy formats start with a short ramp
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          const data = buffer.getChannelData(c);
          const row = want.tones.map((t) => (t ? window.T.toneAmp(data, buffer.sampleRate, t[0], skip, data.length - skip) : null));
          amps.push(row);
        }
        return { channels: buffer.numberOfChannels, rate: buffer.sampleRate, seconds: buffer.duration, amps };
      },
      { file, want },
    );
    const tol = want.tolerance ?? 0.03;
    const slack = want.lengthSlack ?? 2 / got.rate;
    check(`${file}: ${want.channels} channel(s), length, at the device rate`,
      got.channels === want.channels && Math.abs(got.seconds - want.seconds) <= slack && got.rate === info.rate,
      `${got.channels}ch ${got.seconds.toFixed(4)} s @ ${got.rate}`);
    let ok = true;
    let detail = [];
    for (let c = 0; c < want.channels; c++) {
      const t = want.tones[c];
      if (t) {
        // the channel's own tone is there at the right level...
        const own = got.amps[c][c];
        ok = ok && Math.abs(own - t[1]) <= tol * Math.max(1, t[1] / 0.5);
        detail.push(`ch${c} ${t[0]} Hz = ${own.toFixed(3)}`);
        // ...and the other channel's tone has not leaked in
        for (let o = 0; o < want.channels; o++) {
          if (o !== c && want.tones[o]) {
            ok = ok && got.amps[c][o] < 0.02;
          }
        }
      } else {
        // a silent channel stays silent
        for (let o = 0; o < want.channels; o++) if (want.tones[o]) ok = ok && got.amps[c][o] < 0.005;
        detail.push(`ch${c} silent`);
      }
    }
    check(`${file}: each channel holds its own sound`, ok, detail.join(", "));
  }

  // ---- 2. rendering stereo at other sample rates -----------------------------
  for (const rate of [44100, 48000, 96000]) {
    const got = await page.evaluate(async (rate) => {
      const { globals, renderProject } = window.__bdp;
      window.T.clearProject();
      await window.T.place(0, "stereo-48k.wav", 0);
      const buf = await renderProject(globals.mixer, globals.playlist, { sampleRate: rate });
      const l = buf.getChannelData(0), r = buf.getChannelData(1);
      const a = Math.round(rate * 0.1), b = rate - a;
      return {
        channels: buf.numberOfChannels,
        rate: buf.sampleRate,
        seconds: buf.length / buf.sampleRate,
        l440: window.T.toneAmp(l, rate, 440, a, b),
        l880: window.T.toneAmp(l, rate, 880, a, b),
        r440: window.T.toneAmp(r, rate, 440, a, b),
        r880: window.T.toneAmp(r, rate, 880, a, b),
      };
    }, rate);
    check(`stereo file renders at ${rate} Hz, left and right kept apart`,
      got.channels === 2 && got.rate === rate && Math.abs(got.seconds - 1) <= 3 / info.rate && // (the decoder may be a frame short)
      
      Math.abs(got.l440 - 0.5) < 0.02 && Math.abs(got.r880 - 0.5) < 0.02 && got.l880 < 0.01 && got.r440 < 0.01,
      `${got.channels}ch ${got.rate} Hz ${got.seconds.toFixed(5)} s, L440 ${got.l440.toFixed(3)} R880 ${got.r880.toFixed(3)} leak ${Math.max(got.l880, got.r440).toExponential(1)}`);
  }

  // ---- 3. rendered audio equals live playback ---------------------------------
  // a project with two tracks into two channels: a pan, a fader, a plugin
  const live = await page.evaluate(
    async ({ recorderCode }) => {
      const { globals } = window.__bdp;
      const { Plugin } = window.__bdp;
      const ctx = globals.audiocontext;
      window.T.clearProject();
      const tracks = globals.playlist.getTracks();
      const channels = globals.mixer.getChannels();
      tracks[0].connect(channels[0]);
      tracks[1].connect(channels[1]);
      channels[1].setVolume(0.5, false);
      channels[1].setPanning(1.25);
      // a plugin on the first channel
      const plugin = new Plugin("plugins/Gain.bdp");
      await plugin.ready;
      plugin.getAudioNode().parameters.forEach((p, name) => { if (name === "level") p.value = 0.8; });
      channels[0].addPlugin(plugin, 0);
      await window.T.place(0, "click.wav", 0);
      await window.T.place(0, "stereo-48k.wav", 1);
      await window.T.place(1, "left-only-96k.wav", 0.5);
      await window.T.place(1, "mono-22k.wav", 3);

      await window.T.addModule(recorderCode);
      await ctx.resume();
      const frames = Math.round(ctx.sampleRate * 8);
      const rec = new AudioWorkletNode(ctx, "recorder", { numberOfInputs: 1, numberOfOutputs: 0, processorOptions: { frames } });
      globals.mixer.getMaster().getOutputNode().connect(rec);

      // start on a whole frame so that live and rendered clips fall on the same fractions
      const start = window.T.startFrame(0.4);
      globals.engine.transport.seek(0);
      globals.engine.transport.playAt(start / ctx.sampleRate);
      // the project lasts 3 beats + 0.5 s = 1.7 s; wait until it has passed, then a little more
      await window.T.wait(3200);
      globals.engine.transport.stop();
      await window.T.wait(200);
      const got = await new Promise((resolve) => {
        rec.port.onmessage = (e) => resolve(e.data);
        rec.port.postMessage("dump");
      });
      globals.mixer.getMaster().getOutputNode().disconnect(rec);

      // the same project, rendered
      const upfront = await window.__bdp.renderProject(globals.mixer, globals.playlist, { mode: "upfront" });
      const incremental = await window.__bdp.renderProject(globals.mixer, globals.playlist, { mode: "incremental" });
      const offset = start - got.first;
      const n = upfront.length;
      const diff = (a, b, shiftB) => { let m = 0, e = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i + shiftB]); if (d > m) m = d; e += d * d; } return { max: m, rms: Math.sqrt(e / a.length) }; };
      const liveL = got.l, liveR = got.r;
      const upL = upfront.getChannelData(0), upR = upfront.getChannelData(1);
      const inL = incremental.getChannelData(0), inR = incremental.getChannelData(1);
      let peak = 0, energy = 0;
      for (let i = 0; i < n; i++) { peak = Math.max(peak, Math.abs(upL[i]), Math.abs(upR[i])); energy += upL[i] * upL[i] + upR[i] * upR[i]; }
      // what is recorded after the project's end must be silent
      let tail = 0;
      for (let i = offset + n; i < got.n; i++) tail = Math.max(tail, Math.abs(liveL[i]), Math.abs(liveR[i]));
      return {
        frames: n, rate: ctx.sampleRate, offset,
        peak, rms: Math.sqrt(energy / (2 * n)), tail,
        liveVsRendered: [diff(upL, liveL, offset), diff(upR, liveR, offset)],
        incrementalVsUpfront: [diff(upL, inL, 0), diff(upR, inR, 0)],
        // to export below
        exportL: Array.from(upL), exportR: Array.from(upR),
      };
    },
    inPage,
  );
  const db = (x) => (x > 0 ? (20 * Math.log10(x)).toFixed(1) + " dB" : "-inf dB");
  check("the project makes sound", live.peak > 0.2 && live.rms > 0.02, `peak ${live.peak.toFixed(3)}, rms ${live.rms.toFixed(3)}`);
  const worst = Math.max(...live.liveVsRendered.map((d) => d.max));
  check("rendered audio equals live playback (null test, both channels)", worst < 2e-3,
    `largest difference ${worst.toExponential(2)} = ${db(worst)} (signal peak ${db(live.peak)})`);
  check("nothing is left playing after the end of the project", live.tail < 1e-4, `tail ${live.tail.toExponential(1)}`);
  const worstInc = Math.max(...live.incrementalVsUpfront.map((d) => d.max));
  check("rendering a little at a time equals rendering all at once", worstInc < 1e-6, `largest difference ${worstInc.toExponential(2)}`);

  // ---- 5. the exported WAV file ------------------------------------------------
  for (const format of ["float32", "pcm24", "pcm16"]) {
    const bytes = await page.evaluate(
      ({ format, l, r, rate }) => {
        const out = window.__bdp.encodeWav([Float32Array.from(l), Float32Array.from(r)], rate, { format });
        let s = "";
        for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
        return btoa(s);
      },
      { format, l: live.exportL, r: live.exportR, rate: live.rate },
    );
    const wav = new WaveFile(Buffer.from(bytes, "base64"));
    const samples = wav.getSamples(false, Float64Array);
    const bits = wav.bitDepth;
    // integer files are in integers: bring them to -1..1
    const scale = bits === "32f" ? 1 : 2 ** (parseInt(bits, 10) - 1);
    let m = 0;
    for (let i = 0; i < live.exportL.length; i++) {
      m = Math.max(m, Math.abs(samples[0][i] / scale - Math.fround(live.exportL[i])), Math.abs(samples[1][i] / scale - Math.fround(live.exportR[i])));
    }
    const limit = format === "float32" ? 0 : format === "pcm24" ? 2 ** -22 : 2 ** -14;
    check(`exported ${format} WAV holds the rendered audio`,
      wav.fmt.numChannels === 2 && wav.fmt.sampleRate === live.rate && samples[0].length === live.frames && m <= limit,
      `${bits}, ${wav.fmt.numChannels}ch, ${wav.fmt.sampleRate} Hz, largest difference ${m.toExponential(1)}`);
  }

  // ---- 6. a clip that is still loading when it is due ---------------------------
  // The file takes half a second to arrive; playback starts at once. The clip
  // must join when it has loaded, part-way in, and still end where the file ends.
  const late = await page.evaluate(
    async ({ recorderCode }) => {
      const { globals, Sample } = window.__bdp;
      const ctx = globals.audiocontext;
      window.T.clearProject();
      globals.playlist.getTracks()[0].connect(globals.mixer.getChannels()[0]);
      globals.mixer.getChannels()[0].setPluginBypassed(0, true);
      await window.T.addModule(recorderCode);
      const samples = globals.engine.samples;
      const load = samples.load.bind(samples);
      samples.load = (p) => load(p).then((d) => new Promise((r) => setTimeout(() => r(d), 500)));
      const sample = new Sample({ path: "files/.test/late-tone.wav", title: "late" });
      samples.load = load;
      sample.setStartBeat(0);
      globals.playlist.getTracks()[0].addSample(sample);
      await ctx.resume();
      const rec = new AudioWorkletNode(ctx, "recorder", { numberOfInputs: 1, numberOfOutputs: 0, processorOptions: { frames: Math.round(ctx.sampleRate * 5) } });
      globals.mixer.getMaster().getOutputNode().connect(rec);
      const start = window.T.startFrame(0.1);
      const loadedAtStart = sample.isLoaded();
      globals.engine.transport.seek(0);
      globals.engine.transport.playAt(start / ctx.sampleRate);
      await window.T.wait(4400);
      globals.engine.transport.stop();
      await window.T.wait(100);
      const got = await new Promise((resolve) => {
        rec.port.onmessage = (e) => resolve(e.data);
        rec.port.postMessage("dump");
      });
      globals.mixer.getMaster().getOutputNode().disconnect(rec);
      const l = got.l;
      const offset = start - got.first;
      let first = -1, last = -1;
      for (let i = offset; i < got.n; i++) if (Math.abs(l[i]) > 0.01) { if (first < 0) first = i - offset; last = i - offset; }
      // the level once it is playing
      const a = first + Math.round(ctx.sampleRate * 0.2), b = first + Math.round(ctx.sampleRate * 1.0);
      return { loadedAtStart, rate: ctx.sampleRate, first, last, amp: window.T.toneAmp(l.subarray(offset), ctx.sampleRate, 440, a, b) };
    },
    inPage,
  );
  check("a clip that is still loading when it is due joins when it has loaded",
    !late.loadedAtStart && late.first > 0.3 * late.rate && late.first < 1.5 * late.rate && Math.abs(late.amp - 0.5) < 0.03,
    `starts ${(late.first / late.rate).toFixed(2)} s in, level ${late.amp.toFixed(3)}`);
  check("...and still ends where the file ends (3 s)", Math.abs(late.last / late.rate - 3) < 0.05, `last sound at ${(late.last / late.rate).toFixed(3)} s`);

  // ---- 7. a tempo change while a clip is sounding --------------------------------
  // A four-second tone starts; a second in, the tempo halves. The tone has to carry
  // on as if nothing happened: compare it with the ideal sine, sample by sample.
  const tempo = await page.evaluate(
    async ({ recorderCode }) => {
      const { globals } = window.__bdp;
      const ctx = globals.audiocontext;
      window.T.clearProject();
      globals.playlist.getTracks()[0].connect(globals.mixer.getChannels()[0]);
      await window.T.place(0, "long-tone.wav", 0);
      await window.T.addModule(recorderCode);
      const rec = new AudioWorkletNode(ctx, "recorder", { numberOfInputs: 1, numberOfOutputs: 0, processorOptions: { frames: Math.round(ctx.sampleRate * 6) } });
      globals.mixer.getMaster().getOutputNode().connect(rec);
      const start = window.T.startFrame(0.4);
      globals.engine.transport.seek(0);
      globals.engine.transport.playAt(start / ctx.sampleRate);
      while (ctx.currentTime < start / ctx.sampleRate + 1) await window.T.wait(10);
      globals.bpm = 75;
      while (ctx.currentTime < start / ctx.sampleRate + 3) await window.T.wait(10);
      globals.engine.transport.stop();
      await window.T.wait(100);
      globals.bpm = 150;
      const got = await new Promise((resolve) => {
        rec.port.onmessage = (e) => resolve(e.data);
        rec.port.postMessage("dump");
      });
      globals.mixer.getMaster().getOutputNode().disconnect(rec);
      const offset = start - got.first;
      let worst = 0, worstAt = 0;
      const from = Math.round(ctx.sampleRate * 0.05), to = Math.round(ctx.sampleRate * 2.9);
      for (let n = from; n < to; n++) {
        const want = 0.5 * Math.sin((2 * Math.PI * 440 * n) / ctx.sampleRate);
        const d = Math.abs(got.l[offset + n] - want);
        if (d > worst) { worst = d; worstAt = n; }
      }
      return { worst, worstAt, rate: ctx.sampleRate };
    },
    inPage,
  );
  check("a tempo change does not interrupt or restart a clip that is playing", tempo.worst < 2e-3,
    `largest difference from the ideal tone ${tempo.worst.toExponential(2)} at ${(tempo.worstAt / tempo.rate).toFixed(3)} s`);

  // ---- 4. a looping clip stays on the beat ---------------------------------------
  const seconds = process.env.BDP_SECONDS ? Number(process.env.BDP_SECONDS) : long ? 300 : 20;
  console.log(`timing test: looping click for ${seconds} s of real time...`);
  const timing = await page.evaluate(
    async ({ onsetCode, seconds }) => {
      const { globals } = window.__bdp;
      const ctx = globals.audiocontext;
      window.T.clearProject();
      const tracks = globals.playlist.getTracks();
      tracks[0].connect(globals.mixer.getChannels()[0]);
      globals.mixer.getChannels()[0].setPluginBypassed(0, true);
      // two clicks per loop, a beat apart: 150 BPM is 0.4 s per beat
      await window.T.place(0, "click.wav", 0);
      await window.T.place(0, "click.wav", 1);
      globals.engine.transport.setLoop({ startBeat: 0, endBeat: 2 });
      // how far ahead of its start time each clip was scheduled, and how long the page stalled
      const margins = [];
      const events = [];
      const originalStart = globals.engine.voices.start;
      globals.engine.voices.start = function (event) {
        margins.push(event.when - ctx.currentTime);
        events.push({ when: event.when, offset: event.offset, stopAt: event.stopAt, now: ctx.currentTime });
        return originalStart.call(this, event);
      };
      let longestStall = 0;
      let lastBeat = performance.now();
      const stallTimer = setInterval(() => {
        const t = performance.now();
        longestStall = Math.max(longestStall, t - lastBeat - 10);
        lastBeat = t;
      }, 10);
      await window.T.addModule(onsetCode);
      const det = new AudioWorkletNode(ctx, "onsets", { numberOfInputs: 1, numberOfOutputs: 0 });
      globals.mixer.getMaster().getOutputNode().connect(det);
      await ctx.resume();
      const start = window.T.startFrame(0.4);
      globals.engine.transport.seek(0);
      globals.engine.transport.playAt(start / ctx.sampleRate);
      await window.T.wait(seconds * 1000);
      globals.engine.transport.stop();
      await window.T.wait(300);
      clearInterval(stallTimer);
      globals.engine.voices.start = originalStart;
      const got = await new Promise((resolve) => {
        det.port.onmessage = (e) => resolve(e.data);
        det.port.postMessage("dump");
      });
      const beat = 60 / globals.bpm;
      // where the clicks should be, in frames; compare with where they were heard
      const errors = got.found.map((o, j) => {
        const sum = o.s.reduce((a, b) => a + b, 0);
        const centre = o.frame + o.s.reduce((a, v, k) => a + k * v, 0) / sum;
        return centre - (start + Math.round(j * beat * ctx.sampleRate));
      });
      return {
        rate: ctx.sampleRate, beat, errors, expectedCount: Math.floor(seconds / beat),
        minMargin: Math.min(...margins), lateStarts: margins.filter((m) => m < 0).length, longestStall,
        events, start, hits: got.hits,
      };
    },
    { onsetCode: inPage.onsetCode, seconds },
  );
  const errs = timing.errors;
  const maxErr = Math.max(...errs.map(Math.abs));
  const tenth = Math.max(1, Math.floor(errs.length / 10));
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const drift = mean(errs.slice(-tenth)) - mean(errs.slice(0, tenth));
  const outliers = errs.map((e, j) => [j, e]).filter(([, e]) => Math.abs(e) > 0.5);
  console.log(`      scheduled at least ${(timing.minMargin * 1000).toFixed(0)} ms ahead (${timing.lateStarts} late); longest stall of the page ${timing.longestStall.toFixed(0)} ms; ` +
    `${outliers.length} click(s) off the grid` + (outliers.length ? ": " + outliers.slice(0, 8).map(([j, e]) => `#${j} by ${e.toFixed(1)}`).join(", ") : ""));
  if (outliers.length) {
    // what the scheduler handed over for the clicks that were off: the start time it asked for, in samples from the grid
    console.log(`      the scheduler made ${timing.events.length} starts for ${errs.length} clicks heard`);
    for (const [j] of outliers.slice(0, 4)) {
      const nearby = timing.hits.filter(([f]) => Math.abs(f - (timing.start + Math.round(j * timing.beat * timing.rate))) < 1500);
      console.log(`      samples heard around click ${j} (frame from its ideal place: value): ` +
        nearby.map(([f, v]) => `${f - (timing.start + Math.round(j * timing.beat * timing.rate))}: ${v.toFixed(3)}`).join(", "));
      for (let k = Math.max(0, j - 1); k <= Math.min(timing.events.length - 1, j + 1); k++) {
        const e = timing.events[k];
        const ideal = (timing.start + Math.round(k * timing.beat * timing.rate)) / timing.rate;
        console.log(`      start ${k}: asked for ${((e.when - ideal) * timing.rate).toFixed(2)} samples off the grid, offset ${e.offset}, stopAt ${e.stopAt}, ${(e.when - e.now).toFixed(3)} s ahead`);
      }
    }
  }
  check(`all ${timing.expectedCount} clicks of a ${seconds} s loop were heard`, Math.abs(errs.length - timing.expectedCount) <= 1, `heard ${errs.length}`);
  check(`clicks stay on the beat (largest error ${maxErr.toFixed(2)} samples = ${((maxErr / timing.rate) * 1000).toFixed(3)} ms)`, maxErr <= 1.5);
  check(`no drift over ${seconds} s (${drift.toFixed(3)} samples between the first and last tenth)`, Math.abs(drift) <= 0.5);

  check("no console errors or uncaught exceptions", problems.length === 0, problems.slice(0, 3).join(" | "));
  await app.close();
}

run()
  .catch((e) => {
    console.error("engine test crashed:", e);
    failures.push("crashed");
  })
  .finally(() => {
    fs.rmSync(fixtures, { recursive: true, force: true });
    if (failures.length) {
      console.log(`\n${failures.length} check(s) failed`);
      process.exit(1);
    }
    console.log("\nall checks passed");
  });
