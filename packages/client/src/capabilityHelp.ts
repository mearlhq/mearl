import { resolveServer } from './unifiedConfig.js';
import type { BrowserCapabilityCatalog } from '@mearl/browser-core';
import { listLiveBrowsers } from './browserRegistry.js';
import { UnifiedClient } from './unified.js';

/** Help reads an existing target with a short budget; it never installs an environment. */
export async function readHelpCapabilities(args: string[]): Promise<BrowserCapabilityCatalog | undefined> {
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index < 0 ? args.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) : args[index + 1];
  };
  const browser = value('--browser');
  const session = value('--session');
  const connector = value('--connector');
  const { serverUrl } = resolveServer(value('--server'));
  const local = args.includes('--local') || args.includes('--cdp');
  if (local && connector || session === 'new') return;
  if (!browser && !connector && (local || !serverUrl) && !session && !listLiveBrowsers().length) return;
  const client = new UnifiedClient({ connectTimeoutSec: 1, requestTimeoutSec: 1, ...(serverUrl ? { serverUrl } : {}) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      client.invoke('get_capabilities', {}, {
        ...(browser ? { browser } : {}), ...(session ? { session } : {}),
        ...(connector ? { connector } : {}), ...(local ? { local: true } : {}),
        ...(args.includes('--cdp') ? { transport: 'cdp' as const } : {}),
      }),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1500); }),
    ]);
    if (result && Array.isArray(result.actions) && Array.isArray(result.apps?.entries)) return result;
  } catch {
    // Static help remains usable when the target is offline or does not expose a catalog.
  } finally {
    clearTimeout(timer);
    client.disconnect();
  }
}

export function formatCapabilityHelp(catalog: BrowserCapabilityCatalog | undefined, detailed = false): string {
  if (!catalog) return '当前浏览器能力暂不可读，以下为静态帮助。连接后再次运行 --help 可查看已安装的端模拟。';
  const lines = [
    '当前浏览器已安装的端模拟：',
  ];
  if (!catalog.apps.entries.length) lines.push(catalog.apps.status === 'available' ? '  暂无已安装的端模拟。设备模拟可独立使用。' : '  暂时无法读取端模拟列表，安装状态待确认。');
  for (const app of catalog.apps.entries) {
    lines.push(`  ${app.id} — ${app.label}${app.available ? '' : '（暂不可用）'}`);
    if (!detailed) continue;
    lines.push(`    能力：${app.features.join(', ')}`);
    if (app.usage?.skills?.length) lines.push(`    Skill：${app.usage.skills.join(', ')}`);
    if (app.usage?.description) lines.push(`    ${app.usage.description}`);
    if (app.usage?.limitations?.length) lines.push(...app.usage.limitations.map(line => `    限制：${line}`));
    if (app.usage?.documentation?.length) lines.push(...app.usage.documentation.map(doc => `    说明：${doc.title} ${doc.url}`));
  }
  if (detailed) lines.push(...catalog.limitations.map(line => `  ${line}`));
  else lines.push('  App 用法与限制：mearl set_app_profile --help');
  return lines.join('\n');
}
