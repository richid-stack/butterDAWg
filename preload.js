// Runs in the sandboxed preload context, so it only uses Electron's own
// modules. It exposes a small read-only file API to the page as window.bridge.
// The main process (main.js) does the real work and decides what is allowed.
const { contextBridge, ipcRenderer } = require("electron");

function call(channel, ...args) {
    const result = ipcRenderer.sendSync(channel, ...args);
    if (!result.ok) {
        throw new Error(result.error);
    }
    return result.data;
}

contextBridge.exposeInMainWorld("bridge", {
    appRoot: call("app:root"),
    fs: {
        readFile: (path, encoding) => call("fs:readFile", path, encoding),
        readdir: (path) => call("fs:readdir", path),
        exists: (path) => call("fs:exists", path),
        isDirectory: (path) => call("fs:isDirectory", path),
    },
});
