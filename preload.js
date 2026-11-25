// Runs in the sandboxed preload context, so it only uses Electron's own
// modules. It exposes a small read-only file API to the page as window.bridge.
// The main process (main.js) does the real work and decides what is allowed.
const { contextBridge, ipcRenderer } = require("electron");

// main.js passes these as command-line arguments of the page
const arg = (name) => {
    const prefix = "--" + name + "=";
    const hit = process.argv.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : undefined;
};

contextBridge.exposeInMainWorld("bridge", {
    appRoot: arg("bdp-root"),
    // true only when the test scripts start the app (BDP_TEST=1); the app then
    // exposes its engine on window.__bdp so tests can drive it
    testMode: process.argv.includes("--bdp-test"),
    fs: {
        readFile: (path) => ipcRenderer.invoke("fs:readFile", path),
        list: (path) => ipcRenderer.invoke("fs:list", path),
        exists: (path) => ipcRenderer.invoke("fs:exists", path),
    },
});
