// State contracts use the host store implementation used by plugin execution.
const runtime = new URL('./plugins/runtime/pluginStateStore.js', import.meta.resolve('@mearl/client'));
export const { PluginStateStore } = await import(runtime.href);
