// Builds a small demo arrangement in the running app, plays it, and takes a
// screenshot while it plays (for docs/progress/).
//
//   xvfb-run -a -s "-screen 0 1800x1000x24" node scripts/shot-scene.cjs <name>
//
// The arrangement is made through the test hook (BDP_TEST=1), the same way the
// tests build projects.
const path = require("node:path");

let _electron;
try {
  ({ _electron } = require("playwright-core"));
} catch {
  ({ _electron } = require("playwright"));
}

const root = path.resolve(__dirname, "..");
const name = process.argv[2] || "scene";

(async () => {
  const env = { ...process.env, BDP_TEST: "1" };
  delete env.NODE_OPTIONS;
  const app = await _electron.launch({
    executablePath: require(path.join(root, "node_modules", "electron")),
    args: [root, "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    cwd: root,
    env,
  });
  const page = await app.firstWindow();
  await page.reload();
  await page.waitForFunction(() => !!window.__bdp, null, { timeout: 20000 });
  await page.waitForSelector(".plugin_slot");
  await page.waitForTimeout(1200);

  await page.evaluate(async () => {
    const { globals, Sample } = window.__bdp;
    const tracks = globals.playlist.getTracks();
    const channels = globals.mixer.getChannels();
    tracks.forEach((t, i) => t.connect(channels[Math.min(i, channels.length - 1)]));
    const colours = ["#d96a5c", "#e0a84a", "#7ca366", "#6781a4", "#8f6080"];
    tracks.slice(0, 5).forEach((t, i) => (t.color = new t.color.constructor(colours[i])));
    const place = async (track, file, beat) => {
      const s = new Sample({ path: "files/samples/" + file, title: file });
      s.setStartBeat(beat);
      tracks[track].addSample(s);
      await s.loaded;
    };
    for (let bar = 0; bar < 4; bar++) {
      await place(0, "kick1.wav", bar * 8);
      await place(0, "kick1.wav", bar * 8 + 3);
      await place(1, "909.wav", bar * 8 + 4);
    }
    await place(2, "drum loop 3.wav", 0);
    await place(3, "BassDrum_3.wav", 2);
    await place(3, "BassDrum_3.wav", 10);
    channels[1].setVolume(0.7);
    channels[1].setPanning(1.2);
    globals.windows.forEach((w) => w.update && w.update());
  });
  await page.waitForTimeout(600);
  await page.locator(".play").click();
  await page.waitForTimeout(2600);
  const out = path.join(root, "docs", "progress", name + ".png");
  await page.screenshot({ path: out });
  console.log("screenshot: " + path.relative(root, out));
  await app.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
