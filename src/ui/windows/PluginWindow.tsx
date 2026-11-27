import { Window } from "../misc/window";
import { files } from "../../platform/files";
import { v4 as uuidv4 } from 'uuid';
import { Plugin } from "../../core/Plugin";
import { globals } from "../../globals";
import { session } from "../../project/session";
import * as edit from "../../project/edit";

export class PluginWindow extends Window {

    private plugin: Plugin;
    private pluginId: string;
    private unsubscribe: Array<() => void> = [];
    private endGesture: () => void = () => {};

    constructor(plugin: Plugin) {
        super(false);

        this.plugin = plugin;

        // ids have to start with a letter
        this.pluginId = "p-" + uuidv4();

        this.setResizable(false);
        this.initialiseContent();

        // the plugin's window closes when the plugin is gone: removed, or the project was replaced
        this.unsubscribe.push(session.onLoaded(() => this.close()));
        this.unsubscribe.push(session.onRefresh(() => {
            const channels = [...globals.mixer.getChannels(), globals.mixer.getMaster()];
            if (!channels.some((c) => c.getPlugins().includes(this.plugin))) this.close();
        }));
    }

    onClose() {
        this.endGesture();
        this.unsubscribe.forEach((u) => u());
    }

    initialiseContent(): void {
        this.loadContent().catch((err) => console.error("could not open plugin " + this.plugin.name, err));
    }

    // the plugin's files are read asynchronously, and its audio node exists
    // only once its processor module has loaded
    private async loadContent() {
        const pluginPath = this.plugin.pluginPath;
        const [htmlContent, hostContent] = await Promise.all([
            files.readText(pluginPath + "/plugin.html"),
            files.readText(pluginPath + "/host.js"),
            this.plugin.ready,
        ]);

        this.setContent(`<div id="${this.pluginId}">${htmlContent}</div>`);

        // Turning a control in the plugin's window is one undo step. The plugin's own code sets the parameters, and its
        // handlers run after these (capture phase), so the first input event still sees the values from before.
        const root = this.get("#" + this.pluginId);
        let drag: edit.Gesture | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        this.endGesture = () => {
            clearTimeout(timer);
            drag?.end();
            drag = null;
        };
        root.addEventListener("input", () => {
            if (!drag) drag = edit.pluginParamsGesture(this.plugin);
            clearTimeout(timer);
            timer = setTimeout(this.endGesture, 400);
        }, true);
        root.addEventListener("change", () => this.endGesture(), true);

        // load plugin js
        const initializePlugin = eval(hostContent);
        initializePlugin(
            this.pluginId,
            this.plugin.getAudioNode(),
        );
    }
}
