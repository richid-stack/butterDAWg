// Shape of window.bridge, which preload.js exposes to the page.
export {};

declare global {
    interface Window {
        bridge: {
            /** Absolute path of the folder that holds index.html. */
            appRoot: string;
            /** True only when the test scripts start the app. */
            testMode: boolean;
            fs: {
                readFile(path: string): Promise<Uint8Array>;
                list(path: string): Promise<{ name: string; isDirectory: boolean }[]>;
                exists(path: string): Promise<boolean>;
            };
        };
    }
}
