import {
  validateAppProfileContribution,
  type AppProfileContribution,
  type ToolboxAgentConfig,
} from '@mearl/browser-core';
import { randomUUID } from 'node:crypto';
import { parseToolboxIcon } from '@mearl/browser-core';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { COMMAND_MAP } from '../commands.js';
import {
  buildPluginPageBundle,
  PLUGIN_PAGE_CHUNK_BYTES,
  PLUGIN_PAGE_RUNTIME_HASH,
  type BuiltPluginPageBundle,
} from './pluginPageBundle.js';
import { pluginFileVersion } from './pluginSource.js';

const RESERVED_NAMES = new Set([
  'guide',
  'check',
  'run',
  'help',
  'connector_list',
  'capture_checkpoint',
  'plugin',
  'plugins',
  'plugin_state',
  'plugin_model',
  'plugin_page',
  'plugin_invoke_child',
  'plugin_task_checkpoint',
]);

export class PluginError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

export interface PluginToolboxSandboxPage {
  type: 'sandbox';
  runtime?: 'preact';
  entry: string;
  commands: string[];
}

export interface PluginToolboxLocale {
  title?: string;
  description?: string;
}

export interface PluginToolboxAgentConfig extends Pick<ToolboxAgentConfig, 'layout' | 'pageElementActions'> {
  skill: string;
}

export interface PluginToolboxContribution {
  version: 1;
  displayMode?: 'popup' | 'tab' | 'both';
  title: string;
  description?: string;
  icon?: string;
  locales?: Record<string, PluginToolboxLocale>;
  agent?: PluginToolboxAgentConfig;
  page: PluginToolboxSandboxPage;
  order?: number;
}

export interface PluginPageBundleRegistration {
  hash: string;
  size: number;
  chunks: number;
}

export interface PluginRegistration {
  entry: string;
  hasPublicCommands?: boolean;
  description?: string;
  managedBy?: string;
  toolbox?: PluginToolboxContribution;
  appProfiles?: AppProfileContribution;
  pageBundle?: PluginPageBundleRegistration;
  source?: {
    entry: string;
    profiles?: Record<string, string>;
    page?: Record<string, string>;
    pageRuntime?: string;
  };
}

export function pluginRegistrationNeedsRefresh(
  registration: PluginRegistration,
  includePage = false,
): boolean {
  if (!registration.source) return true;
  if (pluginFileVersion(registration.entry) !== registration.source.entry) return true;
  if (
    Object.entries(registration.source.profiles ?? {}).some(([path, version]) => {
      try {
        return pluginFileVersion(path) !== version;
      } catch {
        return true;
      }
    })
  )
    return true;
  if (!includePage || !registration.toolbox) return false;
  if (registration.source.pageRuntime !== PLUGIN_PAGE_RUNTIME_HASH) return true;
  if (!registration.source.page) return true;
  return Object.entries(registration.source.page).some(
    ([path, version]) => pluginFileVersion(path) !== version,
  );
}

export interface PluginRegistrationOptions {
  hasPublicCommands?: boolean;
  managedBy?: string;
  toolbox?: PluginToolboxContribution;
  appProfiles?: AppProfileContribution;
  profileSources?: Record<string, string>;
}

export function pluginDirectory(): string {
  return resolve(process.env.MEARL_PLUGIN_DIR || join(homedir(), '.mearl', 'plugins'));
}

function pluginPageDirectory(): string {
  return join(pluginDirectory(), '.pages');
}

function pluginPageBundlePath(name: string, hash: string): string {
  return join(pluginPageDirectory(), `${name}-${hash}.html`);
}

function removePluginPageBundles(name: string, exceptHash?: string): void {
  let files: string[];
  try {
    files = readdirSync(pluginPageDirectory());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const keep = exceptHash ? `${name}-${exceptHash}.html` : undefined;
  for (const file of files) {
    if (file === keep || !file.startsWith(`${name}-`) || !file.endsWith('.html')) continue;
    rmSync(join(pluginPageDirectory(), file), { force: true });
  }
}

function normalizePageBundle(value: unknown): PluginPageBundleRegistration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid page bundle');
  }
  const candidate = value as Partial<PluginPageBundleRegistration>;
  if (
    typeof candidate.hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate.hash) ||
    !Number.isInteger(candidate.size) ||
    (candidate.size ?? 0) <= 0 ||
    !Number.isInteger(candidate.chunks) ||
    candidate.chunks !== Math.ceil((candidate.size ?? 0) / PLUGIN_PAGE_CHUNK_BYTES)
  ) {
    throw new Error('invalid page bundle');
  }
  return {
    hash: candidate.hash,
    size: candidate.size!,
    chunks: candidate.chunks!,
  };
}

function persistPluginPageBundle(name: string, bundle: BuiltPluginPageBundle): void {
  const directory = pluginPageDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = pluginPageBundlePath(name, bundle.hash);
  try {
    if (statSync(target).isFile()) return;
  } catch {
    // 页面内容哈希变化时创建新的不可变产物。
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bundle.content, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function assertPluginName(name: string): void {
  if (!/^[a-z][a-z0-9_-]*$/.test(name) || RESERVED_NAMES.has(name) || COMMAND_MAP.has(name)) {
    throw new PluginError('PLUGIN_INVALID_NAME', `不可用的插件名称: ${name}`);
  }
}

export function normalizePluginToolboxContribution(
  value: unknown,
): PluginToolboxContribution | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('toolbox 必须是对象');
  }
  const candidate = value as Partial<PluginToolboxContribution>;
  if (
    candidate.displayMode !== undefined &&
    !['popup', 'tab', 'both'].includes(candidate.displayMode)
  ) {
    throw new Error('toolbox.displayMode 必须是 popup、tab 或 both');
  }
  const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
  const description =
    typeof candidate.description === 'string' ? candidate.description.trim() : undefined;
  const icon = typeof candidate.icon === 'string' ? candidate.icon.trim() : undefined;
  if (candidate.version !== 1) throw new Error('toolbox.version 必须为 1');
  if (!title || title.length > 80) throw new Error('toolbox.title 必须是 1-80 个字符');
  if (description && description.length > 240) {
    throw new Error('toolbox.description 不能超过 240 个字符');
  }
  if (icon && !parseToolboxIcon(icon)) {
    throw new Error(
      'toolbox.icon 必须是图标名称、SVG、图片 Data URL 或 HTTP(S) 图片地址，最多 32768 个字符',
    );
  }
  let locales: Record<string, PluginToolboxLocale> | undefined;
  if (candidate.locales !== undefined) {
    if (
      !candidate.locales ||
      typeof candidate.locales !== 'object' ||
      Array.isArray(candidate.locales)
    ) {
      throw new Error('toolbox.locales 必须是对象');
    }
    const entries = Object.entries(candidate.locales);
    if (entries.length === 0 || entries.length > 20) {
      throw new Error('toolbox.locales 必须包含 1-20 个语言');
    }
    locales = Object.fromEntries(
      entries.map(([locale, localized]) => {
        if (!/^[a-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})*$/.test(locale)) {
          throw new Error(`toolbox.locales 包含无效语言: ${locale}`);
        }
        if (!localized || typeof localized !== 'object' || Array.isArray(localized)) {
          throw new Error(`toolbox.locales.${locale} 必须是对象`);
        }
        const localizedTitle =
          typeof localized.title === 'string' ? localized.title.trim() : undefined;
        const localizedDescription =
          typeof localized.description === 'string' ? localized.description.trim() : undefined;
        if (localizedTitle !== undefined && (!localizedTitle || localizedTitle.length > 80)) {
          throw new Error(`toolbox.locales.${locale}.title 必须是 1-80 个字符`);
        }
        if (localizedDescription !== undefined && localizedDescription.length > 240) {
          throw new Error(`toolbox.locales.${locale}.description 不能超过 240 个字符`);
        }
        if (!localizedTitle && !localizedDescription) {
          throw new Error(`toolbox.locales.${locale} 至少声明 title 或 description`);
        }
        return [
          locale,
          {
            ...(localizedTitle ? { title: localizedTitle } : {}),
            ...(localizedDescription ? { description: localizedDescription } : {}),
          },
        ];
      }),
    );
  }
  if (!candidate.page || typeof candidate.page !== 'object' || Array.isArray(candidate.page)) {
    throw new Error('toolbox.page 必须是对象');
  }
  const pageCandidate = candidate.page as Partial<PluginToolboxSandboxPage>;
  if (pageCandidate.type !== 'sandbox') {
    throw new Error('toolbox.page.type 必须为 sandbox');
  }
  if (pageCandidate.runtime !== undefined && pageCandidate.runtime !== 'preact') {
    throw new Error('toolbox.page.runtime 仅支持 preact');
  }
  const pageEntry = typeof pageCandidate.entry === 'string' ? pageCandidate.entry.trim() : '';
  if (
    !pageEntry ||
    pageEntry.length > 240 ||
    isAbsolute(pageEntry) ||
    pageEntry.includes('\\') ||
    pageEntry.split('/').some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('toolbox.page.entry 必须是插件目录内的相对 HTML 路径');
  }
  if (!Array.isArray(pageCandidate.commands)) {
    throw new Error('toolbox.page.commands 必须是命令名称数组');
  }
  const commands = pageCandidate.commands.map(command =>
    typeof command === 'string' ? command.trim() : '',
  );
  if (
    commands.length === 0 ||
    commands.length > 64 ||
    new Set(commands).size !== commands.length ||
    commands.some(command => !/^[a-z][a-z0-9-]*$/.test(command))
  ) {
    throw new Error('toolbox.page.commands 必须包含 1-64 个不重复的插件命令名称');
  }
  const page: PluginToolboxSandboxPage = {
    type: 'sandbox',
    ...(pageCandidate.runtime ? { runtime: pageCandidate.runtime } : {}),
    entry: pageEntry,
    commands,
  };
  if ('lifecycle' in pageCandidate)
    throw new Error(
      'toolbox.page.lifecycle is unsupported; declare pageRuntime and activation rules',
    );
  let agent: PluginToolboxAgentConfig | undefined;
  if (candidate.agent !== undefined) {
    if (!candidate.agent || typeof candidate.agent !== 'object' || Array.isArray(candidate.agent)) {
      throw new Error('toolbox.agent 必须是对象');
    }
    const agentCandidate = candidate.agent as Partial<PluginToolboxAgentConfig>;
    const skill = typeof agentCandidate.skill === 'string' ? agentCandidate.skill.trim() : '';
    if (!skill || skill.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(skill)) {
      throw new Error('toolbox.agent.skill 必须是有效的 Skill 名称');
    }
    const { layout, pageElementActions } = agentCandidate;
    if (layout !== undefined && layout !== 'drawer' && layout !== 'workspace') {
      throw new Error('toolbox.agent.layout 必须是 drawer 或 workspace');
    }
    if (pageElementActions !== undefined && typeof pageElementActions !== 'boolean') {
      throw new Error('toolbox.agent.pageElementActions 必须是布尔值');
    }
    agent = {
      skill,
      ...(layout ? { layout } : {}),
      ...(pageElementActions !== undefined ? { pageElementActions } : {}),
    };
  }
  if (
    candidate.order !== undefined &&
    (!Number.isInteger(candidate.order) || candidate.order < 0 || candidate.order > 10_000)
  ) {
    throw new Error('toolbox.order 必须是 0-10000 的整数');
  }
  return {
    version: 1,
    title,
    ...(candidate.displayMode !== undefined ? { displayMode: candidate.displayMode } : {}),
    ...(description ? { description } : {}),
    ...(icon ? { icon } : {}),
    ...(locales ? { locales } : {}),
    ...(agent ? { agent } : {}),
    page,
    ...(candidate.order !== undefined ? { order: candidate.order } : {}),
  };
}

export function findPluginDirectoryEntry(directory: string): string | undefined {
  for (const filename of ['main.mjs', 'main.py']) {
    const entry = join(directory, 'scripts', filename);
    try {
      if (statSync(entry).isFile()) return entry;
    } catch {
      // 没有约定入口的目录是普通 skill，调用方据此跳过自动注册。
    }
  }
  return undefined;
}

export function resolvePluginEntry(target: string): string {
  const absolute = resolve(target);
  try {
    const entry = statSync(absolute).isDirectory() ? findPluginDirectoryEntry(absolute) : absolute;
    if (!entry) throw new Error('not a file');
    if (!statSync(entry).isFile()) throw new Error('not a file');
    return entry;
  } catch {
    throw new PluginError(
      'PLUGIN_ENTRY_MISSING',
      `入口不存在: ${absolute}（目录默认使用 scripts/main.mjs 或 scripts/main.py）`,
    );
  }
}

export function registerPlugin(
  name: string,
  target: string,
  description?: string,
  options: PluginRegistrationOptions = {},
): string {
  assertPluginName(name);
  const entry = resolvePluginEntry(target);
  const entryVersion = pluginFileVersion(entry);
  const directory = pluginDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${name}.json`);
  // 每个插件独立保存，多个名称并发注册不会覆盖彼此；同名注册原子替换绑定。
  const temporary = `${file}.${randomUUID()}.tmp`;
  const summary = description?.trim();
  const managedBy = options.managedBy?.trim();
  let toolbox: PluginToolboxContribution | undefined;
  try {
    toolbox = normalizePluginToolboxContribution(options.toolbox);
  } catch (error) {
    throw new PluginError(
      'PLUGIN_INVALID_TOOLBOX',
      error instanceof Error ? error.message : String(error),
    );
  }
  let builtPage: BuiltPluginPageBundle | undefined;
  if (toolbox) {
    try {
      builtPage = buildPluginPageBundle(entry, toolbox.page.entry);
    } catch (error) {
      throw new PluginError(
        'PLUGIN_INVALID_TOOLBOX_PAGE',
        error instanceof Error ? error.message : String(error),
      );
    }
    persistPluginPageBundle(name, builtPage);
  }
  const record: PluginRegistration = {
    entry,
    ...(options.hasPublicCommands !== undefined
      ? { hasPublicCommands: options.hasPublicCommands }
      : {}),
    source: {
      entry: entryVersion,
      ...(options.profileSources ? { profiles: options.profileSources } : {}),
      ...(builtPage ? { page: builtPage.sources, pageRuntime: PLUGIN_PAGE_RUNTIME_HASH } : {}),
    },
    ...(summary ? { description: summary } : {}),
    ...(managedBy ? { managedBy } : {}),
    ...(toolbox ? { toolbox } : {}),
    ...(options.appProfiles
      ? { appProfiles: validateAppProfileContribution(options.appProfiles) }
      : {}),
    ...(builtPage
      ? { pageBundle: { hash: builtPage.hash, size: builtPage.size, chunks: builtPage.chunks } }
      : {}),
  };
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  removePluginPageBundles(name, builtPage?.hash);
  return entry;
}

export function unregisterPlugin(name: string): boolean {
  assertPluginName(name);
  const file = join(pluginDirectory(), `${name}.json`);
  try {
    rmSync(file);
    rmSync(join(pluginDirectory(), '.host', 'installations', `${name}.json`), { force: true });
    removePluginPageBundles(name);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new PluginError('PLUGIN_UNINSTALL_FAILED', `无法移除插件注册: ${file}`);
  }
}

export function findPluginRegistration(name: string): PluginRegistration | undefined {
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) return undefined;
  const file = join(pluginDirectory(), `${name}.json`);
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new PluginError('PLUGIN_REGISTRY_INVALID', `无法读取插件记录: ${file}`);
  }
  try {
    const record = JSON.parse(content);
    if (typeof record?.entry !== 'string' || !isAbsolute(record.entry))
      throw new Error('invalid entry');
    if (record.hasPublicCommands !== undefined && typeof record.hasPublicCommands !== 'boolean')
      throw new Error('invalid public commands');
    const description =
      typeof record.description === 'string' && record.description.trim()
        ? record.description.trim()
        : undefined;
    const managedBy =
      typeof record.managedBy === 'string' && record.managedBy.trim()
        ? record.managedBy.trim()
        : undefined;
    const toolbox = normalizePluginToolboxContribution(record.toolbox);
    const pageBundle = toolbox ? normalizePageBundle(record.pageBundle) : undefined;
    const appProfiles = validateAppProfileContribution(record.appProfiles);
    const source = record.source;
    if (
      source !== undefined &&
      (!source ||
        typeof source !== 'object' ||
        Array.isArray(source) ||
        typeof source.entry !== 'string' ||
        (source.profiles !== undefined &&
          (!source.profiles ||
            typeof source.profiles !== 'object' ||
            Array.isArray(source.profiles) ||
            Object.entries(source.profiles).some(
              ([path, version]) => !isAbsolute(path) || typeof version !== 'string',
            ))) ||
        (source.pageRuntime !== undefined &&
          (typeof source.pageRuntime !== 'string' || !/^[a-f0-9]{64}$/.test(source.pageRuntime))) ||
        (source.page !== undefined &&
          (!source.page ||
            typeof source.page !== 'object' ||
            Array.isArray(source.page) ||
            Object.entries(source.page).some(
              ([path, version]) => !isAbsolute(path) || typeof version !== 'string',
            ))))
    ) {
      throw new Error('invalid source');
    }
    return {
      entry: record.entry,
      ...(record.hasPublicCommands !== undefined
        ? { hasPublicCommands: record.hasPublicCommands }
        : {}),
      ...(description ? { description } : {}),
      ...(managedBy ? { managedBy } : {}),
      ...(toolbox ? { toolbox } : {}),
      ...(pageBundle ? { pageBundle } : {}),
      ...(appProfiles ? { appProfiles } : {}),
      ...(source ? { source } : {}),
    };
  } catch (cause) {
    const reason =
      cause instanceof SyntaxError
        ? 'JSON 格式错误'
        : cause instanceof Error
          ? cause.message
          : '未知校验错误';
    throw new PluginError('PLUGIN_REGISTRY_INVALID', `无效的插件记录: ${file} (${reason})`, {
      cause,
    });
  }
}

export function readPluginPageBundleChunk(
  name: string,
  hash: string,
  index: number,
): { data: string; hash: string; index: number; total: number } {
  assertPluginName(name);
  const registration = findPluginRegistration(name);
  const bundle = registration?.pageBundle;
  if (!bundle || bundle.hash !== hash) {
    throw new PluginError('PLUGIN_PAGE_CHANGED', `插件页面已更新: ${name}`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= bundle.chunks) {
    throw new PluginError('PLUGIN_PAGE_CHUNK_INVALID', `插件页面分块无效: ${index}`);
  }
  const path = pluginPageBundlePath(name, hash);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new PluginError('PLUGIN_PAGE_INVALID', `插件页面产物不存在: ${name}`);
  }
  if (size !== bundle.size) {
    throw new PluginError('PLUGIN_PAGE_INVALID', `插件页面产物损坏: ${name}`);
  }
  const start = index * PLUGIN_PAGE_CHUNK_BYTES;
  const content = Buffer.allocUnsafe(Math.min(PLUGIN_PAGE_CHUNK_BYTES, bundle.size - start));
  let descriptor: number;
  try {
    descriptor = openSync(path, 'r');
  } catch {
    throw new PluginError('PLUGIN_PAGE_INVALID', `插件页面产物无法读取: ${name}`);
  }
  let bytesRead: number;
  try {
    bytesRead = readSync(descriptor, content, 0, content.byteLength, start);
  } finally {
    closeSync(descriptor);
  }
  if (bytesRead !== content.byteLength) {
    throw new PluginError('PLUGIN_PAGE_INVALID', `插件页面产物损坏: ${name}`);
  }
  return {
    data: content.toString('base64'),
    hash,
    index,
    total: bundle.chunks,
  };
}

export function findPluginEntry(name: string): string | undefined {
  return findPluginRegistration(name)?.entry;
}

export function listPluginNames(): string[] {
  try {
    return readdirSync(pluginDirectory())
      .filter(file => /^[a-z][a-z0-9_-]*\.json$/.test(file))
      .map(file => file.slice(0, -5))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new PluginError('PLUGIN_REGISTRY_INVALID', '无法读取插件目录');
  }
}
