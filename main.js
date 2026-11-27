const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const { createProjectStore } = require('./projects-main')

const TEST_MODE = process.env.BDP_TEST === '1'
// tests keep the recent list and the recovery file away from the real ones
if (TEST_MODE && process.env.BDP_USER_DATA) {
    app.setPath('userData', process.env.BDP_USER_DATA)
}
// in tests a folder outside the app can be made readable, standing in for a library the user added
const TEST_READ_ROOTS = TEST_MODE && process.env.BDP_GRANT_READ ? process.env.BDP_GRANT_READ.split(path.delimiter) : []

// Reload the window when a file changes, while developing. It is a dev
// dependency, so packaged builds do not have it; the tests turn it off because
// a reload in the middle of a run would throw the run away.
if (process.env.BDP_TEST !== "1" && process.env.BDP_NO_RELOAD !== "1") {
    try {
        require("electron-reloader")(module);
    } catch (_) {}
}

// The folder that holds index.html (inside the asar archive when packaged).
const APP_ROOT = __dirname;

// The renderer has no Node access. It reads files through the calls below,
// and only inside these folders.
const READABLE_ROOTS = ["files", "plugins"].map(d => path.join(APP_ROOT, d));

let mainWindow = null;
let store = null; // the project files (projects-main.js), made once the app is ready
let dirty = false; // unsaved work in the open project, reported by the page
let forceClose = false; // the page has asked and the user has answered: close now

function isInside(child, parent) {
    const rel = path.relative(parent, child);
    return rel === "" || (rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel));
}

// Resolves a path requested by the renderer (relative to APP_ROOT, or
// absolute) and refuses anything that ends up outside the readable folders,
// including through symlinks.
async function resolveReadable(requested) {
    if (typeof requested !== "string") {
        throw new Error("path must be a string");
    }
    const real = await fs.promises.realpath(path.resolve(APP_ROOT, requested));
    const roots = [];
    // the app's own folders, the assets folder of each project the user has opened or saved, and (in tests) extra folders
    for (const r of [...READABLE_ROOTS, ...(store ? store.extraReadableRoots() : []), ...TEST_READ_ROOTS]) {
        try { roots.push(await fs.promises.realpath(r)); } catch { /* folder missing */ }
    }
    if (!roots.some(r => isInside(real, r))) {
        throw new Error("path is outside the readable folders: " + requested);
    }
    return real;
}

// Every call is asynchronous, so reading a large file never freezes the
// window, and only answers the main window.
function handle(channel, fn) {
    ipcMain.handle(channel, (event, ...args) => {
        if (!mainWindow || event.sender !== mainWindow.webContents) {
            throw new Error("untrusted sender");
        }
        return fn(...args);
    });
}

const createWindow = () => {
    const win = new BrowserWindow({
      width: 1800,
      height: 1000,
      autoHideMenuBar: false, // TODO just for debugging purposes of the packaged app
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // a DAW has to keep time while it is in the background or minimised
        backgroundThrottling: false,
        // the audio engine starts the audio context itself
        autoplayPolicy: 'no-user-gesture-required',
        // arguments the preload reads (see preload.js)
        additionalArguments: [
            '--bdp-root=' + APP_ROOT,
            '--bdp-version=' + app.getVersion(),
            ...(TEST_MODE ? ['--bdp-test'] : []),
        ],
      },
        titleBarOverlay: {
            color: '#2f3241',
            symbolColor: '#74b1be'
        }
    });

    // the app never opens or navigates to other pages
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());

    win.loadFile('index.html')

    // Closing the window with unsaved work asks the page first (it shows "Save changes?").
    // Tests close the app without being asked, unless they switch the question on.
    win.on('close', (e) => {
        const asks = !TEST_MODE || globalThis.__bdpCloseGuard === true
        if (!forceClose && dirty && asks && !win.webContents.isCrashed()) {
            e.preventDefault()
            win.webContents.send('app:close-requested')
            return
        }
        // a normal exit: there is nothing left to recover
        if (store) store.clearRecoverySync()
    })

    mainWindow = win;
}

// Where the user is asked for a folder. Tests answer the question themselves by putting
// the answers in globalThis.__bdpTestDialogs = { open: [...], save: [...] } (null = cancel).
async function chooseFolder(kind, suggestedName) {
    const scripted = TEST_MODE && globalThis.__bdpTestDialogs && globalThis.__bdpTestDialogs[kind]
    if (scripted && scripted.length > 0) return scripted.shift()
    if (kind === 'open') {
        const r = await dialog.showOpenDialog(mainWindow, { title: 'Open project', properties: ['openDirectory'] })
        return r.canceled ? null : r.filePaths[0]
    }
    const r = await dialog.showSaveDialog(mainWindow, {
        title: 'Save project as',
        buttonLabel: 'Save',
        defaultPath: path.join(app.getPath('documents'), 'butterDAWg', String(suggestedName || 'Untitled')),
        properties: ['createDirectory'],
    })
    return r.canceled ? null : r.filePath
}

app.whenReady().then(() => {
    store = createProjectStore({ userData: app.getPath('userData') })
    handle("fs:readFile", async (p) => {
        const data = await fs.promises.readFile(await resolveReadable(p));
        // hand over a plain Uint8Array of exactly the file's bytes
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    });
    handle("fs:list", async (p) => {
        const dir = await resolveReadable(p);
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        const out = [];
        for (const entry of entries) {
            let isDirectory = entry.isDirectory();
            if (entry.isSymbolicLink()) {
                // follow the link, but only if it stays inside the readable folders
                try { isDirectory = (await fs.promises.stat(await resolveReadable(path.join(dir, entry.name)))).isDirectory(); }
                catch { continue; }
            }
            out.push({ name: entry.name, isDirectory });
        }
        return out;
    });
    handle("fs:exists", async (p) => {
        try { await resolveReadable(p); return true; } catch { return false; }
    });

    // ---- projects: the page asks, this process shows the dialogs and does the file work
    handle("project:pickOpen", async () => {
        const dir = await chooseFolder('open')
        return dir ? store.openFolder(dir) : null
    });
    handle("project:openRecent", (dir) => store.openRecent(dir));
    handle("project:pickSave", async (suggestedName) => {
        const dir = await chooseFolder('save', suggestedName)
        if (!dir) return null
        store.grantSave(dir)
        return path.resolve(dir)
    });
    handle("project:copyAssets", (dir, items) => store.copyAssets(dir, items, resolveReadable));
    handle("project:write", (dir, text) => store.writeProject(dir, text));
    handle("project:recent", () => store.recent());
    handle("project:forgetRecent", (dir) => store.forgetRecent(dir));
    handle("project:readRecovery", () => store.readRecovery());
    handle("project:writeRecovery", (recovery) => store.writeRecovery(recovery));
    handle("project:clearRecovery", () => store.clearRecovery());
    handle("project:setDirty", (value) => { dirty = value === true });
    handle("app:confirmClose", () => {
        forceClose = true
        mainWindow.close()
    });

    createWindow()
    })

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
})
