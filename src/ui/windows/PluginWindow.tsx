import { Window } from "../misc/window";
import { files } from "../../platform/files";
import { v4 as uuidv4 } from 'uuid';
import { Plugin } from "../../core/Plugin";

export class PluginWindow extends Window {

    private plugin: Plugin;
    private pluginId: string;

    constructor(plugin: Plugin) {
        super(false);

        this.plugin = plugin;

        // ids have to start with a letter
        this.pluginId = "p-" + uuidv4();

        this.setResizable(false);
        this.initialiseContent();
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

        // load plugin js
        const initializePlugin = eval(hostContent);
        initializePlugin(
            this.pluginId,
            this.plugin.getAudioNode(),
        );
    }
}
