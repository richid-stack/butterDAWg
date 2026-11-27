// The open project: its name and folder, the undo history, and everything that
// moves it between memory and disk: New, Open, Save, Save As, Collect and save,
// recent projects, autosave and recovery after a crash.
//
// The files themselves are read and written by the main process (platform/projects.ts).

import { globals } from "../globals";
import { files } from "../platform/files";
import { projects, ProjectStore, Recovery } from "../platform/projects";
import { showDialog } from "../ui/Dialog";
import { assetBook, capture, restore, setLicenceManifest } from "./capture";
import { baseName, parseLicenceManifest, Roots } from "./assets";
import { History } from "./History";
import { ProjectData, ProjectError, parseProject, serializeProject } from "./schema";
import { defaultProjectData } from "./template";

const AUTOSAVE_MS = 30_000;

export class Session {
    readonly history = new History();
    name = "Untitled";
    /** the project's folder; null until it has been saved once */
    dir: string | null = null;

    private store: ProjectStore;
    private loadedListeners = new Set<() => void>();
    private refreshListeners = new Set<() => void>();
    private lastAutosaveRevision = -1;
    private autosaveTimer: ReturnType<typeof setInterval> | null = null;
    private busy = false;

    constructor(store: ProjectStore = projects) {
        this.store = store;
        // anything the history does (an edit, an undo, a save) can change what the windows show
        this.history.onChange(() => {
            this.updateTitle();
            this.store.setDirty(this.history.isDirty());
            this.refreshListeners.forEach((cb) => cb());
        });
    }

    // ---- events

    /** a whole new project was put in place: windows rebuild themselves */
    onLoaded(callback: () => void): () => void {
        this.loadedListeners.add(callback);
        return () => this.loadedListeners.delete(callback);
    }

    /** something about the project changed (an edit, an undo, a redo): windows redraw */
    onRefresh(callback: () => void): () => void {
        this.refreshListeners.add(callback);
        return () => this.refreshListeners.delete(callback);
    }

    get roots(): Roots {
        return { appRoot: files.root, projectDir: this.dir };
    }

    isDirty(): boolean {
        return this.history.isDirty();
    }

    /** the project as data (what Save would write) */
    capture(): ProjectData {
        return capture({ ...this.roots, name: this.name, appVersion: this.store.appVersion });
    }

    // ---- start

    /** Puts the starting project in place. Call once, before the windows are made; then call offerRecovery(). */
    async start(): Promise<void> {
        // what is known about the app's own library (licences) comes first, so every asset is recorded with it
        try {
            setLicenceManifest(parseLicenceManifest(await files.readText("files/licences.json")));
        } catch (err) {
            console.warn("no licence record for the app's library", err);
        }
        await this.load(defaultProjectData(this.store.appVersion), null, "Untitled");
        this.store.onCloseRequested(() => this.handleCloseRequest());
        this.autosaveTimer = setInterval(() => this.autosaveNow().catch((e) => console.error("autosave failed", e)), AUTOSAVE_MS);
    }

    // ---- New, Open

    async newProject(): Promise<boolean> {
        return this.exclusive(async () => {
            if (!(await this.confirmDiscard())) return false;
            await this.load(defaultProjectData(this.store.appVersion), null, "Untitled");
            await this.store.clearRecovery();
            return true;
        });
    }

    async openProject(): Promise<boolean> {
        return this.exclusive(async () => {
            if (!(await this.confirmDiscard())) return false;
            let opened;
            try {
                opened = await this.store.pickOpen();
            } catch (err) {
                await this.tell("Cannot open the project", errorText(err));
                return false;
            }
            if (!opened) return false;
            return this.openText(opened.text, opened.dir);
        });
    }

    async openRecent(dir: string): Promise<boolean> {
        return this.exclusive(async () => {
            if (!(await this.confirmDiscard())) return false;
            let opened;
            try {
                opened = await this.store.openRecent(dir);
            } catch (err) {
                await this.store.forgetRecent(dir);
                await this.tell("Cannot open the project", errorText(err));
                return false;
            }
            return this.openText(opened.text, opened.dir);
        });
    }

    private async openText(text: string, dir: string): Promise<boolean> {
        let data: ProjectData;
        try {
            data = parseProject(text);
        } catch (err) {
            await this.tell("Cannot open the project", errorText(err));
            return false;
        }
        await this.load(data, dir, data.name);
        await this.store.clearRecovery();
        return true;
    }

    // ---- Save

    /** Save: to the project's folder, or ask for one if it has none. */
    save(): Promise<boolean> {
        return this.exclusive(() => this.write({ as: false, collect: false }));
    }

    saveAs(): Promise<boolean> {
        return this.exclusive(() => this.write({ as: true, collect: false }));
    }

    /** Save, and copy every audio file the project uses into its assets folder, so the folder holds everything. */
    collectAndSave(): Promise<boolean> {
        return this.exclusive(() => this.write({ as: false, collect: true }));
    }

    private async write(opts: { as: boolean; collect: boolean }): Promise<boolean> {
        let dir = this.dir;
        let name = this.name;
        if (opts.as || !dir) {
            const picked = await this.store.pickSave(this.name);
            if (!picked) return false;
            dir = picked;
            name = baseName(picked);
        }
        try {
            // audio files that have to be in the project folder: the project's own when it moves, and everything when collecting
            const wanted = new Map<string, string>(); // absolute path -> name in assets/
            for (const clip of globals.playlist.getClips() as Iterable<{ path: string }>) {
                if (wanted.has(clip.path)) continue;
                const here = this.classify(clip.path);
                const moving = here === "project" && dir !== this.dir;
                const collecting = opts.collect && here !== "project";
                if (moving || collecting) wanted.set(clip.path, baseName(clip.path));
            }
            if (wanted.size > 0) {
                const copied = await this.store.copyAssets(dir, [...wanted].map(([from, n]) => ({ from, name: n })));
                const newDir = dir;
                for (const c of copied) {
                    const target = newDir.replace(/\\/g, "/").replace(/\/+$/, "") + "/" + c.path;
                    assetBook.moved(c.from, target, { sha256: c.sha256 });
                    for (const clip of globals.playlist.getClips() as Iterable<{ path: string }>) {
                        if (clip.path === c.from) clip.path = target;
                    }
                }
            }
            this.dir = dir;
            this.name = name;
            const text = serializeProject(this.capture());
            await this.store.writeProject(dir, text);
        } catch (err) {
            await this.tell("Cannot save the project", errorText(err));
            this.updateTitle();
            return false;
        }
        this.history.markSaved();
        await this.store.clearRecovery().catch(() => {});
        return true;
    }

    private classify(path: string): "project" | "app" | "external" {
        const p = path.replace(/\\/g, "/");
        if (this.dir && p.startsWith(this.dir.replace(/\\/g, "/").replace(/\/+$/, "") + "/assets/")) return "project";
        return p.startsWith(files.root.replace(/\\/g, "/").replace(/\/+$/, "") + "/") ? "app" : "external";
    }

    // ---- loading

    /** Replaces everything with a project. `dirty` is for recovered work: it differs from what is on disk. */
    private async load(data: ProjectData, dir: string | null, name: string, dirty = false): Promise<void> {
        assetBook.clear();
        const result = await restore(data, { appRoot: files.root, projectDir: dir });
        this.dir = dir;
        this.name = name;
        this.history.clear();
        if (dirty) this.history.markDirty();
        this.lastAutosaveRevision = this.history.revision;
        this.updateTitle();
        this.loadedListeners.forEach((cb) => cb());

        // tell the user about anything that did not come back, without holding the project up
        const missingPlugins = result.missingPlugins;
        result.loaded.then(async ({ missingFiles }) => {
            const lines = [...missingFiles.map((f) => "Audio file not found: " + f), ...missingPlugins.map((p) => "Plugin not found: " + p)];
            if (lines.length > 0) {
                await this.tell("Some parts of the project could not be loaded", "The project is open, and what could not be loaded is kept in it, so saving does not lose it.", lines);
            }
        });
    }

    // ---- autosave and recovery

    /** Writes the project to the recovery file, if there is unsaved work that was not written yet. */
    async autosaveNow(): Promise<boolean> {
        if (!this.history.isDirty() || this.history.revision === this.lastAutosaveRevision) return false;
        const revision = this.history.revision;
        const recovery: Recovery = {
            savedAt: new Date().toISOString(),
            name: this.name,
            dir: this.dir,
            text: serializeProject(this.capture()),
        };
        await this.store.writeRecovery(recovery);
        this.lastAutosaveRevision = revision;
        return true;
    }

    /** If the app did not close properly last time, asks whether to bring the unsaved work back. */
    async offerRecovery(): Promise<void> {
        let recovery: Recovery | null = null;
        try {
            recovery = await this.store.readRecovery();
        } catch (err) {
            console.error("could not read the recovery file", err);
        }
        if (!recovery) return;
        const when = new Date(recovery.savedAt);
        const choice = await showDialog({
            title: "Recover your work?",
            message: `butterDAWg did not close properly last time. There is unsaved work on "${recovery.name}" from ${isNaN(when.getTime()) ? "earlier" : when.toLocaleString()}.`,
            buttons: [{ label: "Recover", primary: true }, { label: "Discard", cancel: true }],
        });
        if (choice === 0) {
            try {
                const data = parseProject(recovery.text);
                await this.load(data, recovery.dir, data.name, true);
                return;
            } catch (err) {
                await this.tell("The recovery file is damaged", errorText(err));
            }
        }
        await this.store.clearRecovery();
    }

    // ---- asking and telling

    /** True if it is fine to replace the open project: nothing unsaved, or the user saved it or chose to drop the changes. */
    async confirmDiscard(): Promise<boolean> {
        if (!this.history.isDirty()) return true;
        const choice = await showDialog({
            title: "Save changes?",
            message: `"${this.name}" has changes that are not saved.`,
            buttons: [{ label: "Save", primary: true }, { label: "Don't save" }, { label: "Cancel", cancel: true }],
        });
        if (choice === 0) return this.write({ as: false, collect: false });
        return choice === 1;
    }

    private async handleCloseRequest(): Promise<void> {
        if (await this.confirmDiscard()) await this.store.confirmClose();
    }

    private tell(title: string, message: string, details: string[] = []): Promise<number> {
        return showDialog({ title, message, details, buttons: [{ label: "OK", primary: true, cancel: true }] });
    }

    private updateTitle(): void {
        document.title = (this.history.isDirty() ? "• " : "") + this.name + " – butterDAWg";
    }

    // Two file operations must not run at once (two dialogs, two saves).
    private async exclusive<T>(fn: () => Promise<T>): Promise<T | false> {
        if (this.busy) return false;
        this.busy = true;
        try {
            return await fn();
        } finally {
            this.busy = false;
        }
    }
}

function errorText(err: unknown): string {
    if (err instanceof ProjectError) return err.message;
    // errors from the main process arrive as "Error invoking remote method 'x': Error: message"
    const text = err instanceof Error ? err.message : String(err);
    return text.replace(/^Error invoking remote method '[^']*': (Error: )?/, "");
}

export const session = new Session();
