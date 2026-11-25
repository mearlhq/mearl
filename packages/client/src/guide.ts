import { readFileSync } from 'node:fs';
import type { PresetSkillCatalogEntry } from '@mearl/daemon-core/installation';
import { CLIENT_VERSION } from './runtimePaths.js';

/** One catalog drives CLI navigation and the build-time resource copy. */
export const GUIDE_TOPICS = [
  { id: 'core', file: 'core.md', title: '核心工作流与按需导航' },
  { id: 'automation', file: 'api-page-automation.md', title: '控件、文件、弹窗与结果判读' },
  { id: 'run', file: 'scripting.md', title: 'SDK、代码组合、超时与不确定结果' },
  { id: 'debugging', file: 'api-page-debugging.md', title: '布局、遮挡、iframe 与视觉验证' },
  { id: 'environment', file: 'api-page-environment.md', title: '设备、App、时区与 Cookie' },
  { id: 'diagnostics', file: 'api-request-debugging.md', title: '接口、日志、埋点、权限与 Mock' },
  { id: 'browsers', file: 'api-browser-setup.md', title: '目标、会话、远端与 Provider' },
  { id: 'cooperation', file: 'browser-tool-cooperation.md', title: '与其他浏览器工具协作' },
  { id: 'skills', file: 'related-skills.md', title: '专用 Skill 使用与安装' },
  { id: 'troubleshooting', file: 'troubleshooting.md', title: '安装、连接与环境排查' },
] as const;

export function renderGuideLinks(source: string, commandName = 'mearl'): string {
  return source.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (original, label: string, href: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return original;
    const [file, section] = href.replace(/^\.\//, '').split('#');
    const topic = GUIDE_TOPICS.find(topic => topic.file === file);
    if (!topic) throw new Error(`指南包含未打包的本地链接：${href}`);
    return `${label}（\`${commandName} guide ${topic.id}\`${section ? `，小节 \`${section}\`` : ''}）`;
  });
}

function renderPresetSkills(
  setupCommand: string,
  skillCatalog?: Record<string, PresetSkillCatalogEntry>,
  agentDocs?: string,
): string {
  if (!skillCatalog && !agentDocs) return '';
  const lines = ['## 当前 Preset 的专用 Skill', ''];
  if (skillCatalog) {
    const entries = Object.entries(skillCatalog);
    lines.push('| 适用场景 | Skill | 安装来源 |', '| --- | --- | --- |');
    for (const [name, { description, source, managed }] of entries) {
      const cell = description.replaceAll('\\', '\\\\').replaceAll('|', '\\|');
      const install = managed ? 'Preset 管理' : source ? `\`${source}\`` : '见 Skill 说明';
      lines.push(`| ${cell} | \`${name}\` | ${install} |`);
    }
    lines.push('');
    if (entries.some(([, entry]) => entry.source)) {
      lines.push(
        '按需安装时，将同一行的安装来源和 Skill 名称填入命令。',
        '',
        '```bash',
        `${setupCommand} plugin install '<source>' --skill <skill-name> --yes`,
        '```',
        '',
      );
    }
    if (entries.some(([, entry]) => entry.managed)) {
      lines.push(
        `Preset 管理的 Skill 缺失时，先用 \`${setupCommand} preset status\` 检查，再用 \`${setupCommand} preset apply\` 重试同步。`,
        '',
      );
    }
  }
  if (agentDocs) lines.push(`查看未安装 Skill 的用法和安装方式：${agentDocs}`, '');
  return lines.join('\n') + '\n';
}

/** Only packaged files are read; unknown IDs never become filesystem paths. */
export async function readGuide(
  id: string,
  commandName = 'mearl',
  version = CLIENT_VERSION,
): Promise<string> {
  const topic = GUIDE_TOPICS.find(topic => topic.id === id);
  if (!topic) throw new Error(`未知指南主题：${id}。用 ${commandName} guide --list 查看主题。`);
  let source: string;
  try {
    source = readFileSync(new URL(`./guides/${topic.file}`, import.meta.url), 'utf8');
  } catch (error) {
    throw new Error(
      `当前安装缺少指南资源：${topic.id}。请通过当前发行版的安装入口修复安装包；参数可用 ${commandName} <action> --help 查询。`,
      { cause: error },
    );
  }
  let management: string | undefined;
  let presetSkills = '';
  const hasSetup = source.includes('{{setup}}');
  if (id === 'skills' || hasSetup) {
    const { readInstallationManagement, setupManagementCommand } =
      await import('@mearl/daemon-core/installation');
    const installed = await readInstallationManagement();
    const command = setupManagementCommand(
      installed.setup ?? { package: '@mearl/setup', version: 'beta' },
    ).replace(/@latest$/, '');
    if (hasSetup) {
      source = source.replaceAll('{{setup}}', command);
      if (id !== 'skills') {
        management = installed.source
          ? `管理入口：${command}；沿用本机已选 preset。`
          : `首次安装入口：${command}；本机尚未选择 preset。`;
      }
    }
    if (id === 'skills')
      presetSkills = renderPresetSkills(command, installed.skillCatalog, installed.agentDocs);
  }
  return [
    `[mearl:guide] CLI ${version} · ${topic.id}`,
    '本指南随 CLI 分发；扩展、远端宿主与已安装能力仍须按目标实际帮助核验。',
    ...(management ? [management] : []),
    '',
    renderGuideLinks(source.trim(), commandName).replace(
      /^\{\{presetSkills\}\}\r?\n\r?\n/m,
      () => presetSkills,
    ),
    '',
    `其他主题：${commandName} guide --list；具体参数：${commandName} <action> --help。`,
    `[mearl:guide] end ${topic.id}`,
  ].join('\n');
}

export async function runGuideCli(
  args: string[],
  commandName = 'mearl',
  version = CLIENT_VERSION,
): Promise<number> {
  const list = () => GUIDE_TOPICS.map(topic => `  ${topic.id.padEnd(18)}${topic.title}`).join('\n');
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(
      `${commandName} guide — CLI ${version}\n\n用法：${commandName} guide [topic]\n      ${commandName} guide --list\n\n默认只读 core；按需读取单个专题。只读本地资源，不连接浏览器或检查更新。\n\n${list()}`,
    );
    return 0;
  }
  if (args.length === 1 && args[0] === '--list') {
    console.log(`${commandName} guide — CLI ${version}\n${list()}`);
    return 0;
  }
  if (
    args.length > 1 ||
    args[0]?.startsWith('-') ||
    !GUIDE_TOPICS.some(topic => topic.id === (args[0] ?? 'core'))
  ) {
    console.error(
      `未知指南主题或选项：${args.join(' ')}。用 ${commandName} guide --list 查看主题。`,
    );
    return 2;
  }
  try {
    console.log(await readGuide(args[0] ?? 'core', commandName, version));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
