// Runs the unit tests: bundles every test/*.test.ts with esbuild (so the tests
// can import the app's TypeScript without file extensions) and runs the result
// with Node's built-in test runner.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".test-build");
rmSync(out, { recursive: true, force: true });

const entries = readdirSync(path.join(root, "test"))
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => path.join("test", f));

await build({
    absWorkingDir: root,
    entryPoints: entries,
    outdir: out,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outExtension: { ".js": ".mjs" },
    external: ["node:*"],
    logLevel: "warning",
});

const files = readdirSync(out).filter((f) => f.endsWith(".mjs")).map((f) => path.join(out, f));
const run = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit", cwd: root });
process.exit(run.status ?? 1);
