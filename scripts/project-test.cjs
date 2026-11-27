// Integration test of projects, in the real app (Phase 3 gate).
//
//   xvfb-run -a node scripts/project-test.cjs [--shots]       (or: npm run test:project)
//
// What it proves:
//   1. Every edit can be undone and redone from the real UI: moving, adding and
//      deleting clips; track mute, solo, rename, colour, routing; channel
//      volume, pan, mute, rename; adding, bypassing, removing and changing a
//      plugin; tempo. Each is checked as: it changes the project, it is one
//      undo step, undo gives back exactly the project from before, redo gives
//      back exactly the project from after.
//   2. Save, close, reopen: the reopened project is identical (every value) and
//      renders to exactly the same audio, bit for bit. Also from "Open recent".
//   3. Collect and save copies the audio into the project, records SHA-256, keeps
//      source and licence; the folder can be moved and still plays the same,
//      with the original files gone.
//   4. A missing audio file or plugin does not stop a project opening and is not
//      lost on the next save.
//   5. Damaged, foreign, newer or hostile project files are refused with a
//      message and leave the open project alone; names are text, never markup.
//   6. The page can only write and read in folders the user chose.
//   7. Autosave and crash recovery: after a hard kill the work comes back; a
//      clean exit leaves nothing to recover; "Save changes?" is asked on New and
//      on closing the window.
//
// Needs Playwright (the Electron driver) and wavefile (dev dependency).
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { WaveFile } = require("wavefile");

let _electron;
try {
  ({ _electron } = require("playwright-core"));
} catch {
  ({ _electron } = require("playwright"));
}

const root = path.resolve(__dirname, "..");
const shots = process.argv.includes("--shots");
const shotDir = path.join(root, "docs", "progress");
const failures = [];

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures.push(name);
}

// ---- scratch folders ---------------------------------------------------------

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bdp-project-test-"));
const userData = path.join(scratch, "userdata");
const external = path.join(scratch, "external"); // stands in for a folder of the user's own samples
const projects = path.join(scratch, "projects");
for (const d of [userData, external, projects]) fs.mkdirSync(d, { recursive: true });

// a one second stereo tone outside the app
{
  const n = 44100;
  const l = new Array(n), r = new Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = Math.round(0.4 * 32767 * Math.sin((2 * Math.PI * 330 * i) / 44100));
    r[i] = Math.round(0.4 * 32767 * Math.sin((2 * Math.PI * 495 * i) / 44100));
  }
  const wav = new WaveFile();
  wav.fromScratch(2, 44100, "16", [l, r]);
  fs.writeFileSync(path.join(external, "ext.wav"), wav.toBuffer());
}

// ---- launching ---------------------------------------------------------------

const apps = [];
async function launch({ data = userData, wait = true } = {}) {
  const env = { ...process.env, BDP_TEST: "1", BDP_USER_DATA: data, BDP_GRANT_READ: external };
  delete env.NODE_OPTIONS;
  const app = await _electron.launch({
    executablePath: require(path.join(root, "node_modules", "electron")),
    args: [root, "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    cwd: root,
    env,
  });
  apps.push(app);
  const page = await app.firstWindow();
  const problems = [];
  page.on("console", (m) => { if (m.type() === "error") problems.push("console error: " + m.text()); });
  page.on("pageerror", (e) => problems.push("uncaught: " + e.message));
  await page.waitForFunction(() => !!window.__bdp, null, { timeout: 30000 });
  if (wait) await settled(page);
  return { app, page, problems };
}

// everything on the playlist has been read
async function settled(page) {
  await page.waitForFunction(
    () => window.__bdp.globals.playlist.getTracks().every((t) => t.getSamples().every((s) => s.isLoaded() || s.hasFailed())),
    null,
    { timeout: 20000 },
  );
  await page.waitForTimeout(150);
}

const answers = (app, dialogs) => app.evaluate((_, d) => { globalThis.__bdpTestDialogs = d; }, dialogs);

// the whole project as text, without the save time (which differs on purpose)
const state = (page) =>
  page.evaluate(() => {
    const d = window.__bdp.session.capture();
    delete d.savedAt;
    return JSON.stringify(d);
  });

// a hash of the audio the project renders to
const audioHash = (page) =>
  page.evaluate(async () => {
    const { globals, renderProject } = window.__bdp;
    const buf = await renderProject(globals.mixer, globals.playlist, { sampleRate: 44100 });
    const parts = [];
    for (let c = 0; c < buf.numberOfChannels; c++) parts.push(new Uint8Array(buf.getChannelData(c).buffer.slice(0)));
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.length; }
    const digest = await crypto.subtle.digest("SHA-256", all);
    let peak = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) for (const v of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("") + ":" + buf.length + ":" + peak.toFixed(4);
  });

const undoSteps = (page) => page.evaluate(() => window.__bdp.session.history.labels().length);
const dirty = (page) => page.evaluate(() => window.__bdp.session.isDirty());

async function menu(page, header, label) {
  await page.click("#header_menu_" + header);
  const item = page.locator(".menu_dropdown > .context_item > span:first-child").filter({ hasText: new RegExp("^" + label + "$") }).first();
  await item.click();
}

const dialogText = async (page) => (await page.locator(".dialog_box").first().textContent()) || "";
async function pressDialog(page, button) {
  await page.locator(".dialog_button", { hasText: button }).first().click();
  await page.locator(".dialog_overlay").waitFor({ state: "detached", timeout: 5000 });
}
async function shot(page, name) {
  if (!shots) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, name + ".png") });
  console.log("screenshot: docs/progress/" + name + ".png");
}

// ---- the edits, each done the way a user does it ------------------------------

// Does the action, then checks: the project changed, it is one undo step, Ctrl+Z gives back exactly
// the project from before, Ctrl+Shift+Z exactly the project from after. Leaves the edit applied.
async function edited(page, name, action) {
  const before = await state(page);
  const stepsBefore = await undoSteps(page);
  await action();
  await page.waitForTimeout(700); // gestures that end on a timer (plugin controls)
  const after = await state(page);
  const stepsAfter = await undoSteps(page);
  check(`${name}: changes the project`, before !== after);
  check(`${name}: is one undo step`, stepsAfter === stepsBefore + 1, `${stepsBefore} -> ${stepsAfter}`);
  await page.keyboard.press("Control+z");
  const undone = await state(page);
  check(`${name}: undo gives back the project from before`, undone === before);
  await page.keyboard.press("Control+Shift+z");
  const redone = await state(page);
  check(`${name}: redo gives back the project from after`, redone === after);
}

const trackBox = (page, i) => page.locator(".track").nth(i).boundingBox();
const channelStrip = (page, i) => page.locator(".mixer_channels .channel").nth(i);

async function dragFromPalette(page, file, trackIndex, dx) {
  const item = page.getByText(file, { exact: true }).first();
  await item.waitFor({ timeout: 5000 });
  const from = await item.boundingBox();
  const track = await trackBox(page, trackIndex);
  await page.mouse.move(from.x + 10, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + 4, { steps: 5 });
  await page.mouse.move(track.x + dx, track.y + track.height / 2, { steps: 25 });
  await page.mouse.move(track.x + dx + 10, track.y + track.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}

// where a clip's title bar is on screen
async function clipSpot(page, trackIndex, clipIndex) {
  const canvas = await page.locator(".tracks_canvas").first().boundingBox();
  const track = await trackBox(page, trackIndex);
  const beat = await page.evaluate(([t, c]) => window.__bdp.globals.playlist.getTracks()[t].getSamples()[c].getStartBeat(), [trackIndex, clipIndex]);
  const xsnap = await page.evaluate(() => window.__bdp.globals.xsnap);
  return { x: canvas.x + beat * xsnap + 12, y: track.y + 6, track };
}

// a click on the bare part of a track's header (the context menu only opens there)
async function rightClickHeader(page, i) {
  const spot = await page.locator(".track").nth(i).locator(".description").evaluate((el) => {
    const r = el.getBoundingClientRect();
    for (let y = 2; y < r.height; y += 3) {
      for (let x = 2; x < r.width; x += 3) {
        if (document.elementFromPoint(r.left + x, r.top + y) === el) return { x: r.left + x, y: r.top + y };
      }
    }
    return null;
  });
  await page.mouse.click(spot.x, spot.y, { button: "right" });
}

async function selectPlugin(page, slot, name) {
  await page.locator(".plugin_slot").nth(slot).click({ button: "right" });
  await page.locator(".context_menu .context_item:visible", { hasText: new RegExp("^" + name + "$") }).first().click();
}

// ================================================================================
(async () => {
  const projectA = path.join(projects, "Beat A");
  const moved = path.join(projects, "Beat A moved");
  let A, hashA;

  // ---- 1. edits and undo, then save -----------------------------------------
  {
    const { app, page, problems } = await launch();
    await page.getByText("samples", { exact: true }).first().click();

    check("a new project starts clean", !(await dirty(page)) && (await undoSteps(page)) === 0);
    check("the window title names the project", (await page.title()) === "Untitled – butterDAWg", await page.title());

    // clips: drop from the browser (twice), and one from outside the app
    await edited(page, "add a clip from the browser", () => dragFromPalette(page, "kick1.wav", 0, 200));
    await edited(page, "add a second clip", () => dragFromPalette(page, "drum loop 3.wav", 1, 260));
    await edited(page, "add a clip from outside the app", async () => {
      await page.evaluate((dir) => {
        const { globals, Sample, edit } = window.__bdp;
        const s = new Sample({ path: dir + "/ext.wav", title: "ext.wav" });
        s.setStartBeat(6);
        globals.playlist.getTracks()[6].addSample(s);
        edit.recordAddClip(s);
      }, external);
    });
    await settled(page);

    // moving a clip: along its track, and to another track
    await edited(page, "move a clip along its track", async () => {
      const at = await clipSpot(page, 0, 0);
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(at.x + 60, at.y, { steps: 8 });
      await page.mouse.move(at.x + 120, at.y, { steps: 8 });
      await page.mouse.up();
    });
    await edited(page, "move a clip to another track", async () => {
      const at = await clipSpot(page, 1, 0);
      const target = await trackBox(page, 3);
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(at.x + 20, target.y + 8, { steps: 12 });
      await page.mouse.up();
    });
    await edited(page, "add a clip to delete", () => dragFromPalette(page, "kick6.wav", 4, 240));
    await edited(page, "delete a clip (select it, press Delete)", async () => {
      const at = await clipSpot(page, 4, 0);
      await page.mouse.click(at.x, at.y);
      await page.keyboard.press("Delete");
    });

    // tracks
    await edited(page, "mute a track", () => page.locator(".track").nth(2).locator(".radio_btn").click());
    await edited(page, "solo a track", () => page.locator(".track").nth(4).locator(".radio_btn").click({ button: "right" }));
    await edited(page, "unsolo", () => page.locator(".track").nth(4).locator(".radio_btn").click({ button: "right" }));
    await edited(page, "rename a track (double click, type, Enter)", async () => {
      await page.locator(".track").nth(3).locator("#track_title").dblclick();
      await page.keyboard.press("Control+a");
      await page.keyboard.type("Hi-hats");
      await page.keyboard.press("Enter");
    });
    await edited(page, "change a track's colour", () =>
      page.evaluate(() => window.__bdp.edit.setTrackColor(window.__bdp.globals.playlist.getTracks()[5], "#a3469b")));
    await edited(page, "route a track to another channel", async () => {
      await rightClickHeader(page, 5);
      await page.locator(".context_menu .context_item:visible", { hasText: /^Track mode$/ }).first().click();
      await page.locator(".context_menu .context_item:visible", { hasText: /^Channel 3$/ }).first().click();
    });

    // mixer
    await edited(page, "move a channel fader", async () => {
      const knob = await channelStrip(page, 1).locator(".channel_volume_knob").boundingBox();
      await page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2);
      await page.mouse.down();
      await page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2 + 40, { steps: 10 });
      await page.mouse.up();
    });
    await edited(page, "turn a pan knob", async () => {
      const knob = await channelStrip(page, 1).locator(".channel_pan").boundingBox();
      await page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2);
      await page.mouse.down();
      await page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2 - 20, { steps: 10 });
      await page.mouse.up();
    });
    await edited(page, "mute a channel", () => channelStrip(page, 2).locator(".channel_toggle").click());
    await edited(page, "rename a channel", async () => {
      await channelStrip(page, 1).locator(".channel_label p").dblclick();
      await page.keyboard.press("Control+a");
      await page.keyboard.type("Drums");
      await page.keyboard.press("Enter");
    });

    // plugins, on channel 1 (select it first)
    await channelStrip(page, 1).locator(".channel_label").click();
    await edited(page, "add a plugin", () => selectPlugin(page, 0, "Gain"));
    await edited(page, "change a plugin's setting", async () => {
      await page.locator(".plugin_slot").nth(0).click();
      const slider = page.locator('[id^="p-"] #slider-param1').first();
      await slider.waitFor({ timeout: 5000 });
      await slider.evaluate((el) => { el.value = "35"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    });
    {
      // the plugin's window is still open: it has to show what is sounding after an undo and a redo
      const slider = page.locator('[id^="p-"] #slider-param1').first();
      const sounding = () => page.evaluate(() => Math.round(window.__bdp.globals.mixer.getChannels()[1].getPlugins()[0].getParams().level * 100));
      await page.keyboard.press("Control+z");
      const shownUndone = Number(await slider.inputValue());
      check("after an undo the plugin's window shows the value that is sounding", shownUndone === (await sounding()) && shownUndone !== 35, `shows ${shownUndone}`);
      await page.keyboard.press("Control+Shift+z");
      check("after a redo it shows the changed value again", Number(await slider.inputValue()) === 35 && (await sounding()) === 35);
    }
    await edited(page, "bypass a plugin", () => page.locator(".plugin_slot").nth(0).locator(".plugin_toggle").click());
    await edited(page, "enable it again", () => page.locator(".plugin_slot").nth(0).locator(".plugin_toggle").click());
    await edited(page, "add a second plugin", () => selectPlugin(page, 1, "SimpleDistortion"));
    await edited(page, "remove a plugin", async () => {
      await page.locator(".plugin_slot").nth(1).click({ button: "right" });
      await page.locator(".context_menu .context_item:visible", { hasText: /^Remove$/ }).first().click();
    });

    // tempo
    await edited(page, "change the tempo", async () => {
      const bpm = await page.locator(".bpm").boundingBox();
      await page.mouse.move(bpm.x + bpm.width / 2, bpm.y + bpm.height / 2);
      await page.mouse.down();
      await page.mouse.move(bpm.x + bpm.width / 2, bpm.y + bpm.height / 2 - 40, { steps: 10 });
      await page.mouse.up();
    });

    // another channel with a distortion that is on and a gain that is bypassed: both settings have to survive the save
    await channelStrip(page, 3).locator(".channel_label").click();
    await selectPlugin(page, 0, "SimpleDistortion");
    await page.locator(".plugin_slot").nth(0).click();
    const slider2 = page.locator('[id^="p-"] #slider-param1').last();
    await slider2.waitFor({ timeout: 5000 });
    await slider2.evaluate((el) => { el.value = "70"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.waitForTimeout(600);
    await selectPlugin(page, 1, "Gain");
    await page.locator(".plugin_slot").nth(1).locator(".plugin_toggle").click();

    // let sound reach the plugins: clips on tracks that play through the channels above (the ext clip plays straight to the master)
    await page.evaluate(() => {
      const { globals, edit } = window.__bdp;
      const tracks = globals.playlist.getTracks();
      const channels = globals.mixer.getChannels();
      edit.routeTrack(tracks[0], channels[1]);
      edit.routeTrack(tracks[3], channels[3]);
      edit.routeTrack(tracks[6], globals.mixer.getMaster());
    });

    check("edits made the project dirty and the title shows it", (await dirty(page)) && (await page.title()).startsWith("• "), await page.title());
    await shot(page, "phase3-edited");

    // the Edit menu says what undo and redo would do
    await page.click("#header_menu_edit");
    const editMenu = await page.locator(".menu_dropdown").first().textContent();
    check("the Edit menu names the next undo", /^Undo Route track/.test(editMenu), editMenu.slice(0, 60));
    await shot(page, "phase3-edit-menu");
    await page.keyboard.press("Escape");

    // ---- save as, through the File menu
    await answers(app, { save: [projectA] });
    await page.click("#header_menu_file");
    await shot(page, "phase3-file-menu");
    await page.keyboard.press("Escape");
    await menu(page, "file", "Save as…");
    await page.waitForFunction(() => !window.__bdp.session.isDirty(), null, { timeout: 10000 });
    const file = path.join(projectA, "project.json");
    check("Save as writes project.json in the chosen folder", fs.existsSync(file));
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    check("the file is versioned and named", saved.format === "butterdawg-project" && saved.version === 1 && saved.name === "Beat A", `${saved.format} v${saved.version} ${saved.name}`);
    check("saving cleared the dirty mark and named the window", !(await dirty(page)) && (await page.title()) === "Beat A – butterDAWg", await page.title());
    check("the first save keeps no backup yet", !fs.existsSync(file + ".bak"));

    const lib = saved.assets.find((a) => a.name === "kick1.wav");
    check("a library clip records where it came from", lib && lib.location === "app" && lib.source.kind === "library" && lib.source.library === "Starter samples", JSON.stringify(lib && lib.source));
    check("a library clip with no recorded licence says so", lib && lib.licence === null);

    // a second save over the first keeps the one before
    await page.evaluate(() => window.__bdp.edit.renameChannel(window.__bdp.globals.mixer.getChannels()[4], "Bus"));
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => !window.__bdp.session.isDirty(), null, { timeout: 10000 });
    check("saving again (Ctrl+S) keeps the previous version as project.json.bak", fs.existsSync(file + ".bak") && JSON.parse(fs.readFileSync(file + ".bak", "utf8")).mixer.channels[4].name !== "Bus");

    A = await state(page);
    hashA = await audioHash(page);
    check("the project renders to real sound", parseFloat(hashA.split(":")[2]) > 0.05, "peak " + hashA.split(":")[2]);
    check("no errors in the page while editing", problems.length === 0, problems.slice(0, 3).join(" | "));
    await app.close();
  }

  // ---- 2. a clean exit leaves nothing to recover; reopen; compare -------------
  {
    const { app, page, problems } = await launch();
    check("a clean exit leaves nothing to recover", (await page.locator(".dialog_box").count()) === 0 && !fs.existsSync(path.join(userData, "recovery", "recovery.json")));

    await answers(app, { open: [projectA] });
    await menu(page, "file", "Open…");
    await page.waitForFunction(() => window.__bdp.session.name === "Beat A", null, { timeout: 10000 });
    await settled(page);

    const B = await state(page);
    check("reopened: every value is the same as when it was saved", B === A);
    if (B !== A) {
      const a = JSON.parse(A), b = JSON.parse(B);
      for (const k of Object.keys(a)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) console.log("   differs: " + k);
    }
    check("reopened: the sound is bit for bit the same", (await audioHash(page)) === hashA);
    check("reopened: nothing to undo and nothing unsaved", !(await dirty(page)) && (await undoSteps(page)) === 0);
    check("reopened: the window shows the project's tracks, channels and plugins", await page.evaluate(() => {
      const tracks = [...document.querySelectorAll(".track #track_title")].map((e) => e.textContent);
      const labels = [...document.querySelectorAll(".mixer_channels .channel_label p")].map((e) => e.textContent);
      return tracks[3] === "Hi-hats" && labels[1] === "Drums" && labels.length === 5;
    }));
    await page.keyboard.press("Control+z");
    check("undo after opening does nothing (the history starts empty)", (await state(page)) === A);
    await shot(page, "phase3-reopened");

    // from the recent list
    await menu(page, "file", "New project");
    await page.waitForFunction(() => window.__bdp.session.name === "Untitled", null, { timeout: 10000 });
    await page.click("#header_menu_file");
    await page.locator(".menu_dropdown .context_item.has_sub").first().hover();
    await shot(page, "phase3-recent");
    await page.locator(".menu_sub .context_item", { hasText: "Beat A" }).first().click();
    await page.waitForFunction(() => window.__bdp.session.name === "Beat A", null, { timeout: 10000 });
    await settled(page);
    check("Open recent brings back the same project", (await state(page)) === A && (await audioHash(page)) === hashA);

    // ---- 3. collect and save
    const clips = JSON.parse(A).assets.length;
    await menu(page, "file", "Collect and save");
    // (the file is written last: wait for it, not for the page)
    for (let i = 0; i < 150; i++) {
      const now = JSON.parse(fs.readFileSync(path.join(projectA, "project.json"), "utf8"));
      if (now.assets.every((a) => a.location === "project")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const collected = JSON.parse(fs.readFileSync(path.join(projectA, "project.json"), "utf8"));
    check("collect and save: every audio file is now in the project", collected.assets.length === clips && collected.assets.every((a) => a.location === "project" && a.path.startsWith("assets/") && fs.existsSync(path.join(projectA, a.path))));
    check("collect and save: every file records its SHA-256, and it is right", collected.assets.every((a) => a.sha256 === crypto.createHash("sha256").update(fs.readFileSync(path.join(projectA, a.path))).digest("hex")));
    const extAsset = collected.assets.find((a) => a.name === "ext.wav");
    const libAsset = collected.assets.find((a) => a.name === "kick1.wav");
    check("collect and save: source and licence are kept", extAsset.source.kind === "imported" && extAsset.licence === null && libAsset.source.library === "Starter samples");
    check("collect and save: the file keeps no folder names from the user's computer", !JSON.stringify(collected).includes(scratch));
    check("collect and save: the sound is bit for bit the same", (await audioHash(page)) === hashA);

    // move the folder and remove the original files: it has to play from where it is
    await app.close();
    fs.cpSync(projectA, moved, { recursive: true });
    fs.rmSync(path.join(external, "ext.wav"));
    check("no errors in the page while opening and collecting", problems.length === 0, problems.slice(0, 3).join(" | "));
  }

  // ---- 4. the moved folder; a missing file and a missing plugin ----------------
  {
    const { app, page } = await launch();
    await answers(app, { open: [moved] });
    await menu(page, "file", "Open…");
    await page.waitForFunction(() => window.__bdp.session.name === "Beat A", null, { timeout: 10000 });
    await settled(page);
    check("a moved project folder plays the same, with the original files gone", (await audioHash(page)) === hashA);
    await app.close();
  }
  {
    // lose an audio file and a plugin (in a fresh app: the first one still holds the decoded file in its cache)
    const { app, page } = await launch();
    fs.rmSync(path.join(moved, "assets", "ext.wav"));
    const pj = JSON.parse(fs.readFileSync(path.join(moved, "project.json"), "utf8"));
    pj.mixer.channels[0].plugins[2] = { path: "plugins/Vanished.bdp", bypassed: false, params: { amount: 0.25 } };
    fs.writeFileSync(path.join(moved, "project.json"), JSON.stringify(pj));
    await answers(app, { open: [moved] });
    await menu(page, "file", "Open…");
    await page.locator(".dialog_box").first().waitFor({ timeout: 15000 });
    const text = await dialogText(page);
    check("a missing file and a missing plugin are reported and named", /ext\.wav/.test(text) && /Vanished/.test(text), text.slice(0, 160));
    await shot(page, "phase3-missing");
    await pressDialog(page, "OK");
    check("the project is open anyway", (await page.evaluate(() => window.__bdp.session.name)) === "Beat A");
    await menu(page, "file", "Save");
    await page.waitForTimeout(500);
    const resaved = JSON.parse(fs.readFileSync(path.join(moved, "project.json"), "utf8"));
    check("saving does not lose the missing file", resaved.assets.some((a) => a.name === "ext.wav") && resaved.tracks.some((t) => t.clips.some((c) => resaved.assets.find((a) => a.id === c.asset).name === "ext.wav")));
    check("saving does not lose the missing plugin or its setting", resaved.mixer.channels[0].plugins[2] && resaved.mixer.channels[0].plugins[2].path === "plugins/Vanished.bdp" && resaved.mixer.channels[0].plugins[2].params.amount === 0.25);
    await app.close();
  }

  // ---- 5. files that must be refused; names are text; 6. what the page may touch
  {
    const { app, page, problems } = await launch();
    const good = JSON.parse(fs.readFileSync(path.join(projectA, "project.json"), "utf8"));
    const crafted = (name, mutate) => {
      const d = path.join(projects, name);
      fs.cpSync(path.join(projectA, "assets"), path.join(d, "assets"), { recursive: true });
      const p = JSON.parse(JSON.stringify(good));
      const text = mutate(p);
      fs.writeFileSync(path.join(d, "project.json"), typeof text === "string" ? text : JSON.stringify(p));
      return d;
    };
    const attempt = async (dir) => {
      const before = await state(page);
      await answers(app, { open: [dir] });
      await menu(page, "file", "Open…");
      await page.locator(".dialog_box").first().waitFor({ timeout: 10000 });
      const text = await dialogText(page);
      await pressDialog(page, "OK");
      return { text, untouched: (await state(page)) === before };
    };

    let r = await attempt(crafted("damaged", () => "{ this is not json"));
    check("a damaged file is refused with a message and the open project is left alone", /Cannot open/.test(r.text) && /damaged|JSON/i.test(r.text) && r.untouched, r.text.slice(0, 120));
    r = await attempt(crafted("foreign", () => JSON.stringify({ hello: "world" })));
    check("a file that is not a butterDAWg project is refused", /not a butterDAWg project/.test(r.text) && r.untouched, r.text.slice(0, 120));
    r = await attempt(crafted("newer", (p) => { p.version = 999; }));
    check("a project from a newer app is refused and says so", /newer butterDAWg/.test(r.text) && r.untouched, r.text.slice(0, 120));
    r = await attempt(crafted("traversal", (p) => { p.assets[0].location = "project"; p.assets[0].path = "assets/../../../etc/passwd"; }));
    check("an asset path that leaves the project folder is refused", /Cannot open/.test(r.text) && r.untouched, r.text.slice(0, 120));
    r = await attempt(crafted("bad-value", (p) => { p.mixer.channels[0].volume = "loud"; }));
    check("a wrong value is refused and named", /volume/.test(r.text) && r.untouched, r.text.slice(0, 120));
    {
      const d = path.join(projects, "empty-folder");
      fs.mkdirSync(d, { recursive: true });
      r = await attempt(d);
      check("a folder with no project.json is refused", /no project\.json/.test(r.text) && r.untouched, r.text.slice(0, 120));
    }

    // names are text
    const hostile = crafted("hostile", (p) => {
      p.name = "hostile";
      p.tracks[0].title = '<img src=x onerror="window.__pwned=1">';
      p.mixer.channels[1].name = "<b id=pwned2>bold</b>";
    });
    await answers(app, { open: [hostile] });
    await menu(page, "file", "Open…");
    await page.waitForFunction(() => window.__bdp.session.name === "hostile", null, { timeout: 10000 });
    // (the audio file this project points to is gone, so the app says so)
    await page.locator(".dialog_overlay").first().waitFor({ timeout: 5000 }).then(() => pressDialog(page, "OK")).catch(() => {});
    const hostileOk = await page.evaluate(() => ({
      pwned: window.__pwned === undefined,
      shown: document.querySelector(".track #track_title").textContent,
      img: document.querySelectorAll(".track img").length,
      channel: document.querySelectorAll(".mixer_channels .channel_label p b").length,
      channelText: document.querySelectorAll(".mixer_channels .channel_label p")[1].textContent,
    }));
    check("a track name with markup in it is shown as text and runs nothing", hostileOk.pwned && hostileOk.img === 0 && hostileOk.shown.startsWith("<img"), JSON.stringify(hostileOk));
    check("a channel name with markup in it is shown as text", hostileOk.channel === 0 && hostileOk.channelText.startsWith("<b"));
    await rightClickHeader(page, 0);
    await page.locator(".context_menu .context_item:visible", { hasText: /^Track mode$/ }).first().click();
    const menuNames = await page.evaluate(() => ({ b: document.querySelectorAll(".context_menu b").length, text: [...document.querySelectorAll(".context_menu .context_item")].some((e) => e.textContent === "<b id=pwned2>bold</b>") }));
    check("channel names in menus are text too", menuNames.b === 0 && menuNames.text, JSON.stringify(menuNames));
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);

    // what the page may read and write
    const probe = await page.evaluate(async ({ outside, projectDir, extFile }) => {
      const out = {};
      const tryIt = async (name, fn) => { try { await fn(); out[name] = "allowed"; } catch (e) { out[name] = "refused"; } };
      await tryIt("write outside", () => window.bridge.project.writeProject(outside, "{}"));
      await tryIt("copy outside", () => window.bridge.project.copyAssets(outside, [{ from: "files/samples/kick1.wav", name: "x.wav" }]));
      await tryIt("copy from a folder not chosen", () => window.bridge.project.copyAssets(projectDir, [{ from: outside + "/../x", name: "x.wav" }]));
      await tryIt("read project.json through the file bridge", () => window.bridge.fs.readFile(projectDir + "/project.json"));
      await tryIt("read an asset of the open project", () => window.bridge.fs.readFile(projectDir + "/assets/kick1.wav"));
      await tryIt("read the user's folder", () => window.bridge.fs.readFile(extFile));
      await tryIt("recent for a project not in the list", () => window.bridge.project.openRecent(outside));
      return out;
    }, { outside: path.join(scratch, "not-chosen"), projectDir: hostile, extFile: "/etc/hostname" });
    check("the page cannot write to a folder the user did not choose", probe["write outside"] === "refused" && probe["copy outside"] === "refused");
    check("the page cannot copy files it cannot read", probe["copy from a folder not chosen"] === "refused");
    check("the page cannot read project.json or other files in a project folder directly", probe["read project.json through the file bridge"] === "refused" && probe["read the user's folder"] === "refused", JSON.stringify(probe));
    check("the page cannot open a project that is not in the recent list", probe["recent for a project not in the list"] === "refused");
    check("no errors in the page while opening bad files", problems.length === 0, problems.slice(0, 3).join(" | "));
    await app.close();
  }

  // ---- 7. "Save changes?", autosave and a crash --------------------------------
  {
    const fresh = path.join(scratch, "userdata2");
    fs.mkdirSync(fresh);
    const { app, page } = await launch({ data: fresh });
    await page.evaluate(() => window.__bdp.edit.renameChannel(window.__bdp.globals.mixer.getChannels()[2], "Keys"));
    check("an edit makes the project unsaved", await dirty(page));
    const marked = await state(page);

    await menu(page, "file", "New project");
    await page.locator(".dialog_box").first().waitFor({ timeout: 5000 });
    check("New asks about unsaved changes first", /Save changes\?/.test(await dialogText(page)));
    await shot(page, "phase3-save-changes");
    await pressDialog(page, "Cancel");
    check("Cancel leaves the project as it was", (await state(page)) === marked && (await dirty(page)));

    // closing the window asks too (switched on for this test)
    await app.evaluate(() => { globalThis.__bdpCloseGuard = true; });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await page.locator(".dialog_box").first().waitFor({ timeout: 5000 });
    check("closing the window with unsaved work asks first", /Save changes\?/.test(await dialogText(page)) && !page.isClosed());
    await pressDialog(page, "Cancel");
    check("Cancel keeps the window open", !page.isClosed());
    await app.evaluate(() => { globalThis.__bdpCloseGuard = false; });

    // autosave, then a hard kill
    check("autosave writes the unsaved work", (await page.evaluate(() => window.__bdp.session.autosaveNow())) === true);
    check("autosave writes nothing when nothing changed", (await page.evaluate(() => window.__bdp.session.autosaveNow())) === false);
    const rec = path.join(fresh, "recovery", "recovery.json");
    check("the recovery file exists", fs.existsSync(rec));
    app.process().kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 800));
  }
  {
    const fresh = path.join(scratch, "userdata2");
    const { app, page } = await launch({ data: fresh, wait: false });
    await page.locator(".dialog_box").first().waitFor({ timeout: 15000 });
    check("after a crash the app offers to recover the work", /Recover your work\?/.test(await dialogText(page)));
    await shot(page, "phase3-recovery");
    await pressDialog(page, "Recover");
    await settled(page);
    const channels = await page.evaluate(() => window.__bdp.globals.mixer.getChannels().map((c) => c.getName()));
    check("recovered work is back, and is still unsaved", channels[2] === "Keys" && (await dirty(page)), channels.join(","));
    await app.close(); // a clean exit
  }
  {
    const fresh = path.join(scratch, "userdata2");
    const { app, page } = await launch({ data: fresh });
    check("after a clean exit there is nothing to recover", (await page.locator(".dialog_box").count()) === 0 && !fs.existsSync(path.join(fresh, "recovery", "recovery.json")));
    // crash again, and this time discard
    await page.evaluate(() => window.__bdp.edit.renameChannel(window.__bdp.globals.mixer.getChannels()[1], "Lost"));
    await page.evaluate(() => window.__bdp.session.autosaveNow());
    app.process().kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 800));
  }
  {
    const fresh = path.join(scratch, "userdata2");
    const { app, page } = await launch({ data: fresh, wait: false });
    await page.locator(".dialog_box").first().waitFor({ timeout: 15000 });
    await pressDialog(page, "Discard");
    await settled(page);
    const channels = await page.evaluate(() => window.__bdp.globals.mixer.getChannels().map((c) => c.getName()));
    check("Discard drops the recovered work for good", channels[1] === "Channel 1" && !fs.existsSync(path.join(fresh, "recovery", "recovery.json")), channels.join(","));
    await app.close();
  }

  // ---- 8. things a code review found: each one is reproduced here -----------------
  {
    const lib = path.join(root, "files", "samples", "kick1.wav");
    const addClip = (page, spec) => page.evaluate(({ track, file, name, beat }) => {
      const { globals, Sample, edit } = window.__bdp;
      const sample = new Sample({ path: file, title: name });
      sample.setStartBeat(beat);
      globals.playlist.getTracks()[track].addSample(sample);
      edit.recordAddClip(sample);
    }, spec);
    const readProject = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
    const data8 = path.join(scratch, "userdata8");
    fs.mkdirSync(data8, { recursive: true });

    // -- Save As that fails keeps the project where it was
    {
      const { app, page } = await launch({ data: data8 });
      await addClip(page, { track: 0, file: lib, name: "kick1", beat: 0 });
      const home = path.join(projects, "Review home");
      await answers(app, { save: [home] });
      await menu(page, "file", "Save as…");
      await page.waitForFunction(() => window.__bdp.session.name === "Review home" && !window.__bdp.session.isDirty(), null, { timeout: 10000 });
      await addClip(page, { track: 1, file: lib, name: "kick1 again", beat: 4 });
      const before = await state(page);
      const clipPaths = () => page.evaluate(() => [...window.__bdp.globals.playlist.getClips()].map((c) => c.path));
      const pathsBefore = await clipPaths();

      // a folder whose project.json is a folder: the copy of the audio works, then writing the project fails
      const bad = path.join(projects, "Review bad target");
      fs.mkdirSync(path.join(bad, "project.json"), { recursive: true });
      await answers(app, { save: [bad] });
      await menu(page, "file", "Save as…");
      await page.locator(".dialog_box").first().waitFor({ timeout: 10000 });
      check("a failed Save As says so", /Cannot save/.test(await dialogText(page)));
      await pressDialog(page, "OK");
      const after = await page.evaluate(() => ({ name: window.__bdp.session.name, dir: window.__bdp.session.dir }));
      check("a failed Save As keeps the project's name and folder", after.name === "Review home" && after.dir === home, JSON.stringify(after));
      check("a failed Save As keeps the clips pointed at their files", JSON.stringify(await clipPaths()) === JSON.stringify(pathsBefore));
      check("a failed Save As changes nothing in the project", (await state(page)) === before && (await dirty(page)));
      // a plain Save still goes to the folder it came from, without asking where
      await menu(page, "file", "Save");
      await page.waitForFunction(() => !window.__bdp.session.isDirty(), null, { timeout: 10000 });
      check("Save after a failed Save As writes to the original folder", readProject(home).tracks[1].clips.length === 1);
      await app.close();
    }

    // -- an edit made while the file is being written stays unsaved
    {
      const { app, page } = await launch({ data: data8 });
      const home = path.join(projects, "Review slow save");
      await answers(app, { save: [home] });
      await page.evaluate(() => {
        const s = window.__bdp.session;
        const write = s.store.writeProject.bind(s.store);
        s.store.writeProject = async (...args) => { await new Promise((r) => (window.__releaseSave = r)); return write(...args); };
      });
      const saving = page.evaluate(() => window.__bdp.session.save());
      await page.waitForFunction(() => typeof window.__releaseSave === "function", null, { timeout: 10000 });
      await page.evaluate(() => window.__bdp.edit.renameChannel(window.__bdp.globals.mixer.getChannels()[0], "Edited while saving"));
      await page.evaluate(() => window.__releaseSave());
      await saving;
      check("an edit made during a save is not in the saved file", !fs.readFileSync(path.join(home, "project.json"), "utf8").includes("Edited while saving"));
      check("an edit made during a save leaves the project unsaved", await dirty(page));
      await app.close();
    }

    // -- undoing back to the saved state removes the recovery file the session wrote; a pending one is left alone
    {
      const fresh = path.join(scratch, "userdata8b");
      fs.mkdirSync(fresh, { recursive: true });
      const { app, page } = await launch({ data: fresh });
      await page.evaluate(() => window.__bdp.edit.renameChannel(window.__bdp.globals.mixer.getChannels()[3], "Temporary"));
      await page.evaluate(() => window.__bdp.session.autosaveNow());
      const rec = path.join(fresh, "recovery", "recovery.json");
      check("autosave wrote the recovery file", fs.existsSync(rec));
      await page.keyboard.press("Control+z");
      await page.evaluate(() => window.__bdp.session.autosaveNow());
      check("undoing back to the saved state removes the recovery file (it would bring back what was undone)", !fs.existsSync(rec));
      await app.close();
    }
    {
      const fresh = path.join(scratch, "userdata8c");
      fs.mkdirSync(path.join(fresh, "recovery"), { recursive: true });
      fs.writeFileSync(path.join(fresh, "recovery", "recovery.json"), JSON.stringify({ savedAt: new Date().toISOString(), name: "Waiting", dir: null, text: "{}" }));
      const { app, page } = await launch({ data: fresh, wait: false });
      await page.locator(".dialog_box").first().waitFor({ timeout: 15000 });
      await page.evaluate(() => window.__bdp.session.autosaveNow());
      check("autosave leaves a recovery file alone while the user is deciding about it", fs.existsSync(path.join(fresh, "recovery", "recovery.json")));
      await pressDialog(page, "Discard").catch(() => {});
      await app.close();
    }

    // -- closing a window whose page crashed keeps the work that can be recovered
    {
      const fresh = path.join(scratch, "userdata8d");
      fs.mkdirSync(fresh, { recursive: true });
      const { app, page } = await launch({ data: fresh });
      await page.evaluate(() => window.__bdp.edit.renameChannel(window.__bdp.globals.mixer.getChannels()[2], "After the crash"));
      await page.evaluate(() => window.__bdp.session.autosaveNow());
      const proc = app.process();
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.webContents.forcefullyCrashRenderer();
        setTimeout(() => win.close(), 500);
      });
      await new Promise((resolve) => { proc.once("exit", resolve); setTimeout(resolve, 8000); });
      check("the recovery file survives closing a crashed window", fs.existsSync(path.join(fresh, "recovery", "recovery.json")));
      const { app: again, page: page2 } = await launch({ data: fresh, wait: false });
      await page2.locator(".dialog_box").first().waitFor({ timeout: 15000 });
      check("and the work is offered on the next start", /Recover your work\?/.test(await dialogText(page2)));
      await pressDialog(page2, "Discard");
      await again.close();
    }

    // -- a project with more tracks than the window had rows opens without errors
    {
      const fresh = path.join(scratch, "userdata8e");
      fs.mkdirSync(fresh, { recursive: true });
      const { app, page, problems } = await launch({ data: fresh });
      const big = path.join(projects, "Review many tracks");
      fs.mkdirSync(path.join(big, "assets"), { recursive: true });
      const doc = await page.evaluate(() => {
        const d = window.__bdp.session.capture();
        const extra = JSON.parse(JSON.stringify(d.tracks[d.tracks.length - 1]));
        for (let i = 0; i < 3; i++) d.tracks.push({ ...extra, title: "Extra " + i });
        d.name = "many";
        return d;
      });
      fs.writeFileSync(path.join(big, "project.json"), JSON.stringify(doc));
      const tracksBefore = await page.locator(".track").count();
      await answers(app, { open: [big] });
      await menu(page, "file", "Open…");
      await page.waitForFunction(() => window.__bdp.session.name === "many", null, { timeout: 10000 });
      await page.waitForTimeout(300);
      const rows = await page.locator(".track").count();
      check("a project with more tracks than were showing opens and shows them all", rows === tracksBefore + 3, `${tracksBefore} -> ${rows}`);
      check("opening it raised no errors in the page", problems.length === 0, problems.slice(0, 2).join(" | "));
      await app.close();
    }

    // -- Collect and save in a project that was never saved: library files keep their source, licence and hash
    {
      const fresh = path.join(scratch, "userdata8f");
      fs.mkdirSync(fresh, { recursive: true });
      const same = path.join(external, "kick1.wav"); // the same bytes as the library's, from somewhere else
      fs.copyFileSync(lib, same);
      const { app, page } = await launch({ data: fresh });
      await addClip(page, { track: 0, file: lib, name: "library kick", beat: 0 });
      await addClip(page, { track: 1, file: same, name: "my own copy", beat: 4 });
      const home = path.join(projects, "Review collect");
      await answers(app, { save: [home] });
      await menu(page, "file", "Collect and save");
      await page.waitForFunction(() => window.__bdp.session.name === "Review collect" && !window.__bdp.session.isDirty(), null, { timeout: 15000 });
      const saved = readProject(home);
      const kicks = saved.assets.filter((a) => /^kick1(-2)?\.wav$/.test(a.name));
      const fromLibrary = saved.assets.find((a) => a.source.kind === "library");
      const imported = saved.assets.find((a) => a.source.kind === "imported");
      check("a collected library file keeps its library source and its hash", !!fromLibrary && fromLibrary.location === "project" && /^[0-9a-f]{64}$/.test(fromLibrary.sha256 || ""), JSON.stringify(fromLibrary));
      check("a collected library file keeps its credit note", !!fromLibrary && /repository/.test(fromLibrary.credit || ""));
      check("two identical files with different sources are kept as two assets", kicks.length === 2 && kicks[0].path !== kicks[1].path, JSON.stringify(kicks.map((k) => k.path)));
      check("each of them is a file in assets/, and the record of each is its own", !!imported && fs.existsSync(path.join(home, imported.path)) && fs.existsSync(path.join(home, fromLibrary.path)) && imported.path !== fromLibrary.path);
      await app.close();
    }

    // -- recovered work whose project folder is gone keeps its clips
    {
      const fresh = path.join(scratch, "userdata8g");
      fs.mkdirSync(fresh, { recursive: true });
      const home = path.join(projects, "Review vanishing");
      {
        const { app, page } = await launch({ data: fresh });
        await addClip(page, { track: 2, file: lib, name: "will be collected", beat: 8 });
        await answers(app, { save: [home] });
        await menu(page, "file", "Collect and save");
        await page.waitForFunction(() => window.__bdp.session.name === "Review vanishing" && !window.__bdp.session.isDirty(), null, { timeout: 15000 });
        await page.evaluate(() => window.__bdp.edit.renameChannel(window.__bdp.globals.mixer.getChannels()[0], "Unsaved"));
        await page.evaluate(() => window.__bdp.session.autosaveNow());
        app.process().kill("SIGKILL");
        await new Promise((r) => setTimeout(r, 800));
      }
      fs.rmSync(home, { recursive: true, force: true }); // the folder is gone before the app starts again
      {
        const { app, page } = await launch({ data: fresh, wait: false });
        await page.locator(".dialog_box").first().waitFor({ timeout: 15000 });
        // (another dialog follows at once, so the overlay does not go away in between)
        await page.locator(".dialog_button", { hasText: "Recover" }).first().click();
        await page.waitForFunction(() => window.__bdp.globals.playlist.getTracks().some((t) => t.getSamples().length > 0), null, { timeout: 10000 });
        await page.locator(".dialog_box", { hasText: "could not be loaded" }).first().waitFor({ timeout: 10000 });
        check("the app says the project's audio could not be found", /could not be loaded/.test(await dialogText(page)) && /assets\/kick1\.wav/.test(await dialogText(page)));
        await pressDialog(page, "OK");
        const kept = await page.evaluate(() => {
          const d = window.__bdp.session.capture();
          return { clips: d.tracks[2].clips.length, asset: d.assets.find((a) => a.name === "kick1.wav") };
        });
        check("recovered clips whose folder is gone are kept, with their record", kept.clips === 1 && kept.asset && kept.asset.location === "project" && kept.asset.path === "assets/kick1.wav" && kept.asset.source.kind === "library", JSON.stringify(kept));
        const rescue = path.join(projects, "Review rescued");
        await answers(app, { save: [rescue] });
        await menu(page, "file", "Save as…");
        await page.waitForFunction(() => window.__bdp.session.name === "Review rescued" && !window.__bdp.session.isDirty(), null, { timeout: 10000 });
        const resaved = readProject(rescue);
        check("saving the recovered project does not drop the clips", resaved.tracks[2].clips.length === 1 && resaved.assets.some((a) => a.path === "assets/kick1.wav"));
        await app.close();
      }
    }
  }

  for (const app of apps) await app.close().catch(() => {});
  fs.rmSync(scratch, { recursive: true, force: true });
  if (failures.length) {
    console.log(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
})().catch(async (err) => {
  console.error(err);
  for (const app of apps) await app.close().catch(() => {});
  console.log("scratch folder kept: " + scratch);
  process.exit(1);
});
