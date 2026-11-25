// Bundles the renderer (src/index.ts) into dist/renderer.js.
//
// The renderer runs with contextIsolation on and Node off. Files are read
// through src/platform/files.ts, which uses the preload bridge (see preload.js
// and main.js).
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  absWorkingDir: root,
  entryPoints: ["src/index.ts"],
  outfile: "dist/renderer.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
});
