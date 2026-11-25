import { files } from "../platform/files";
export { getPluginNameFromPath } from "../core/Plugin";

/** the folders in plugins/ that hold a plugin, as paths relative to the app folder */
export async function discoverPlugins(): Promise<string[]> {
    const entries = await files.list("plugins");
    return entries.filter((e) => e.isDirectory && !e.name.startsWith(".")).map((e) => "plugins/" + e.name);
}
