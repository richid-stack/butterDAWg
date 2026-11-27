// Smoke test: launches the real app and checks the isolated renderer still works.
//
//   xvfb-run -a node scripts/smoke.cjs [screenshot-name]     (or: npm run smoke)
//
// It checks that the page has no Node access, that the file bridge refuses
// paths outside its folders, that a plugin can be added and opened from the
// mixer (this exercises the CSP: plugin worklets load from blob URLs and plugin
// hosts are eval'd), and that a sample can be dragged from the browser into the
// playlist (this reads the file through the bridge), and that the play, stop and
// space controls drive the engine. Any console error or
// uncaught exception during the run fails the test.
//
// Needs Playwright (the Electron driver only, no browsers): `playwright` or `playwright-core`.
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

let _electron;
try {
  ({ _electron } = require("playwright-core"));
} catch {
  ({ _electron } = require("playwright"));
}

const root = path.resolve(__dirname, "..");
const shotName = process.argv[2];
const failures = [];

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures.push(name);
}

(async () => {
  // Electron rejects some NODE_OPTIONS that sandboxes set for their network proxy
  // test mode keeps the recent list and the recovery file in a scratch folder (not the real ones),
  // and lets the app close without asking about unsaved work
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-smoke-"));
  const env = { ...process.env, BDP_NO_RELOAD: "1", BDP_TEST: "1", BDP_USER_DATA: userData };
  delete env.NODE_OPTIONS;

  const app = await _electron.launch({
    // the project's own electron package exports the path of its binary
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
  // everything must load from the app itself, so the app works offline
  const outside = [];
  page.on("request", (r) => {
    if (!/^(file|blob|data|devtools):/.test(r.url())) outside.push(r.url());
  });

  // reload so the listeners above also see everything that happens at start-up
  await page.reload();
  await page.waitForSelector(".plugin_slot", { timeout: 20000 });
  await page.waitForTimeout(1500);

  // --- isolation ---------------------------------------------------------
  const world = await page.evaluate(() => ({
    require: typeof require,
    process: typeof process,
    bridge: typeof window.bridge,
  }));
  check("renderer has no require()", world.require === "undefined");
  check("renderer has no process", world.process === "undefined");
  check("bridge is exposed", world.bridge === "object");

  // --- file bridge -------------------------------------------------------
  const plugins = (await page.evaluate(() => window.bridge.fs.list("plugins"))).map((e) => e.name);
  check("bridge lists the plugins folder", plugins.includes("Gain.bdp"), plugins.join(", "));

  const denied = await page.evaluate(async () => {
    const tries = ["package.json", "/etc/passwd", "plugins/../package.json"];
    return Promise.all(
      tries.map(async (p) => {
        try {
          await window.bridge.fs.readFile(p);
          return p + " -> READ";
        } catch (e) {
          return /outside the readable folders|ENOENT/.test(e.message) ? "refused" : p + " -> " + e.message;
        }
      }),
    );
  });
  check("bridge refuses paths outside files/ and plugins/", denied.every((d) => d === "refused"), denied.join("; "));

  // --- plugin via the mixer ----------------------------------------------
  await page.locator(".plugin_slot").first().click({ button: "right" });
  await page.locator(".context_item:visible", { hasText: /^Gain$/ }).first().click();
  await page.waitForTimeout(500);
  await page.locator(".plugin_slot").first().click();
  const slider = page.locator('[id^="p-"] #slider-param1');
  await slider.waitFor({ timeout: 8000 }).catch(() => {});
  const sliderCount = await slider.count();
  check("plugin window opens (eval'd host + CSP)", sliderCount > 0);
  if (sliderCount > 0) {
    await slider.first().evaluate((el) => {
      el.value = "50";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const shown = await page.locator('[id^="p-"] #value-param1').first().textContent();
    check("plugin slider drives the audio parameter", shown.trim() === "50", "shows " + shown.trim());
  }

  // --- sample drag into the playlist -------------------------------------
  // clips are drawn on a canvas to the right of the track header (.track), not
  // added as DOM children, so compare the pixels of the whole first row
  const track = await page.locator(".track").first().boundingBox();
  const row = { x: track.x, y: track.y, width: 880, height: track.height };
  const before = await page.screenshot({ clip: row });
  await page.getByText("samples", { exact: true }).first().click();
  const item = page.getByText("kick1.wav", { exact: true }).first();
  await item.waitFor({ timeout: 5000 });
  const from = await item.boundingBox();
  await page.mouse.move(from.x + 10, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + 4, { steps: 5 });
  await page.mouse.move(track.x + 200, track.y + track.height / 2, { steps: 25 });
  await page.mouse.move(track.x + 210, track.y + track.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const after = await page.screenshot({ clip: row });
  check("dragged sample appears on the track (read through the bridge)", !before.equals(after));

  // --- play and stop -----------------------------------------------------
  // the header's play button starts the engine; the time label and the
  // playlist cursor follow it; stop goes back to the start
  const label = page.locator(".header_time > label");
  const cursorLeft = () => page.locator(".bars_cursor").evaluate((el) => parseFloat(el.style.left));
  const cursorBefore = await cursorLeft();
  await page.locator(".play").click();
  await page.waitForTimeout(1500);
  const playing = await page.evaluate(() => ({
    isPlaying: window.__bdp ? window.__bdp.globals.is_playing : null,
    icon: document.querySelector(".play i").className,
  }));
  const timeWhilePlaying = (await label.textContent()).trim();
  const cursorWhilePlaying = await cursorLeft();
  check("play button starts playback and shows pause", /fa-pause/.test(playing.icon), playing.icon);
  check("time label follows playback", timeWhilePlaying !== "00:00.00" && /^\d\d:\d\d\.\d\d$/.test(timeWhilePlaying), timeWhilePlaying);
  check("playlist cursor moves while playing", cursorWhilePlaying > cursorBefore + 20, `${cursorBefore} -> ${cursorWhilePlaying}`);
  await page.locator(".reset").click();
  await page.waitForTimeout(300);
  const timeAfterStop = (await label.textContent()).trim();
  const cursorAfterStop = await cursorLeft();
  const iconAfterStop = await page.locator(".play i").getAttribute("class");
  check("stop goes back to the start", timeAfterStop === "00:00.00" && Math.abs(cursorAfterStop - cursorBefore) < 1 && /fa-play/.test(iconAfterStop), `${timeAfterStop}, cursor ${cursorAfterStop}`);

  // space plays and pauses (the key goes to the playlist window)
  await page.locator(".tracks_canvas").first().click({ position: { x: 600, y: 300 } });
  await page.keyboard.press("Space");
  await page.waitForTimeout(600);
  const spacePlaying = await page.locator(".play i").getAttribute("class");
  await page.keyboard.press("Space");
  await page.waitForTimeout(300);
  const spacePaused = await page.locator(".play i").getAttribute("class");
  check("space bar plays and pauses", /fa-pause/.test(spacePlaying) && /fa-play/.test(spacePaused), `${spacePlaying} / ${spacePaused}`);
  await page.locator(".reset").click();

  if (shotName) {
    const out = path.join(root, "docs", "progress", shotName + ".png");
    await page.screenshot({ path: out });
    console.log("screenshot: " + path.relative(root, out));
  }

  check("no network requests (runs offline)", outside.length === 0, outside.slice(0, 3).join(" | "));
  check("no console errors or uncaught exceptions", problems.length === 0, problems.slice(0, 3).join(" | "));

  await app.close();
  if (failures.length) {
    console.log(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
})().catch((e) => {
  console.error("smoke test crashed:", e);
  process.exit(2);
});
