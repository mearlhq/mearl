import type { ToolboxPluginTool } from '@mearl/browser-core';
import { localizeToolboxMetadata } from '../../shared/toolboxLocale';
import { getCurrentLanguage } from '../panel/utils/i18n';

const STORAGE_KEY = 'mearl.popup.toolbox.navigation';
export type ToolboxNavigationTool = Pick<ToolboxPluginTool, 'id' | 'title' | 'icon'>;

// 顶部导航同步恢复展示元数据，工具执行与可用性仍由宿主的实时列表决定。
export function readToolboxNavigationCache(): ToolboxNavigationTool[] {
  try {
    const cached = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    if (cached?.language !== getCurrentLanguage() || !Array.isArray(cached.tools)) return [];
    return cached.tools.filter(
      (tool: unknown): tool is ToolboxNavigationTool =>
        tool !== null &&
        typeof tool === 'object' &&
        'id' in tool &&
        typeof tool.id === 'string' &&
        tool.id.startsWith('plugin:') &&
        'title' in tool &&
        typeof tool.title === 'string' &&
        (!('icon' in tool) || typeof tool.icon === 'string'),
    );
  } catch {
    return [];
  }
}

export function cacheToolboxNavigation(tools: ToolboxPluginTool[]): void {
  const navigation = tools.map(tool => ({
    id: tool.id,
    title: localizeToolboxMetadata(tool).title,
    icon: tool.icon,
  }));
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ language: getCurrentLanguage(), tools: navigation }),
    );
  } catch {
    // 存储不可用时仍使用本次宿主返回的导航。
  }
}
