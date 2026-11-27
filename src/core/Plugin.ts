import { files } from "../platform/files";
import { globals } from "../globals";

// An effect plugin: an AudioWorklet processor loaded from a .bdp folder
// (plugin.js holds the processor, host.js and plugin.html the interface).
//
// A worklet module is loaded once per audio context. Making the node is
// asynchronous because the module has to be fetched first, so a plugin has a
// `ready` promise and getAudioNode() is null until it resolves.

const loadedModules = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>();

/** loads a plugin's processor into an audio context (once) */
export function loadPluginModule(ctx: BaseAudioContext, pluginPath: string): Promise<void> {
    let modules = loadedModules.get(ctx);
    if (!modules) {
        modules = new Map();
        loadedModules.set(ctx, modules);
    }
    let loading = modules.get(pluginPath);
    if (!loading) {
        loading = (async () => {
            const source = await files.readText(pluginPath + "/plugin.js");
            const url = URL.createObjectURL(new Blob([source], { type: "application/javascript; charset=utf-8" }));
            try {
                await ctx.audioWorklet.addModule(url);
            } finally {
                URL.revokeObjectURL(url);
            }
        })();
        const table = modules;
        loading.catch(() => table.delete(pluginPath)); // a failed load can be tried again
        modules.set(pluginPath, loading);
    }
    return loading;
}

export class Plugin {
    public name: string;
    public pluginPath: string;
    /** a bypassed plugin stays in its slot but the sound goes around it */
    public bypassed = false;
    readonly ctx: BaseAudioContext;
    readonly ready: Promise<void>;
    private audioNode: AudioWorkletNode | null = null;
    // values asked for before the node exists (a project is opened before the plugin's module has loaded)
    private pendingParams: Record<string, number> = {};

    constructor(pluginPath: string, ctx: BaseAudioContext = globals.audiocontext) {
        this.ctx = ctx;
        this.pluginPath = pluginPath;
        this.name = getPluginNameFromPath(pluginPath);
        this.ready = loadPluginModule(ctx, pluginPath).then(() => {
            this.audioNode = new AudioWorkletNode(ctx, this.name);
            this.applyParams(this.pendingParams);
        });
    }

    /** The value of every parameter, by name. Before the plugin has loaded, the values that were asked for. */
    getParams(): Record<string, number> {
        const out: Record<string, number> = { ...this.pendingParams };
        if (this.audioNode) this.audioNode.parameters.forEach((param, name) => (out[name] = param.value));
        return out;
    }

    /** Sets parameters by name. Names the plugin does not have are kept (so a project resaves them) but do nothing. */
    setParams(params: Record<string, number>): void {
        Object.assign(this.pendingParams, params);
        if (this.audioNode) this.applyParams(params);
    }

    private applyParams(params: Record<string, number>): void {
        const targets = new Map<string, AudioParam>();
        this.audioNode.parameters.forEach((param, name) => targets.set(name, param));
        for (const [name, value] of Object.entries(params)) {
            const param = targets.get(name);
            if (!param) continue;
            // cancel scheduled automation first, or an old setValueAtTime would win over this value
            param.cancelScheduledValues(0);
            param.value = value;
            delete this.pendingParams[name];
        }
    }

    isReady(): boolean {
        return this.audioNode !== null;
    }

    /** the worklet node, or null until `ready` has resolved */
    getAudioNode(): AudioWorkletNode | null {
        return this.audioNode;
    }

    /**
     * A copy in another audio context (for offline rendering). It takes over
     * the current value of every parameter. Internal state that is not a
     * parameter is not copied; the plugin format has no way to read it yet.
     */
    async cloneTo(ctx: BaseAudioContext): Promise<Plugin> {
        const copy = new Plugin(this.pluginPath, ctx);
        await Promise.all([this.ready, copy.ready]);
        copy.setParams(this.getParams());
        copy.bypassed = this.bypassed;
        return copy;
    }
}

export function getPluginNameFromPath(pluginPath: string): string {
    const folderName = pluginPath.split("\\").pop().split("/").pop();
    return folderName.substring(0, folderName.lastIndexOf("."));
}
