// Shape of window.bridge, which preload.js exposes to the page.
import type { CopiedAsset, CopyRequest, OpenedProject, RecentProject, Recovery } from "./projects";

export {};

declare global {
    interface Window {
        bridge: {
            /** Absolute path of the folder that holds index.html. */
            appRoot: string;
            /** The app's version (package.json). */
            appVersion: string;
            /** True only when the test scripts start the app. */
            testMode: boolean;
            fs: {
                readFile(path: string): Promise<Uint8Array>;
                list(path: string): Promise<{ name: string; isDirectory: boolean }[]>;
                exists(path: string): Promise<boolean>;
            };
            project: {
                pickOpen(): Promise<OpenedProject | null>;
                openRecent(dir: string): Promise<OpenedProject>;
                pickSave(suggestedName: string): Promise<string | null>;
                copyAssets(dir: string, items: CopyRequest[]): Promise<CopiedAsset[]>;
                writeProject(dir: string, text: string): Promise<void>;
                recent(): Promise<RecentProject[]>;
                forgetRecent(dir: string): Promise<void>;
                readRecovery(): Promise<Recovery | null>;
                writeRecovery(recovery: Recovery): Promise<void>;
                clearRecovery(): Promise<void>;
                setDirty(dirty: boolean): Promise<void>;
            };
            app: {
                onCloseRequested(callback: () => void): void;
                confirmClose(): Promise<void>;
            };
        };
    }
}
