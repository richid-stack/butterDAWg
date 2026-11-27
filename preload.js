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
    appVersion: arg("bdp-version") || "0.0.0",
    // true only when the test scripts start the app (BDP_TEST=1); the app then
    // exposes its engine on window.__bdp so tests can drive it
    testMode: process.argv.includes("--bdp-test"),
    fs: {
        readFile: (path) => ipcRenderer.invoke("fs:readFile", path),
        list: (path) => ipcRenderer.invoke("fs:list", path),
        exists: (path) => ipcRenderer.invoke("fs:exists", path),
        },
        // projects: the main process shows the dialogs and reads and writes the folders
        project: {
            pickOpen: () => ipcRenderer.invoke("project:pickOpen"),
            openRecent: (dir) => ipcRenderer.invoke("project:openRecent", dir),
            pickSave: (suggestedName) => ipcRenderer.invoke("project:pickSave", suggestedName),
            copyAssets: (dir, items) => ipcRenderer.invoke("project:copyAssets", dir, items),
            writeProject: (dir, text) => ipcRenderer.invoke("project:write", dir, text),
            recent: () => ipcRenderer.invoke("project:recent"),
            forgetRecent: (dir) => ipcRenderer.invoke("project:forgetRecent", dir),
            readRecovery: () => ipcRenderer.invoke("project:readRecovery"),
            writeRecovery: (recovery) => ipcRenderer.invoke("project:writeRecovery", recovery),
            clearRecovery: () => ipcRenderer.invoke("project:clearRecovery"),
            setDirty: (dirty) => ipcRenderer.invoke("project:setDirty", dirty),
        },
        app: {
            // the window is being closed while there is unsaved work; the page asks the user
            onCloseRequested: (callback) => ipcRenderer.on("app:close-requested", () => callback()),
            confirmClose: () => ipcRenderer.invoke("app:confirmClose"),
        },
});
