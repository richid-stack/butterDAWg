// Loads the app and saves a screenshot of its start-up state, for comparing
// before and after a change that should not alter how anything looks:
//
//   xvfb-run -a node scripts/snap.cjs before.png
//   ...make the change...
//   xvfb-run -a node scripts/snap.cjs after.png
//   cmp before.png after.png && echo identical
//
// No interaction happens, so identical pixels give byte-identical PNG files.
const path = require("node:path");

let _electron;
try {
  ({ _electron } = require("playwright-core"));
} catch {
  ({ _electron } = require("playwright"));
}

const root = path.resolve(__dirname, "..");
const out = path.resolve(process.argv[2] || "snap.png");

(async () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS; // Electron rejects options some sandboxes set for their proxy
  const app = await _electron.launch({
    executablePath: require(path.join(root, "node_modules", "electron")),
    args: [root, "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    cwd: root,
    env,
  });
  const page = await app.firstWindow();
  await page.reload();
  await page.waitForSelector(".plugin_slot", { timeout: 20000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: out });
  console.log("saved " + out);
  await app.close();
})().catch((e) => {
  console.error("snap failed:", e);
  process.exit(1);
});
