// Stand-in for Node's "fs" module in the renderer (scripts/build.mjs aliases
// "fs" to this file). The real filesystem is only reachable from the main
// process, so these calls go through window.bridge and are limited to the
// app's own folders. They stay synchronous because the existing code reads
// files that way; phase 2 moves them to async.

export function readFileSync(path: string): Uint8Array;
export function readFileSync(path: string, encoding: "utf-8" | "utf8"): string;
export function readFileSync(path: string, encoding?: string): string | Uint8Array {
    return window.bridge.fs.readFile(path, encoding);
}

export function readdirSync(path: string): string[] {
    return window.bridge.fs.readdir(path);
}

export function existsSync(path: string): boolean {
    return window.bridge.fs.exists(path);
}

export function lstatSync(path: string) {
    const isDir = window.bridge.fs.isDirectory(path);
    return {
        isDirectory: () => isDir,
        isFile: () => !isDir,
    };
}
