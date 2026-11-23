// Shape of window.bridge, which preload.js exposes to the page.
export {};

declare global {
    interface Window {
        bridge: {
            /** Absolute path of the folder that holds index.html. */
            appRoot: string;
            fs: {
                readFile(path: string, encoding?: string): string | Uint8Array;
                readdir(path: string): string[];
                exists(path: string): boolean;
                isDirectory(path: string): boolean;
            };
        };
    }
}
