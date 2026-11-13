import { readHelpCapabilities, formatCapabilityHelp } from './capabilityHelp.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, CommanderError } from 'commander';
import { listInstalledProviders } from '@mearl/provider/host';
import { resolveActionTimeoutSec } from './actionTimeouts.js';
import { runUnifiedCheck, parseCheckTimeout, type UnifiedCheckOptions } from './check.js';
import {
  commandInput,
  findCommandSuggestions,
  formatCommandSuggestions,
  type SuggestableCommand,
} from './commandSuggestions.js';
import { COMMANDS, COMMAND_MAP } from './commands.js';
import { formatCommandHelp } from './commandHelp.js';
import { CLIENT_VERSION } from './socket.js';
import { UnifiedClient } from './unified.js';
import {
  findPluginEntry,
  findPluginRegistration,
  findOfficialPlugin,
  listPluginNames,
  listOfficialPluginNames,
  loadRegisteredPlugin,
  PluginError,
  type PluginProgress,
} from './plugins/sdk/plugin.js';
import { resolveServer } from './unifiedConfig.js';
import type { InstalledProviderManifest, ProviderInputSchema } from '@mearl/provider';

const TOP_LEVEL_COMMAND_NAME_WIDTH = 22;

const CATEGORIES: { title: string; names: string[] }[] = [
  {
    title: 'API 调试',
    names: ['tab_checkpoint', 'get_requests', 'get_logs', 'get_events'],
  },
  { title: 'Mock & 规则', names: ['set_mock', 'get_mocks', 'set_rule', 'get_rules'] },
  {
    title: '网络请求',
    names: ['send_request', 'request_permission'],
  },
  { title: '标签页', names: ['tab_open', 'tab_list', 'tab_group', 'tab_close'] },
  {
    title: '页面感知',
    names: ['page_snapshot', 'page_inspect', 'page_screenshot', 'page_record', 'page_frames'],
  },
  {
    title: '页面操作',
    names: [
      'page_click',
      'page_drag',
      'page_type',
      'page_hover',
      'page_scroll',
      'page_press',
      'page_wait',
      'page_navigate',
      'page_upload',
      'page_download',
      'page_eval',
      'page_call_tool',
    ],
  },
  { title: '组合调用', names: ['run_actions'] },
  {
    title: '环境与 Cookie',
    names: ['set_device_emulation', 'set_app_profile', 'set_timezone', 'get_cookie', 'set_cookie'],
  },
  {
    title: '浏览器',
    names: [
      'browser_list',
      'browser_launch',
      'browser_release',
      'browser_close',
      'browser_control',
    ],
  },
];

const BUILTIN_COMMANDS: readonly SuggestableCommand[] = [
  {
    name: 'guide',
    description: '按需读取与当前 CLI 配套的本地指南',
    examples: ['guide', 'guide environment'],
  },
  {
    name: 'run',
    description: '执行预注入 mearl SDK 的 Node.js 脚本',
    examples: ['run --file task.mjs'],
  },
  {
    name: 'check',
    description: '检查指定浏览器，未指定时检查全部已连接浏览器',
    examples: ['check'],
  },
];

const AUTO_INSTALL_PLUGIN_COMMANDS: readonly SuggestableCommand[] = listOfficialPluginNames().map(
  name => ({
    name,
    description: findOfficialPlugin(name)!.description,
    examples: [name],
  }),
);
const SUGGESTABLE_COMMANDS: readonly SuggestableCommand[] = [
  ...COMMANDS,
  ...BUILTIN_COMMANDS,
  ...AUTO_INSTALL_PLUGIN_COMMANDS,
];
const ADVANCED_BUILTIN_COMMANDS = new Set(['connector_list']);

export interface MearlCliOptions {
  commandName?: string;
  clientVersion?: string;
}

export interface ParsedArgs {
  session?: string;
  action: string;
  browser?: string;
  compact: boolean;
  connector?: string;
  json: boolean;
  local: boolean;
  updates: boolean;
  outputPath?: string;
  payload: Record<string, any>;
  serverUrl?: string;
  serverUrlSource?: string;
  timeoutSec: number;
  timeoutOption?: string;
  pluginArgs?: string[];
  pluginInput?: Record<string, unknown>;
  help?: boolean;
  version?: boolean;
  verbose?: boolean;
  hasPayload?: boolean;
}

interface ClientCliOptions {
  session?: string;
  all?: boolean;
  help?: boolean;
  browser?: string;
  compact?: boolean;
  connector?: string;
  json?: boolean;
  local?: boolean;
  updates?: boolean;
  output?: string;
  payload?: string;
  payloadFile?: string;
  server?: string;
  timeout?: string;
  verbose?: boolean;
  version?: boolean;
}

const PLUGIN_HOST_OPTIONS = new Set([
  '--all',
  '--browser',
  '--compact',
  '--connector',
  '--help',
  '--json',
  '--local',
  '--updates',
  '--output',
  '--payload',
  '--payload-file',
  '--server',
  '--session',
  '--timeout',
  '--verbose',
  '--version',
]);

function findPluginInputOptionNames(args: string[]): string[] {
  const names = new Set<string>();
  for (const argument of args) {
    if (!argument.startsWith('--') || argument === '--') continue;
    const equals = argument.indexOf('=');
    const option = equals === -1 ? argument : argument.slice(0, equals);
    if (PLUGIN_HOST_OPTIONS.has(option)) continue;
    const name = option.slice(2);
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`无效的插件业务选项: ${option}`);
    }
    names.add(name);
  }
  return [...names];
}

function printUsage(commandName: string, version: string): void {
  const lines = [
    `${commandName} v${version}`,
    '',
    '用法：',
    `  ${commandName} <action> [选项]`,
    `  ${commandName} <action> --help`,
    `  ${commandName} check [选项]`,
    `  ${commandName} run [--file <path>] [选项]`,
    `  ${commandName} guide [topic]`,
    '',
    '常用选项：',
    '  --payload <json>      直接传入 JSON 参数',
    '  --payload-file <path> 从文件读取整个 JSON 参数',
    '  --timeout <seconds>   超时时间（默认按 action 推导）',
    '  --compact             强制紧凑 JSON（管道默认紧凑，交互终端默认美化）',
    '  --output <path>       保存输出或截图',
    '  --session <new|id>    首次建立或复用控制会话',
    '  --browser <id|名称>   指定 browser_list 返回的浏览器',
    '',
    '其他选项：',
    '  -h, --help            查看帮助',
    '  -v, --version         查看版本',
    '',
    '内置命令：',
    `  ${'guide'.padEnd(TOP_LEVEL_COMMAND_NAME_WIDTH)}读取本地核心流程或单个专题；--list 查看主题`,
    `  ${'run'.padEnd(TOP_LEVEL_COMMAND_NAME_WIDTH)}执行 Node.js 脚本，支持浏览器 API 与 Skill 命令`,
    `  ${'check'.padEnd(TOP_LEVEL_COMMAND_NAME_WIDTH)}检查指定浏览器，未指定时检查全部已连接浏览器`,
  ];

  for (const category of CATEGORIES) {
    lines.push('', `  ${category.title}`);
    for (const name of category.names) {
      const command = COMMAND_MAP.get(name);
      if (command) lines.push(`    ${name.padEnd(26)}${command.summary ?? command.description}`);
    }
  }
  try {
    const plugins = listPluginNames();
    if (plugins.length) {
      const entries = plugins.flatMap(name => {
        try {
          const registration = findPluginRegistration(name);
          if (registration?.hasPublicCommands === false) return [];
          const description = registration?.description;
          return description
            ? `  ${name.padEnd(TOP_LEVEL_COMMAND_NAME_WIDTH)}${description}`
            : `  ${name}`;
        } catch {
          return `  ${name}`;
        }
      });
      if (entries.length) lines.push('', '已注册插件：', ...entries);
    }
  } catch (error) {
    lines.push('', error instanceof Error ? error.message : String(error));
  }
  const providers = listInstalledProviders();
  if (providers.length) {
    lines.push(
      '',
      '已注册 Provider：',
      ...providers.map(
        provider =>
          `  ${provider.providerId.padEnd(TOP_LEVEL_COMMAND_NAME_WIDTH)}${provider.name} v${provider.version} (${provider.packageName})`,
      ),
    );
  }
  console.error(lines.join('\n'));
}

function providerSchemaLine(
  name: string,
  schema: ProviderInputSchema,
  required: boolean,
  indent = 2,
): string {
  const detail = [
    required ? '必填' : '可选',
    schema.type,
    schema.type === 'string' && schema.secret ? '敏感' : undefined,
    schema.title,
    schema.description,
    schema.default === undefined ? undefined : `默认 ${JSON.stringify(schema.default)}`,
  ].filter(Boolean);
  return `${' '.repeat(indent)}${name.padEnd(Math.max(1, 24 - indent))}${detail.join(' · ')}`;
}

function providerSchemaLines(
  name: string,
  schema: ProviderInputSchema,
  required: boolean,
  indent = 2,
): string[] {
  const lines = [providerSchemaLine(name, schema, required, indent)];
  if (schema.type === 'object') {
    const childRequired = new Set(schema.required ?? []);
    for (const [childName, childSchema] of Object.entries(schema.properties)) {
      lines.push(
        ...providerSchemaLines(childName, childSchema, childRequired.has(childName), indent + 2),
      );
    }
  } else if (schema.type === 'array' && schema.items.type === 'object') {
    const childRequired = new Set(schema.items.required ?? []);
    for (const [childName, childSchema] of Object.entries(schema.items.properties)) {
      lines.push(
        ...providerSchemaLines(childName, childSchema, childRequired.has(childName), indent + 2),
      );
    }
  }
  return lines;
}

function printProviderHelp(
  commandName: string,
  provider: InstalledProviderManifest,
  extensionHelp?: string,
): void {
  const browserType = provider.browserType;
  const lines = [
    `${provider.providerId} — ${provider.name} v${provider.version}`,
    '',
    ...(browserType.help ?? []).map(line => String(line)),
  ];
  if (browserType.help?.length) lines.push('');
  lines.push(
    '创建：',
    `  ${commandName} browser_launch --payload '{"provider":"${provider.providerId}","providerOptions":{}}'`,
    '',
    '启动参数（providerOptions）：',
  );
  const required = new Set(browserType.inputSchema.required ?? []);
  const properties = Object.entries(browserType.inputSchema.properties);
  if (properties.length === 0) lines.push('  （无）');
  else {
    for (const [name, schema] of properties) {
      lines.push(...providerSchemaLines(name, schema, required.has(name)));
    }
  }
  if (browserType.inputSchema.oneOf?.length) {
    lines.push('', '可选模式：');
    browserType.inputSchema.oneOf.forEach((schema, index) => {
      const mode = schema.title || `模式 ${index + 1}`;
      const requiredFields = schema.required?.length ? schema.required.join(', ') : '无必填字段';
      lines.push(`  ${mode}（必填：${requiredFields}）`);
    });
  }
  lines.push(
    '',
    '发现与检查：',
    `  ${commandName} browser_list`,
    `  ${commandName} check --browser <browserId>`,
    '',
    '管理：',
    `  npx @mearl/setup provider update ${provider.providerId}`,
    `  npx @mearl/setup provider uninstall ${provider.providerId}`,
  );
  if (browserType.configuration) {
    lines.push('', 'Provider 配置（在 Mearl 浏览器管理器中填写）：');
    const configurationRequired = new Set(browserType.configuration.inputSchema.required ?? []);
    for (const [name, schema] of Object.entries(browserType.configuration.inputSchema.properties)) {
      lines.push(...providerSchemaLines(name, schema, configurationRequired.has(name)));
    }
  }
  if (browserType.documentationUrl) {
    lines.push('', `文档：${browserType.documentationUrl}`);
  }
  if (extensionHelp) {
    lines.push(
      '',
      '扩展命令：',
      extensionHelp,
      '',
      `运行 ${commandName} ${provider.providerId} <command> --help 查看命令参数。`,
    );
  }
  console.error(lines.join('\n'));
}

async function sameNamePluginHelp(commandName: string, name: string): Promise<string | undefined> {
  try {
    if (!findPluginEntry(name)) return undefined;
    const plugin = await loadRegisteredPlugin(name, {
      async invoke() {
        throw new Error('生成插件帮助时不能调用宿主能力');
      },
    });
    return plugin.commandHelp(`${commandName} ${name}`);
  } catch (error) {
    return `  （扩展命令帮助不可用：${error instanceof Error ? error.message : String(error)}）`;
  }
}

function installedProvider(name: string | undefined): InstalledProviderManifest | undefined {
  if (!name) return undefined;
  return listInstalledProviders().find(provider => provider.providerId === name);
}

function printCheckHelp(commandName: string): void {
  console.error(
    [
      'check',
      '  检查指定浏览器，未指定时检查全部已连接浏览器',
      '',
      '用法：',
      `  ${commandName} check [选项]`,
      '',
      '选项：',
      '  --browser <id|名称>   只检查指定浏览器',
      '  --connector <id|名称> 限制到一台远端 connector',
      '  --local               只检查当前机器，不能与 --connector 同时使用',
      '  --server <url>        覆盖 cloud-server WebSocket URL',
      '  --timeout <seconds>   单项检查超时时间，默认 5 秒',
      '  --json                输出机器可读 JSON',
      '  --updates            查询已安装组件的发布版本',
      '  -h, --help            查看帮助',
      '',
      '检查本机及远端控制链路；发现错误时退出码为 1。',
      'Server 地址优先级：--server > MEARL_SERVER_URL > ~/.mearl/cloud-server.json。',
    ].join('\n'),
  );
}

function printAdvancedCommandHelp(commandName: string, action: string): void {
  if (action !== 'connector_list') return;
  console.error(
    [
      'connector_list',
      '  列出 cloud-server 下的 connector（高级诊断）',
      '',
      '用法：',
      `  ${commandName} connector_list [--server <url>] [--timeout <seconds>]`,
      '结果包含 count 与 connectors；每项包含 ID、名称、可选版本、连接时间和最后心跳。',
    ].join('\n'),
  );
}

function printInternalCommandHelp(commandName: string, action: string): void {
  console.error(
    [
      action,
      action === '__extension_reload'
        ? '  重载目标浏览器中的 Mearl 扩展。'
        : '  内部动作透传入口；是否支持及参数要求由目标宿主决定。',
      '',
      '用法：',
      `  ${commandName} ${action} [--payload '<JSON>'] [--browser <id|名称>] [--local] [--timeout <seconds>]`,
      '',
      '--local 只使用本机连接；多浏览器时用 --browser 指定目标。',
      '此帮助不会连接浏览器或执行动作。内部动作不属于稳定的公共 API。',
    ].join('\n'),
  );
}

function printUnknownCommand(commandName: string, args: string[]): void {
  const input = commandInput(args) || args[0] || '';
  const suggestions = findCommandSuggestions(args, SUGGESTABLE_COMMANDS);
  const lines = [`PLUGIN_NOT_REGISTERED: 不支持的命令: ${input}`];
  if (suggestions.length > 0) {
    lines.push('', '你可能想用：', ...formatCommandSuggestions(commandName, suggestions));
  } else {
    lines.push(`运行 ${commandName} --help 查看所有可用命令`);
  }
  console.error(lines.join('\n'));
}

function parsePositiveTimeout(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('--timeout 必须是大于 0 的数字');
  }
  return parsed;
}

function parsePayload(payloadRaw?: string, payloadFile?: string): Record<string, any> {
  if (payloadRaw !== undefined && payloadFile !== undefined) {
    throw new Error('--payload 与 --payload-file 不能同时使用');
  }
  if (payloadRaw !== undefined) {
    try {
      return JSON.parse(payloadRaw);
    } catch (error) {
      throw new Error('无效的 JSON payload', { cause: error });
    }
  }
  if (payloadFile !== undefined) {
    try {
      return JSON.parse(readFileSync(resolve(payloadFile), 'utf8'));
    } catch (error) {
      throw new Error(`无法读取或解析 payload 文件: ${payloadFile}`, { cause: error });
    }
  }
  return {};
}

function normalizeScreenshotOutput(
  action: string,
  payload: Record<string, any>,
  explicitOutput?: string,
): { payload: Record<string, any>; outputPath?: string } {
  if (action !== 'page_screenshot' || !Object.hasOwn(payload, 'output')) {
    return { payload, ...(explicitOutput ? { outputPath: explicitOutput } : {}) };
  }

  const payloadOutput = payload.output;
  if (typeof payloadOutput !== 'string' || payloadOutput.trim() === '') {
    throw new Error('page_screenshot 的 payload.output 必须是非空路径');
  }
  if (explicitOutput !== undefined) {
    throw new Error('page_screenshot 的 payload.output 不能与 --output 同时使用');
  }

  const { output: _output, ...normalizedPayload } = payload;
  return { payload: normalizedPayload, outputPath: payloadOutput };
}

function actionInvocationFailed(action: string, result: any): boolean {
  if (result?.action?.success === false) return true;
  if (action !== 'run_actions') return false;
  if (Number.isInteger(result?.failedStep)) return true;
  return Array.isArray(result?.results)
    ? result.results.some((step: any) => step?.success === false)
    : false;
}

export function parseClientArgs(args: string[], plugin = false): ParsedArgs {
  const pluginInputOptionNames = plugin ? findPluginInputOptionNames(args) : [];
  const program = new Command()
    .name('mearl')
    .helpOption(false)
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} })
    .argument('<action>')
    .option('--payload <json>')
    .option('--payload-file <path>')
    .option('--timeout <seconds>')
    .option('--compact')
    .option('--json')
    .option('--output <path>')
    .option('--browser <id-or-name>')
    .option('--session <new-or-id>')
    .option('--connector <id-or-name>')
    .option('--local')
    .option('--updates')
    .option('--server <url>');
  if (plugin)
    program
      .argument('[pluginArgs...]')
      .option('--all')
      .option('-h, --help')
      .option('-v, --version')
      .option('--verbose');
  for (const name of pluginInputOptionNames) program.option(`--${name} <value>`);
  try {
    program.parse(['node', 'mearl', ...args]);
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new Error(error.message.replace(/^error:\s*/i, ''), { cause: error });
    }
    throw error;
  }

  const action = program.processedArgs[0] as string;
  const options = program.opts<ClientCliOptions & Record<string, unknown>>();
  if (plugin && options.payloadFile !== undefined) {
    throw new Error('插件使用 --payload 传入 command 和 input；正文文件可由业务字段引用');
  }
  const pluginInput = {
    ...Object.fromEntries(
      pluginInputOptionNames
        .filter(name => Object.hasOwn(options, name))
        .map(name => [name, options[name]]),
    ),
    ...(plugin && options.all === true ? { all: true } : {}),
  };
  if (plugin && options.payload !== undefined && Object.keys(pluginInput).length > 0) {
    throw new Error('插件业务选项不能与 --payload 同时使用');
  }
  const json = options.json === true;
  if (json && action !== 'check' && !plugin) throw new Error('--json 仅适用于 check');
  if (options.updates && action !== 'check') throw new Error('--updates 仅适用于 check');
  const parsedPayload = parsePayload(options.payload, options.payloadFile);
  const { payload, outputPath } = normalizeScreenshotOutput(action, parsedPayload, options.output);
  const fallbackTimeout = resolveActionTimeoutSec(action, payload, 60);
  const local = options.local === true;
  const connector = options.connector;
  if (local && connector) throw new Error('--local 不能与 --connector 同时使用');
  return {
    action,
    payload,
    timeoutSec: parsePositiveTimeout(options.timeout, fallbackTimeout),
    ...(options.timeout !== undefined ? { timeoutOption: options.timeout } : {}),
    compact: options.compact === true || process.stdout.isTTY !== true,
    json,
    local,
    updates: options.updates === true,
    ...(outputPath ? { outputPath } : {}),
    ...(options.browser ? { browser: options.browser } : {}),
    ...(options.session ? { session: options.session } : {}),
    ...(connector ? { connector } : {}),
    ...resolveServer(options.server),
    ...(plugin
      ? {
          pluginArgs: program.processedArgs[1] as string[],
          ...(Object.keys(pluginInput).length > 0 ? { pluginInput } : {}),
          help: options.help === true,
          version: options.version === true,
          verbose: options.verbose === true,
          hasPayload: options.payload !== undefined,
        }
      : {}),
  };
}

async function runPluginCli(args: string[], commandName: string): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseClientArgs(args, true);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  let client: UnifiedClient | undefined;
  try {
    const invokeOptions = {
      ...(parsed.timeoutOption ? { timeoutSec: parsed.timeoutSec } : {}),
      ...(parsed.browser ? { browser: parsed.browser } : {}),
      ...(parsed.session ? { session: parsed.session } : {}),
      ...(parsed.connector ? { connector: parsed.connector } : {}),
      ...(parsed.local ? { local: true } : {}),
    };
    const plugin = await loadRegisteredPlugin(
      parsed.action,
      {
        async invoke(action, payload, options) {
          client ??= new UnifiedClient({
            ...(parsed.serverUrl ? { serverUrl: parsed.serverUrl } : {}),
          });
          return client.invoke(action, payload, options);
        },
      },
      {
        ...invokeOptions,
        source: 'cli',
        ...(parsed.verbose
          ? {
              onProgress(progress: PluginProgress) {
                const message = typeof progress === 'string' ? progress : progress.message;
                process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
              },
            }
          : {}),
      },
    );
    if (parsed.version) {
      console.log(plugin.version ?? 'unknown');
      return 0;
    }
    if (
      parsed.help ||
      (!plugin.defaultCommand &&
        !parsed.pluginArgs?.length &&
        !parsed.hasPayload &&
        !Object.keys(parsed.pluginInput ?? {}).length)
    ) {
      console.error(plugin.help(`${commandName} ${parsed.action}`, parsed.pluginArgs?.[0]));
      return 0;
    }
    const result = await plugin.run(
      parsed.pluginArgs ?? [],
      parsed.hasPayload ? parsed.payload : undefined,
      parsed.pluginInput,
    );
    if (result !== undefined) {
      if (parsed.outputPath) writeOutput('', result, parsed.outputPath);
      else if (typeof result === 'string')
        process.stdout.write(result.endsWith('\n') ? result : `${result}\n`);
      else
        process.stdout.write(`${JSON.stringify(result, null, parsed.compact ? undefined : 2)}\n`);
    }
    return result &&
      typeof result === 'object' &&
      !Array.isArray(result) &&
      'success' in result &&
      result.success === false
      ? 1
      : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof PluginError ? 2 : 1;
  } finally {
    client?.disconnect();
  }
}

function screenshotData(action: string, result: any): string | null {
  if (typeof result === 'string' && result.startsWith('data:image')) {
    return result.split(',')[1] ?? null;
  }
  if (action === 'page_screenshot' && typeof result?.data === 'string') return result.data;
  return null;
}

function writeOutput(action: string, result: any, outputPath: string): void {
  const image = screenshotData(action, result);
  if (image) {
    writeFileSync(outputPath, Buffer.from(image, 'base64'));
  } else {
    writeFileSync(
      outputPath,
      typeof result === 'string' ? result : `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );
  }
  console.error(`✓ Output saved to: ${outputPath}`);
}

export async function runMearlCli(args: string[], options: MearlCliOptions = {}): Promise<number> {
  const commandName = options.commandName ?? 'mearl';
  const clientVersion = options.clientVersion ?? CLIENT_VERSION;
  if (args[0] === 'guide') {
    const { runGuideCli } = await import('./guide.js');
    return runGuideCli(args.slice(1), commandName, clientVersion);
  }
  if (args[0] === 'run') {
    const { runScriptCli } = await import('./scriptCli.js');
    return runScriptCli(args.slice(1), commandName);
  }
  if (args[0] === 'capture_checkpoint') args = ['tab_checkpoint', ...args.slice(1)];

  const provider = installedProvider(args[0]);
  if (
    provider &&
    (args.length === 1 || args.slice(1).every(arg => arg === '--help' || arg === '-h'))
  ) {
    const extensionHelp = await sameNamePluginHelp(commandName, provider.providerId);
    printProviderHelp(commandName, provider, extensionHelp);
    return 0;
  }

  if (
    args[0] &&
    !args[0].startsWith('-') &&
    !args[0].startsWith('__') &&
    args[0] !== 'check' &&
    !ADVANCED_BUILTIN_COMMANDS.has(args[0]) &&
    !COMMAND_MAP.has(args[0])
  ) {
    try {
      const entry = findPluginEntry(args[0]);
      if (entry || findOfficialPlugin(args[0])) return await runPluginCli(args, commandName);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  if (args[0] === '--version' || args[0] === '-v') {
    console.log(clientVersion);
    return 0;
  }
  if (args.length === 0) {
    printUsage(commandName, clientVersion);
    return 1;
  }
  if (args.includes('--help') || args.includes('-h')) {
    const command = COMMAND_MAP.get(args[0]!);
    if (command) {
      console.error(formatCommandHelp(commandName, command));
      if (command.name === 'set_app_profile' || command.name === 'tab_open')
        console.error(formatCapabilityHelp(await readHelpCapabilities(args), true));
    } else if (args[0] === 'check') printCheckHelp(commandName);
    else if (ADVANCED_BUILTIN_COMMANDS.has(args[0]!)) {
      printAdvancedCommandHelp(commandName, args[0]!);
    } else if (args[0]?.startsWith('__')) {
      printInternalCommandHelp(commandName, args[0]);
    } else if (args[0]?.startsWith('-')) {
      printUsage(commandName, clientVersion);
      console.error(formatCapabilityHelp(await readHelpCapabilities(args)));
    } else {
      printUnknownCommand(commandName, args);
      return 2;
    }
    return 0;
  }

  if (args[0] !== 'check' && args[0] !== 'connector_list' && !COMMAND_MAP.has(args[0]!)) {
    if (!args[0]!.startsWith('__')) {
      printUnknownCommand(commandName, args);
      return 2;
    }
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseClientArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (parsed.action === 'check') {
    const timeoutSec = parseCheckTimeout(parsed.timeoutOption);
    if (timeoutSec === null) {
      console.error('--timeout 必须是正整数秒');
      return 2;
    }
    const checkOptions: UnifiedCheckOptions = {
      clientVersion,
      timeoutSec,
      ...(parsed.serverUrl ? { serverUrl: parsed.serverUrl } : {}),
      ...(parsed.serverUrlSource ? { serverUrlSource: parsed.serverUrlSource } : {}),
      ...(parsed.browser ? { browser: parsed.browser } : {}),
      ...(parsed.session ? { session: parsed.session } : {}),
      ...(parsed.connector ? { connector: parsed.connector } : {}),
      ...(parsed.local ? { local: true } : {}),
      ...(parsed.updates ? { checkUpdates: true } : {}),
    };
    if (parsed.json) {
      const result = await runUnifiedCheck({ ...checkOptions, json: true });
      return result.ok ? 0 : 1;
    }
    return (await runUnifiedCheck(checkOptions)) ? 0 : 1;
  }

  const client = new UnifiedClient({
    ...(parsed.serverUrl ? { serverUrl: parsed.serverUrl } : {}),
    requestTimeoutSec: parsed.timeoutSec,
  });
  try {
    if (parsed.action === 'page_record' && parsed.outputPath && parsed.payload.operation !== 'stop')
      throw new Error('page_record --output requires operation "stop"');
    const result = await client.invoke(parsed.action, parsed.payload, {
      timeoutSec: parsed.timeoutSec,
      ...(parsed.browser ? { browser: parsed.browser } : {}),
      ...(parsed.session ? { session: parsed.session } : {}),
      ...(parsed.connector ? { connector: parsed.connector } : {}),
      ...(parsed.local ? { local: true } : {}),
    });
    if (
      parsed.outputPath &&
      (parsed.action === 'page_download' || parsed.action === 'page_record')
    ) {
      const artifact = parsed.action === 'page_download' ? result.download : result.recording;
      await client.saveArtifact(artifact, resolve(parsed.outputPath), {
        ...(parsed.session ? { session: parsed.session } : {}),
      });
      process.stdout.write(
        JSON.stringify({ ...result, outputPath: resolve(parsed.outputPath) }) + '\n',
      );
      if (!parsed.session && parsed.action === 'page_download')
        await client.invoke(
          '__artifact_remove',
          { artifactId: result.download.artifactId },
          { browser: result.download.browserId },
        );
    } else if (parsed.outputPath) {
      writeOutput(parsed.action, result, parsed.outputPath);
      if (parsed.action === 'page_screenshot' && result?.session) {
        const { data: _image, ...metadata } = result;
        process.stdout.write(
          JSON.stringify({ ...metadata, outputPath: resolve(parsed.outputPath) }) + '\n',
        );
      }
    } else {
      process.stdout.write(
        `${parsed.compact ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`,
      );
    }
    return actionInvocationFailed(parsed.action, result) ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    if (/connection timeout/i.test(message)) {
      console.error('连接未就绪，请运行 mearl check 定位控制链路故障。');
    } else if (/请求超时|(?:request|command) timeout|timed out/i.test(message)) {
      console.error(
        '超时不代表动作未执行。点击、提交或写入后先读取当前状态确认结果；只读查询可缩小范围或增加 --timeout（秒）后重试。',
      );
    }
    return 1;
  } finally {
    client.disconnect();
  }
}
