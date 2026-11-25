const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')

try {
    require("electron-reloader")(module);
} catch (_) {}

// The folder that holds index.html (inside the asar archive when packaged).
const APP_ROOT = __dirname;

// The renderer has no Node access. It reads files through the calls below,
// and only inside these folders.
const READABLE_ROOTS = ["files", "plugins"].map(d => path.join(APP_ROOT, d));

let mainWindow = null;

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
    for (const r of READABLE_ROOTS) {
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
            ...(process.env.BDP_TEST === '1' ? ['--bdp-test'] : []),
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

    mainWindow = win;
}

app.whenReady().then(() => {
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

    createWindow()
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
})
