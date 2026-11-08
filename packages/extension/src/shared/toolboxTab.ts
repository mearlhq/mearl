import { openExtensionTab } from './extensionTab';

function toolboxPluginName(toolId: string): string {
  const plugin = toolId.startsWith('plugin:') ? toolId.slice('plugin:'.length) : '';
  if (!/^[a-z][a-z0-9-]*$/.test(plugin)) throw new Error('Invalid plugin tool id');
  return plugin;
}

export function toolboxToolUrl(toolId: string, query: Record<string, string> = {}): string {
  const plugin = toolboxPluginName(toolId);
  const entries = Object.entries(query);
  if (entries.length > 20) throw new Error('Too many toolbox query parameters');
  const url = new URL(chrome.runtime.getURL('plugin/index.html'));
  for (const [name, value] of entries) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('Invalid toolbox query parameter');
    if (typeof value !== 'string' || value.length > 512) {
      throw new Error('Invalid toolbox query value');
    }
    url.searchParams.set(name, value);
  }
  url.hash = plugin;
  return url.toString();
}

/** 在新标签页中打开一个已注册的插件工具。 */
export async function openToolboxToolTab(
  toolId: string,
  query: Record<string, string> = {},
): Promise<void> {
  await openExtensionTab(toolboxToolUrl(toolId, query));
}
