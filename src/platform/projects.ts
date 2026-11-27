// How the app reaches project folders. Like FileService, the app only uses this
// interface: the Electron build implements it with the preload bridge (the main
// process shows the dialogs and does the reading and writing), a browser build
// will implement it with the File System Access API.

export interface RecentProject {
    dir: string;
    name: string;
    /** ISO date and time it was last opened or saved */
    openedAt: string;
}

export interface OpenedProject {
    dir: string;
    /** the text of project.json */
    text: string;
}

export interface CopyRequest {
    /** the file to copy (an absolute path the app can read) */
    from: string;
    /** the name to give it in the project's assets folder; the store may change it if that name is taken by a different file */
    name: string;
}

export interface CopiedAsset {
    from: string;
    /** where it is now, relative to the project folder ("assets/kick.wav") */
    path: string;
    sha256: string;
}

export interface Recovery {
    savedAt: string;
    name: string;
    /** the folder of the project the work belongs to, if it had been saved */
    dir: string | null;
    /** the text of a project.json */
    text: string;
}

export interface ProjectStore {
    /** Asks the user for a project folder. Null if they cancel. Throws if the folder is not a project. */
    pickOpen(): Promise<OpenedProject | null>;
    /** Opens a project from the recent list. Throws if it is gone. */
    openRecent(dir: string): Promise<OpenedProject>;
    /** Asks the user where to save a project (a folder name). Null if they cancel. */
    pickSave(suggestedName: string): Promise<string | null>;
    /** Copies files into `dir`/assets and returns where they ended up, with their SHA-256. */
    copyAssets(dir: string, items: CopyRequest[]): Promise<CopiedAsset[]>;
    /** Writes `dir`/project.json (keeping the previous one as project.json.bak). */
    writeProject(dir: string, text: string): Promise<void>;
    recent(): Promise<RecentProject[]>;
    forgetRecent(dir: string): Promise<void>;
    readRecovery(): Promise<Recovery | null>;
    writeRecovery(recovery: Recovery): Promise<void>;
    clearRecovery(): Promise<void>;
    /** tells the main process whether there is unsaved work, so closing the window can ask first */
    setDirty(dirty: boolean): void;
    /** the window is being closed while there is unsaved work; `callback` should ask the user */
    onCloseRequested(callback: () => void): void;
    /** the user has decided: close the window now */
    confirmClose(): Promise<void>;
    readonly appVersion: string;
}

/** the Electron implementation: everything goes through window.bridge */
export const projects: ProjectStore = {
    get appVersion() {
        return window.bridge.appVersion;
    },
    pickOpen: () => window.bridge.project.pickOpen(),
    openRecent: (dir) => window.bridge.project.openRecent(dir),
    pickSave: (name) => window.bridge.project.pickSave(name),
    copyAssets: (dir, items) => window.bridge.project.copyAssets(dir, items),
    writeProject: (dir, text) => window.bridge.project.writeProject(dir, text),
    recent: () => window.bridge.project.recent(),
    forgetRecent: (dir) => window.bridge.project.forgetRecent(dir),
    readRecovery: () => window.bridge.project.readRecovery(),
    writeRecovery: (r) => window.bridge.project.writeRecovery(r),
    clearRecovery: () => window.bridge.project.clearRecovery(),
    setDirty: (dirty) => void window.bridge.project.setDirty(dirty),
    onCloseRequested: (cb) => window.bridge.app.onCloseRequested(cb),
    confirmClose: () => window.bridge.app.confirmClose(),
};
