// How the app reads files. The engine and UI only use this interface, so the
// Electron build (preload bridge) and a later browser build (File System Access
// API, downloads from the library host) can each provide their own.

export interface DirEntry {
    name: string;
    isDirectory: boolean;
}

export interface FileService {
    /** the folder that holds the app's own files, as an absolute path */
    readonly root: string;
    readBytes(path: string): Promise<ArrayBuffer>;
    readText(path: string): Promise<string>;
    list(path: string): Promise<DirEntry[]>;
    exists(path: string): Promise<boolean>;
}

/** the Electron implementation: everything goes through window.bridge */
export const files: FileService = {
    get root() {
        return window.bridge.appRoot;
    },
    async readBytes(path) {
        const bytes = await window.bridge.fs.readFile(path);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
    async readText(path) {
        return new TextDecoder("utf-8").decode(await window.bridge.fs.readFile(path));
    },
    async list(path) {
        const entries = await window.bridge.fs.list(path);
        // a stable order: folders first, then by name
        return entries.sort((a, b) =>
            a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1,
        );
    },
    exists(path) {
        return window.bridge.fs.exists(path);
    },
};
