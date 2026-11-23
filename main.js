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
function resolveReadable(requested) {
    if (typeof requested !== "string") {
        throw new Error("path must be a string");
    }
    const real = fs.realpathSync(path.resolve(APP_ROOT, requested));
    const roots = READABLE_ROOTS.filter(r => fs.existsSync(r)).map(r => fs.realpathSync(r));
    if (!roots.some(r => isInside(real, r))) {
        throw new Error("path is outside the readable folders: " + requested);
    }
    return real;
}

// Synchronous handlers, because the existing renderer code reads files
// synchronously. They only run for the main window, and always answer with
// { ok, data } or { ok: false, error } so the preload can rethrow errors.
function handleSync(channel, fn) {
    ipcMain.on(channel, (event, ...args) => {
        if (!mainWindow || event.sender !== mainWindow.webContents) {
            event.returnValue = { ok: false, error: "untrusted sender" };
            return;
        }
        try {
            event.returnValue = { ok: true, data: fn(...args) };
        } catch (err) {
            event.returnValue = { ok: false, error: err.message };
        }
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
    handleSync("app:root", () => APP_ROOT);
    handleSync("fs:readFile", (p, encoding) => {
        const real = resolveReadable(p);
        return encoding ? fs.readFileSync(real, encoding) : fs.readFileSync(real);
    });
    handleSync("fs:readdir", (p) => fs.readdirSync(resolveReadable(p)));
    handleSync("fs:exists", (p) => {
        try { resolveReadable(p); return true; } catch { return false; }
    });
    handleSync("fs:isDirectory", (p) => fs.statSync(resolveReadable(p)).isDirectory());

    createWindow()
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
})
