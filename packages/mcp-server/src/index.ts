#!/usr/bin/env node

/**
 * Mearl MCP Server
 *
 * 提供 MCP 工具让 AI 能够与浏览器交互:
 * - browser_get_requests: 获取历史请求
 * - browser_get_events: 获取 RUM/aplus/ARMS 埋点事件
 * - browser_get_logs: 获取控制台日志
 * - browser_set_mock: 设置 Mock 数据
 *
 * 命令行参数:
 * - configure / --configure: 运行配置向导
 * - uninstall / --uninstall: 卸载并清理配置
 * - --extension-id=ID: 指定 Chrome Extension ID
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import * as client from '@mearl/client';
import { executeScript } from '@mearl/client/script';
import { invokePluginTool } from './pluginTools.js';
import { writeFileSync, appendFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import {
  RESPONSE_SIZE_SMALL,
  RESPONSE_SIZE_MEDIUM,
  RESPONSE_SIZE_LARGE,
  RESPONSE_SIZE_MAX,
} from './constants.js';

const require = createRequire(import.meta.url);
const MCP_SERVER_VERSION = (require('../package.json') as { version: string }).version;
const BROWSER_DEVICE_PRESET_NAMES = client.BROWSER_DEVICE_PRESET_NAMES;

const MCP_TOOL_ACTIONS = {
  browser_tab_checkpoint: 'tab_checkpoint',
  browser_get_requests: 'get_requests',
  browser_get_events: 'get_events',
  browser_get_logs: 'get_logs',
  browser_set_mock: 'set_mock',
  browser_get_mocks: 'get_mocks',
  browser_send_request: 'send_request',
  browser_set_rule: 'set_rule',
  browser_get_rules: 'get_rules',
  browser_get_capabilities: 'get_capabilities',
  browser_page_screenshot: 'page_screenshot',
  browser_launch: 'browser_launch',
  browser_close: 'browser_close',
  browser_release: 'browser_release',
  browser_control: 'browser_control',
  browser_page_download: 'page_download',
  browser_tab_open: 'tab_open',
  browser_tab_close: 'tab_close',
  browser_tab_list: 'tab_list',
  browser_tab_group: 'tab_group',
  browser_page_click: 'page_click',
  browser_page_drag: 'page_drag',
  browser_page_type: 'page_type',
  browser_page_scroll: 'page_scroll',
  browser_page_hover: 'page_hover',
  browser_page_eval: 'page_eval',
  browser_page_inspect: 'page_inspect',
  browser_page_snapshot: 'page_snapshot',
  browser_page_press: 'page_press',
  browser_page_wait: 'page_wait',
  browser_page_navigate: 'page_navigate',
  browser_page_upload: 'page_upload',
  browser_page_frames: 'page_frames',
  browser_set_device_emulation: 'set_device_emulation',
  browser_set_app_profile: 'set_app_profile',
  browser_set_timezone: 'set_timezone',
  browser_get_cookie: 'get_cookie',
  browser_set_cookie: 'set_cookie',
  browser_run_actions: 'run_actions',
  browser_list: 'browser_list',
  browser_select_browser: 'browser_select_browser',
  browser_request_permission: 'request_permission',
} as const satisfies Record<string, client.BrowserAction>;

const PLUGIN_INVOKE_TOOL_NAME = 'plugin_invoke' as const;
const RUN_CODE_TOOL_NAME = 'browser_run_code' as const;
type McpBrowserToolName = keyof typeof MCP_TOOL_ACTIONS;
type McpToolName = McpBrowserToolName | typeof PLUGIN_INVOKE_TOOL_NAME | typeof RUN_CODE_TOOL_NAME;
type McpMappedAction = (typeof MCP_TOOL_ACTIONS)[McpBrowserToolName];
type McpOmittedAction = 'capture_checkpoint' | 'page_runtime';
type AssertNever<T extends never> = T;
type _UnmappedMcpActions = AssertNever<
  Exclude<client.BrowserAction, McpMappedAction | McpOmittedAction>
>;

function defineMcpTools<const T extends Array<Tool & { name: McpToolName }>>(tools: T): T {
  return tools;
}

// 日志输出到 stderr（不影响 stdio 通信）
const LOG_FILE = join(tmpdir(), 'mearl-mcp-server.log');
const log = (...args: any[]) => {
  const msg = `[${new Date().toISOString()}] [MCP Server] ${args.join(' ')}\n`;
  try {
    appendFileSync(LOG_FILE, msg);
  } catch {
    // Ignore
  }
  console.error('[MCP Server]', ...args);
};

function printCliHelp(): void {
  console.error(`mearl-mcp-server v${MCP_SERVER_VERSION}

Usage:
  mearl-mcp-server                       Start the MCP stdio server
  mearl-mcp-server configure [options]   Configure Native Host and MCP clients
  mearl-mcp-server uninstall [options]   Remove Native Host and MCP client config

Options:
  --extension-id <id>     Extension ID for configure
  --skip-mcp              Skip MCP client configuration
  --get                   Print current configuration
  --global-install        Use the globally installed command
  --managed-by-setup      Suppress global uninstall guidance
  --yes, -y               Run configure or uninstall without prompts
  --non-interactive       Alias for --yes
  --version, -v           Show version
  --help, -h              Show this help`);
}

/**
 * 分析响应数据，提供统计信息
 */
function analyzeResponseData(result: any): {
  largestFields?: Array<{ path: string; size: number }>;
  meta?: any;
} {
  const stats: any = {};

  try {
    if (result && typeof result === 'object' && result.meta) {
      stats.meta = result.meta;

      // 分析实际数据数组
      const dataArray = result.requests || result.logs;
      if (Array.isArray(dataArray) && dataArray.length > 0) {
        const sample = dataArray[0];
        const fieldSizes: Array<{ path: string; size: number }> = [];

        for (const [key, value] of Object.entries(sample)) {
          if (value !== null && value !== undefined) {
            const size = JSON.stringify(value).length;
            fieldSizes.push({ path: key, size });
          }
        }

        // 按大小排序，取前 3 个
        fieldSizes.sort((a, b) => b.size - a.size);
        stats.largestFields = fieldSizes.slice(0, 3);
      }
    }
  } catch {
    // 忽略分析错误
  }

  return stats;
}

/**
 * 根据工具名称和参数生成优化建议
 */
function getOptimizationSuggestions(
  toolName: string,
  args: any,
  result: any,
  stats: ReturnType<typeof analyzeResponseData>,
): string[] {
  const suggestions: string[] = [];

  if (toolName === 'browser_get_requests') {
    const count = args.count || 10;
    const hasFields = args.fields && args.fields.length > 0;
    const includeBody = args.includeBody ?? !hasFields;
    const keysOnly = args.keysOnly === true;

    // 最优先建议：使用字段提取
    if (!keysOnly && !hasFields && includeBody) {
      suggestions.push('Use "keysOnly: true" to preview data structure first');
      suggestions.push('Use "fields: [...]" to extract only needed fields');

      // 基于实际数据推荐字段
      if (stats.largestFields && stats.largestFields.length > 0) {
        const fieldNames = stats.largestFields
          .filter(f => !['responseBody', 'postData'].includes(f.path))
          .map(f => f.path);
        if (fieldNames.length > 0) {
          suggestions.push(`Example: { fields: ["${fieldNames[0]}", "apiName", "status"] }`);
        }
      }
    }

    // Body 相关建议
    if (includeBody) {
      const hasLargeBody = stats.largestFields?.some(
        f => ['responseBody', 'postData'].includes(f.path) && f.size > 10000,
      );

      if (hasLargeBody) {
        suggestions.push(
          'Response/request bodies are large - consider setting "includeBody: false"',
        );
        suggestions.push(`Or reduce "maxBodySize" (current: ${args.maxBodySize || 50000} bytes)`);
      }
    }

    // 数量建议
    if (count > 10) {
      suggestions.push(`Reduce "count" from ${count} to fewer requests`);
    }

    // 过滤建议
    if (!args.filter) {
      suggestions.push('Add "filter" regex to match specific APIs (e.g., ".*\\.cart\\..*")');
    }

    // Headers 建议
    if (args.includeHeaders) {
      suggestions.push('Set "includeHeaders: false" to omit headers (often not needed)');
    }
  }

  if (toolName === 'browser_get_logs') {
    const limit = args.limit || 100;
    if (limit > 50) {
      suggestions.push(`Reduce "limit" from ${limit} to fewer logs`);
    }
    if (!args.filter) {
      suggestions.push('Add "filter" to match specific log patterns');
    }
    if (!args.level || args.level === 'all') {
      suggestions.push('Filter by specific "level" (error/warn/info/log)');
    }
  }

  return suggestions;
}

/**
 * 智能格式化响应，根据大小决定格式化策略和是否添加提示
 */
function formatResponseWithSizeCheck(
  result: any,
  toolName: string,
  args: any,
): Array<{ type: 'text'; text: string }> {
  // 先序列化为压缩格式测量大小
  const compactStr = JSON.stringify(result);
  const compactSize = Buffer.byteLength(compactStr, 'utf-8');

  // 预估格式化后的大小（约 1.7 倍）
  const estimatedFormattedSize = compactSize * 1.7;

  const sizeKB = Math.round(compactSize / 1024);
  const formattedSizeKB = Math.round(estimatedFormattedSize / 1024);

  // 分析数据特征
  const stats = analyzeResponseData(result);

  // 策略 1: 小响应（<50KB 压缩）- 直接格式化输出，无需前置说明
  // meta 信息已经在 JSON 中，AI 可以直接读取
  if (compactSize < RESPONSE_SIZE_SMALL) {
    return [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ];
  }

  // 策略 2: 中等响应（50-200KB 压缩）- 格式化 + 简要提示
  if (compactSize < RESPONSE_SIZE_MEDIUM) {
    const suggestions = getOptimizationSuggestions(toolName, args, result, stats);
    let header = `💡 Response size: ${formattedSizeKB}KB (formatted)`;

    if (suggestions.length > 0) {
      header += `\n\nOptimization suggestions:`;
      header += suggestions.map((s, i) => `\n  ${i + 1}. ${s}`).join('');
    }

    return [
      {
        type: 'text',
        text: `${header}\n\n${'─'.repeat(60)}\n\n${JSON.stringify(result, null, 2)}`,
      },
    ];
  }

  // 策略 3: 大响应（200-500KB 压缩）- 压缩格式 + 优化提示
  if (compactSize < RESPONSE_SIZE_LARGE) {
    const suggestions = getOptimizationSuggestions(toolName, args, result, stats);

    let header = `⚠️ Large response: ${sizeKB}KB (compact format to save space)\n`;
    header += `Formatted size would be ~${formattedSizeKB}KB\n`;

    // 如果有 meta，提取关键信息到头部
    if (stats.meta) {
      header += `\n📊 Data: ${stats.meta.count} items returned`;
      if (stats.meta.totalMatched > stats.meta.count) {
        header += ` (${stats.meta.totalMatched} matched, ${stats.meta.totalInBuffer} in buffer)`;
      }
    }

    if (stats.largestFields && stats.largestFields.length > 0) {
      header += `\nLargest fields per item:`;
      stats.largestFields.forEach(f => {
        header += `\n  • ${f.path}: ~${Math.round(f.size / 1024)}KB`;
      });
    }

    if (suggestions.length > 0) {
      header += `\n\n🎯 Optimization suggestions:`;
      header += suggestions.map((s, i) => `\n  ${i + 1}. ${s}`).join('');
    }

    return [
      {
        type: 'text',
        text: `${header}\n\n${'─'.repeat(60)}\n\n${compactStr}`,
      },
    ];
  }

  // 策略 4: 超大响应（500KB-1MB 压缩）- 压缩格式 + 详细建议
  if (compactSize < RESPONSE_SIZE_MAX) {
    const suggestions = getOptimizationSuggestions(toolName, args, result, stats);

    let header = `🚨 Very large response: ${sizeKB}KB\n`;
    header += `This may cause performance issues and exceed context limits.\n`;

    if (stats.meta) {
      header += `\n📊 Data: ${stats.meta.count} items returned`;
      if (stats.meta.totalMatched > stats.meta.count) {
        header += ` (${stats.meta.totalMatched} matched, ${stats.meta.totalInBuffer} in buffer)`;
      }
    }

    if (stats.largestFields && stats.largestFields.length > 0) {
      header += `\nLargest fields per item:`;
      stats.largestFields.forEach(f => {
        header += `\n  • ${f.path}: ~${Math.round(f.size / 1024)}KB`;
      });
    }

    header += `\n\n🎯 STRONGLY RECOMMENDED optimizations:`;
    if (suggestions.length > 0) {
      header += suggestions.map((s, i) => `\n  ${i + 1}. ${s}`).join('');
    } else {
      header += `\n  1. Reduce the amount of data requested`;
      header += `\n  2. Use filtering parameters to narrow results`;
    }

    return [
      {
        type: 'text',
        text: `${header}\n\n${'─'.repeat(60)}\n\n${compactStr}`,
      },
    ];
  }

  // 策略 5: 超超大响应（>1MB 压缩）- 返回可解析的诊断信息
  const suggestions = getOptimizationSuggestions(toolName, args, result, stats);
  const diagnostic = {
    error: {
      code: 'RESPONSE_TOO_LARGE',
      message: 'The result exceeded the MCP response limit. Narrow the request and retry.',
      originalSizeBytes: compactSize,
      limitBytes: RESPONSE_SIZE_MAX,
    },
    ...(result?.session
      ? {
          session: {
            sessionId: result.session.sessionId,
            browserId: result.session.browserId,
            transport: result.session.transport,
            status: result.session.status,
            generation: result.session.generation,
          },
        }
      : {}),
    ...(result?.failedStep !== undefined
      ? {
          failedStep: result.failedStep,
          completedSteps: result.completedSteps,
          totalSteps: result.totalSteps,
          stage: result.stage,
        }
      : {}),
    ...(result?.action
      ? { action: { name: result.action.name, success: result.action.success } }
      : {}),
    ...(toolName === RUN_CODE_TOOL_NAME
      ? {
          success: result.success,
          executionStopped: result.executionStopped,
          mayHaveLateEffects: result.mayHaveLateEffects,
          pendingActions: result.pendingActions,
        }
      : {}),
    meta: stats.meta,
    largestFields: stats.largestFields?.map(field => ({
      ...field,
      percentageOfTotal: Math.round((field.size / compactSize) * 100),
    })),
    suggestions:
      suggestions.length > 0
        ? suggestions
        : [
            'Significantly reduce the data requested',
            'Use "fields" to extract only essential data',
            'Add filters to narrow down results',
          ],
  };

  return [
    {
      type: 'text',
      text: JSON.stringify(diagnostic, null, 2),
    },
  ];
}

async function main() {
  const rawArgs = process.argv.slice(2);
  let cliArgs: import('./cliArgs.js').ParsedMcpArgs = { forwardedArgs: [], mode: 'server' };
  if (rawArgs.length > 0) {
    try {
      const { parseMcpArgs } = await import('./cliArgs.js');
      cliArgs = await parseMcpArgs(rawArgs);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      printCliHelp();
      process.exitCode = 2;
      return;
    }
  }

  if (cliArgs.mode === 'help') {
    printCliHelp();
    return;
  }
  if (cliArgs.mode === 'version') {
    console.log(MCP_SERVER_VERSION);
    return;
  }

  // 如果是配置命令，执行配置脚本并退出
  if (cliArgs.mode === 'configure') {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const configureScript = join(__dirname, 'configure-bin.js');

    const child = spawn(process.execPath, [configureScript, ...cliArgs.forwardedArgs], {
      stdio: 'inherit',
    });

    child.on('exit', code => {
      process.exit(code || 0);
    });

    return;
  }

  // 如果是卸载命令，执行卸载脚本并退出
  if (cliArgs.mode === 'uninstall') {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const uninstallScript = join(__dirname, 'uninstall-bin.js');

    const child = spawn(process.execPath, [uninstallScript, ...cliArgs.forwardedArgs], {
      stdio: 'inherit',
    });

    child.on('exit', code => {
      process.exit(code || 0);
    });

    return;
  }

  // 初始化日志文件
  writeFileSync(LOG_FILE, `=== Mearl MCP Server Started at ${new Date().toISOString()} ===\n`);

  log('Starting Mearl MCP Server...');

  log('MCP Server initialized, will connect to Chrome Extension when tools are called');

  // 创建 MCP Server
  const server = new Server(
    {
      name: 'mearl',
      version: MCP_SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        '取得 tabId 后持续显式复用，默认后台操作。首次进入或导航后取一次 browser_page_snapshot，按 viewport、局部根节点或 query 控制范围；AX 稀疏时才用 dom，每次快照只用本次新 ref。交互默认返回 { action, observation }，先检查 action.success 再核验业务效果；precondition 表示未派发，没有 observation/diagnostics；dispatch-uncertain 表示可能已生效，先检查 action.attempt 与可用观察或最小快照，避免直接重试。delta 优先复用 effects 中的 ref/selector，changed=true 且 effects 为空不表示失败；navigation 的 ready 表示就绪，openedTabs 已提供可操作 tabId。增量缺少下一步目标、ref 失效、需要新滚动视口或 fullSnapshotRecommended 提示时补最小快照，不固定追加 wait/snapshot/screenshot。布局和遮挡用 inspect，视觉任务用 screenshot，结构化工具无法表达时才用最小 page_eval。observe:false 且未开启 diagnostics 时返回裸动作结果，没有 action/observation；仅开启诊断时返回 { action, diagnostics }，诊断不等待 DOM/导航稳定。page_eval 默认返回 { result }。run_actions 只用于无需中间判断的紧密序列，步骤没有内置观察。按用户目标核验终态；browser_release 只在用户要求结束接管或清理会话时调用。',
    },
  );

  // 页面交互工具共享的 observe 参数 schema：默认开启内置观察，传 false 关闭
  const OBSERVE_INPUT_SCHEMA = {
    type: ['object', 'boolean'],
    default: {},
    description:
      '默认开启 DOM/相关请求/导航稳定观察，返回 { action, observation }。传 false 且未开启 diagnostics 时返回裸动作结果，没有 action/observation；开启 diagnostics 时返回 { action, diagnostics }。关闭观察不等待 DOM/导航稳定',
    properties: {
      quietMs: {
        type: 'number',
        description: '最后一次 DOM 变化后等待的稳定窗口，默认 100ms',
      },
      firstChangeTimeoutMs: {
        type: 'number',
        description: '没有发生 DOM 变化时最多等待多久，默认 500ms',
      },
      timeoutMs: {
        type: 'number',
        description: '整个观察阶段的最大时间，默认 3000ms',
      },
      navigationGraceMs: {
        type: 'number',
        description:
          '低信息量点击或按键后等待导航开始的基础宽限时间，默认 1000ms；若仍有网络活动会自动延长，有明确 effects 时不等待',
      },
      navigationTimeoutMs: {
        type: 'number',
        description: '导航开始后等待页面就绪的最大时间，默认 15000ms',
      },
      networkIdleMs: {
        type: 'number',
        description:
          '文档加载完成且相关 XHR/Fetch/Protocol 请求归零后继续保持静默的时间，默认 500ms，用于跳过业务骨架屏',
      },
      contentReadyAfterMs: {
        type: 'number',
        description:
          '动作开始后允许用结构稳定兜底的保护期，默认 min(5000, navigationTimeoutMs / 2)，并限制在导航超时之前；保护期内优先等待网络静默',
      },
    },
  };

  const DIAGNOSTICS_INPUT_SCHEMA = {
    type: ['object', 'boolean'],
    default: false,
    description:
      '默认关闭；true 返回动作期间新增 error logs/业务 requests，对象可自定义通道并显式开启 events。与 observe 独立；关闭观察时返回 { action, diagnostics }，precondition 失败省略 diagnostics',
    properties: {
      logs: {
        type: ['object', 'boolean'],
        properties: {
          level: { type: 'string', enum: ['log', 'warn', 'error', 'info', 'all'] },
          limit: { type: 'number', default: 100 },
          filter: { type: 'string' },
        },
      },
      requests: {
        type: ['object', 'boolean'],
        properties: {
          source: { type: 'string', enum: ['protocol', 'requests', 'all'] },
          count: { type: 'number', default: 100 },
          filter: { type: 'string' },
          includeBody: { type: 'boolean', default: false },
          includeHeaders: { type: 'boolean', default: false },
          maxBodySize: { type: 'number', description: '单个请求/响应体的最大字符数' },
          fields: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 100,
            description: '从响应体提取指定字段路径，如 data.list[0].id',
          },
          keysOnly: { type: 'boolean', description: '只返回数据结构，不返回叶子值' },
        },
      },
      events: {
        type: ['object', 'boolean'],
        properties: {
          source: { type: 'string', enum: ['rum', 'aplus', 'arms', 'all'] },
          event_type: { type: 'string' },
          filter: { type: 'string' },
          limit: { type: 'number', default: 100 },
          includeRaw: { type: 'boolean', default: false },
        },
      },
    },
  };

  // 定义工具列表
  const tools = defineMcpTools([
    {
      name: 'browser_control',
      description: '交给用户操作当前会话；用户在 Mearl 中交还后重新观察页面',
      inputSchema: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['handoff', 'resume'] },
          reason: { type: 'string' },
          tabId: { type: 'number' },
        },
        required: ['operation', 'session'],
      },
    },
    {
      name: 'browser_page_download',
      description: '先监听再点击并等待下载，outputPath 可将文件分块保存到 MCP 宿主',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number' },
          trigger: { type: 'object' },
          url: { type: 'string' },
          timeout: { type: 'number' },
          outputPath: { type: 'string' },
        },
        required: ['tabId', 'trigger'],
      },
    },

    {
      name: PLUGIN_INVOKE_TOOL_NAME,
      description:
        '调用当前 MCP Server 宿主上的 Mearl Skill 插件，对应 CLI 的 mearl <plugin>。已登记在能力目录中的缺失插件可按需安装。插件名、子命令、认证方式和 input 契约以对应 Skill 为准；Node 插件使用当前宿主环境，浏览器操作使用当前选择或显式指定的 Browser ID。',
      inputSchema: {
        type: 'object',
        properties: {
          plugin: {
            type: 'string',
            description: '已注册的插件名，或当前能力目录中可按需安装的插件名',
          },
          command: {
            type: 'string',
            description: '插件注册的子命令名',
          },
          input: {
            type: 'object',
            description: '传给插件 handler 的业务参数，省略时为空对象',
            additionalProperties: true,
          },
          browser: {
            type: 'string',
            description: '可选目标浏览器 ID 或名称；省略时继承 browser_select_browser 选择的目标',
          },
          timeoutSec: {
            type: 'number',
            description: '可选的浏览器底层调用超时秒数',
          },
        },
        required: ['plugin', 'command'],
      },
    },
    {
      name: 'browser_tab_checkpoint',
      description:
        '为目标标签页建立日志、请求和埋点的可靠增量边界，对应 mearl tab_checkpoint。返回的 cursor 可传给 browser_get_logs/browser_get_requests/browser_get_events 的 after。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID，从 browser_tab_open 或 browser_tab_list 获取',
          },
        },
        required: ['tabId'],
      },
    },
    {
      name: 'browser_get_requests',
      description:
        '获取指定标签页持续采集的 API 请求历史，包含请求、响应与 pending 状态。无需打开 DevTools panel；不传 after 时返回最新 N 条，传 after 时从最早未读项开始分页。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID，从 browser_tab_open 或 browser_tab_list 获取',
          },
          count: {
            type: 'number',
            description: '获取的请求数量，默认 10 个。最多可获取最近 1000 个请求',
            default: 10,
          },
          filter: {
            type: 'string',
            description:
              '过滤 API 名称的正则表达式（可选）。例如: ".*\\.cart\\..*" 只返回购物车相关接口',
          },
          since: {
            type: 'number',
            description: '从多久之前开始获取（秒）。例如: 60 表示获取最近 1 分钟内的请求',
          },
          after: {
            type: 'string',
            description: 'tab checkpoint 或上一次查询返回的 cursor，仅返回其后的请求',
          },
          includeBody: {
            type: 'boolean',
            description:
              '是否包含请求体和响应体。指定 fields 时默认 false，否则默认 true；可显式设为 true 同时读取全文。',
          },
          includeHeaders: {
            type: 'boolean',
            description:
              '是否包含请求头和响应头。false 时将省略 headers 和 responseHeaders 字段以减少数据量。默认 false',
            default: false,
          },
          maxBodySize: {
            type: 'number',
            description: '单个请求/响应体的最大字节数。超过此大小将被截断。默认 50000（约 50KB）',
            default: 50000,
          },
          fields: {
            type: 'array',
            items: {
              type: 'string',
            },
            description:
              '从响应体中提取指定字段，支持点号路径。例如: ["data.result.list", "data.total"] 只返回这些字段，大幅减少数据量',
          },
          keysOnly: {
            type: 'boolean',
            description:
              '只返回数据结构（字段路径和类型），不返回实际值。设为 true 可先预览数据结构，再决定提取哪些字段。默认 false',
            default: false,
          },
          source: {
            type: 'string',
            enum: ['protocol', 'requests', 'all'],
            description:
              '数据源。protocol: 已安装协议识别的请求; requests: 普通 XHR/Fetch 请求; all: 全部请求（默认）',
          },
        },
        required: ['tabId'],
      },
    },
    {
      name: 'browser_get_events',
      description:
        '获取目标标签页后台采集的 RUM/aplus/ARMS 埋点事件，无需打开 DevTools panel。不传 after 时返回最新事件，传 after 时按完整上报批次从最早未读项开始分页。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID，从 browser_tab_open 或 browser_tab_list 获取',
          },
          source: {
            type: 'string',
            enum: ['rum', 'aplus', 'arms', 'all'],
            description:
              '事件来源。rum: RUM 性能监控事件; aplus: aplus 埋点事件; arms: ARMS 前端监控事件; all: 全部（默认）',
            default: 'all',
          },
          event_type: {
            type: 'string',
            description: '事件类型正则过滤。例如: "view" 匹配页面 view 事件, "CLK" 匹配点击埋点',
          },
          filter: {
            type: 'string',
            description: '正则过滤，匹配事件的 name 或 url 字段',
          },
          since: {
            type: 'number',
            description: '从多久之前开始获取（秒）。例如: 60 表示获取最近 1 分钟内的事件',
          },
          after: {
            type: 'string',
            description: 'tab checkpoint 或上一次查询返回的 cursor，仅返回其后的埋点事件',
          },
          limit: {
            type: 'number',
            description: '返回条数上限，默认 20',
            default: 20,
          },
          includeRaw: {
            type: 'boolean',
            description:
              '是否返回完整 tracking URL、_raw 原始载荷和 _context 上下文；默认 false，仅返回解析后的精简字段',
            default: false,
          },
        },
        required: ['tabId'],
      },
    },
    {
      name: 'browser_get_logs',
      description:
        '获取指定标签页持续采集的 console API、未捕获异常和浏览器日志。无需打开 DevTools panel；不传 after 时返回最新 N 条，传 after 时从最早未读项开始分页。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID，从 browser_tab_open 或 browser_tab_list 获取',
          },
          level: {
            type: 'string',
            enum: ['log', 'warn', 'error', 'info', 'all'],
            description:
              '日志级别过滤。log: 普通日志, warn: 警告, error: 错误, info: 信息, all: 所有级别。默认 all',
            default: 'all',
          },
          since: {
            type: 'number',
            description: '从多久之前开始获取日志（秒）。例如: 60 表示获取最近 1 分钟内的日志',
          },
          after: {
            type: 'string',
            description: 'tab checkpoint 或上一次查询返回的 cursor，仅返回其后的日志',
          },
          limit: {
            type: 'number',
            description: '最大返回日志数量，默认 100；快照查询返回最新 N 条',
            default: 100,
          },
          filter: {
            type: 'string',
            description:
              '过滤日志内容的正则表达式或字符串（可选）。支持正则表达式模式（不区分大小写），若正则无效则回退到字符串包含匹配。例如: "error|warning" 匹配包含 error 或 warning 的日志',
          },
        },
        required: ['tabId'],
      },
    },
    {
      name: 'browser_set_mock',
      description:
        '动态设置 API 接口的 Mock 数据，用于测试不同数据场景。修改后，浏览器中对该接口的所有请求都会返回 Mock 数据。适用于前端开发测试、边界情况验证、UI 状态测试等。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID，从 browser_tab_open 或 browser_tab_list 获取',
          },
          apiName: {
            type: 'string',
            description:
              'API 名称或正则表达式模式。例如: "cart.query" 精确匹配, ".*\\.cart\\..*" 匹配所有购物车接口',
          },
          mockData: {
            type: ['object', 'string'],
            description:
              '【方式一】直接设置完整 Mock 响应数据（JSON 对象）。传入后该接口将完全返回此数据，不再请求真实服务端。示例: {"data":{"result":{"list":[]}},"ret":["SUCCESS"]}。注意：mockData 和 fields 二选一，同时提供时优先使用 fields。大体积响应体可传文件引用字符串 "@/abs/resp.json"（从该文件读取，建议绝对路径）以减少上下文占用',
          },
          fields: {
            type: 'array',
            description:
              '【方式二】基于真实响应修改指定字段。系统会先获取该接口的原始响应数据，然后按指定路径修改字段值。适合在真实数据基础上做微调',
            items: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description:
                    '字段路径，支持点号和数组索引。例如: "data.result.passengerList[0].name.text"',
                },
                value: {
                  description: '要设置的值，可以是任意类型（字符串、数字、对象、数组等）',
                },
              },
              required: ['path', 'value'],
            },
          },
          enabled: {
            type: 'boolean',
            description: '是否启用 Mock。true: 启用 Mock, false: 禁用 Mock 恢复真实数据。默认 true',
            default: true,
          },
          duration: {
            type: 'number',
            description:
              '完整响应时长（毫秒）。可选，mock 生效时的总耗时，绕过真实服务器精确控制（用于测试加载状态、超时等场景）',
          },
          conditions: {
            type: 'object',
            additionalProperties: true,
            description:
              '请求 query/body 字段的子集匹配规则；保留字段 $index 从 0 开始指定同一场景的调用顺序。相同 $index 再次设置会原地覆盖，超过最后一项后持续使用最后一项',
          },
          payloadFile: {
            type: 'string',
            description:
              '从文件读取 mock 数据（JSON 格式）。当 mockData 很大时，可将完整 JSON 写入文件，通过此参数指定文件路径。文件内容会被解析为 mockData。注意：此参数与 mockData/fields 互斥，优先级最高',
          },
        },
        required: ['tabId', 'apiName'],
      },
    },
    {
      name: 'browser_get_mocks',
      description:
        '查看当前所有已设置的 Mock 配置，包括接口名称、是否启用、以及 Mock 数据内容。用于排查 Mock 是否生效、Mock 数据是否正确等问题。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID，从 browser_tab_open 或 browser_tab_list 获取',
          },
          apiName: {
            type: 'string',
            description:
              '过滤指定接口，支持正则表达式。例如: "cart.query" 或 ".*\\.cart\\..*"。不传则返回所有 Mock',
          },
        },
        required: ['tabId'],
      },
    },
    {
      name: 'browser_send_request',
      description:
        '通过浏览器发起 HTTP 代理请求，自动携带目标域名的 Cookie（使用当前浏览器登录态）。支持 GET/POST/PUT/DELETE/PATCH、multipart 文本字段和本地文件上传，适用于需要用户登录态的接口调试、数据爬取、接口测试等场景。',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '目标请求 URL，必须是完整 URL（含 http:// 或 https://）',
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
            description: 'HTTP 请求方法，默认 GET',
            default: 'GET',
          },
          headers: {
            type: 'object',
            description: '自定义请求头（键值对），会与自动生成的 Cookie 头合并',
            additionalProperties: { type: 'string' },
          },
          params: {
            type: 'object',
            description: 'URL 查询参数（键值对），会追加到 URL 中',
            additionalProperties: { type: 'string' },
          },
          body: {
            description:
              '请求体。传入对象时自动序列化为 JSON 并设置 Content-Type: application/json；传入字符串时原样发送',
          },
          formData: {
            type: 'object',
            description:
              'multipart/form-data 文本字段。字段值支持 string、number、boolean；不能与 body 同时使用',
            additionalProperties: {
              anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
            },
          },
          files: {
            type: 'array',
            description:
              'multipart 文件列表，最多 20 个且总计不超过 40 MiB。本地调用优先传绝对 filePath；远程调用可传 base64，并同时提供 filename，Base64 文件内容总计不超过 7 MiB',
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                fieldName: {
                  type: 'string',
                  description: 'multipart 字段名，例如 file',
                },
                filePath: {
                  type: 'string',
                  description: 'Mearl native-host 所在机器上的绝对文件路径',
                },
                base64: {
                  type: 'string',
                  description: '文件内容的 Base64；与 filePath 二选一',
                },
                filename: {
                  type: 'string',
                  description: '上传文件名；使用 base64 时必填',
                },
                contentType: {
                  type: 'string',
                  description: '文件 MIME 类型；默认根据文件名推断',
                },
              },
              required: ['fieldName'],
              oneOf: [{ required: ['filePath'] }, { required: ['base64', 'filename'] }],
            },
          },
          withCookies: {
            type: 'boolean',
            description: '是否自动携带浏览器中该域名的 Cookie，默认 true',
            default: true,
          },
          responseType: {
            type: 'string',
            enum: ['json', 'text', 'auto'],
            description:
              '响应格式。auto: 自动检测（默认）; json: 强制解析为 JSON; text: 返回原始文本。注意：auto 模式下若 Content-Type 为图片/音视频/PDF/压缩包等二进制类型，body 将以 base64 字符串返回，bodyType 为 "base64"',
            default: 'auto',
          },
          timeout: {
            type: 'number',
            description: '请求超时时间（毫秒），默认 30000（30 秒）',
            default: 30000,
          },
        },
        required: ['url'],
      },
    },
    {
      name: 'browser_set_rule',
      description:
        '添加或删除浏览器请求规则。enabled=false 且传 ruleId 时彻底删除规则；否则添加规则。扩展模式持久保存规则，CDP 模式的规则仅在当前控制会话生效。',
      inputSchema: {
        type: 'object',
        properties: {
          ruleId: {
            type: 'integer',
            minimum: 1,
            description: '删除时必填：从 browser_get_rules 获取的规则 ID',
          },
          enabled: {
            type: 'boolean',
            description: '省略时添加规则；false 时删除 ruleId 对应的规则',
          },
          actionType: {
            type: 'string',
            enum: ['redirect', 'block', 'allow', 'upgradeScheme', 'modifyHeaders'],
            description:
              '规则类型。redirect: 重定向请求到另一地址; block: 阻止请求; allow: 允许请求; upgradeScheme: 升级到 HTTPS; modifyHeaders: 修改请求/响应头',
          },
          filter: {
            type: 'string',
            description:
              'URL 匹配规则（正则表达式）。例如: "^https://h5api\\.m\\.shop\\.com/.*" 匹配所有商城 h5api 请求',
          },
          redirectUrl: {
            type: 'string',
            description:
              '【redirect 类型必填】重定向目标 URL。支持正则替换占位符 \\1 \\2 等（引用 filter 中的捕获组）',
          },
          requestHeaders: {
            type: 'array',
            description: '【modifyHeaders 类型】要修改的请求头列表',
            items: {
              type: 'object',
              properties: {
                header: { type: 'string', description: '请求头名称，如 "x-custom-header"' },
                operation: {
                  type: 'string',
                  enum: ['set', 'append', 'remove'],
                  description: 'set: 设置/覆盖; append: 追加; remove: 删除',
                },
                value: { type: 'string', description: '请求头值（remove 时可省略）' },
              },
              required: ['header', 'operation'],
            },
          },
          responseHeaders: {
            type: 'array',
            description: '【modifyHeaders 类型】要修改的响应头列表',
            items: {
              type: 'object',
              properties: {
                header: { type: 'string', description: '响应头名称' },
                operation: {
                  type: 'string',
                  enum: ['set', 'append', 'remove'],
                  description: 'set: 设置/覆盖; append: 追加; remove: 删除',
                },
                value: { type: 'string', description: '响应头值（remove 时可省略）' },
              },
              required: ['header', 'operation'],
            },
          },
          initiatorDomains: {
            type: 'string',
            description:
              '发起请求的域名限制（逗号分隔）。只有从这些域名发起的请求才会匹配此规则。例如: "shop.com,tmall.com"',
          },
          resourceTypes: {
            type: 'array',
            description: '资源类型限制；不填时使用当前浏览器模式的默认值',
            items: {
              type: 'string',
              enum: [
                'main_frame',
                'sub_frame',
                'script',
                'stylesheet',
                'image',
                'xmlhttprequest',
                'websocket',
                'other',
              ],
            },
          },
          priority: {
            type: 'number',
            description:
              '规则优先级，数字越大优先级越高。多个规则匹配同一请求时，优先级高的生效。默认 1',
            default: 1,
          },
          description: {
            type: 'string',
            description: '规则描述，便于识别规则用途',
          },
        },
        oneOf: [
          {
            required: ['actionType', 'filter'],
            not: { required: ['ruleId'] },
            properties: { enabled: { const: true } },
          },
          { required: ['ruleId', 'enabled'], properties: { enabled: { const: false } } },
        ],
      },
    },
    {
      name: 'browser_get_rules',
      description:
        '查看当前浏览器模式的请求规则。扩展模式包含 Options 面板配置的持久规则；CDP 模式返回当前控制会话的请求头规则。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'browser_page_screenshot',
      description:
        '获取指定浏览器标签页的视觉截图，以 Base64 编码返回。支持全页截图或指定 CSS 选择器截取单个元素（类似 DevTools "Capture node screenshot"）。适用于视觉判断、Canvas、跨域 iframe、UI 排查和保存快照；常规页面动作后优先读取其内置观察的增量结果，不要固定在每次动作后截图。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID（从 browser_tab_open 或 browser_tab_list 获取）',
          },
          selector: {
            type: 'string',
            description:
              'CSS 选择器。提供后只截取该元素区域（会自动滚动元素到可见区域），不提供则截取整个页面',
          },
          format: {
            type: 'string',
            enum: ['png', 'jpeg'],
            description:
              '截图格式。png: PNG 格式（无损，默认）; jpeg: JPEG 格式（有损压缩，体积更小）',
            default: 'png',
          },
          quality: {
            type: 'number',
            description:
              'JPEG 质量（仅 format 为 jpeg 时有效）。范围 0-100，默认 80。数值越高质量越好但文件越大',
            default: 80,
          },
        },
        required: ['tabId'],
      },
    },
    {
      name: 'browser_launch',
      description:
        '启动浏览器实例。默认使用本地独立 Chrome；传已注册的 Provider ID 时，把该 Provider 声明的创建参数放在 providerOptions。配对实例会直接返回 pairing URL。具体 Provider 用法可运行 mearl <providerId> 查看。',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '本地实例名称；使用默认 local Provider 时必填',
          },
          provider: {
            type: 'string',
            description: '浏览器提供方，默认 local；也可传已注册的外部 Provider ID',
          },
          providerOptions: {
            type: 'object',
            additionalProperties: true,
            description: '所选外部 Provider 声明的结构化创建参数',
          },
          headless: {
            type: 'boolean',
            description: '本地 Provider 是否使用 headless=new，默认 true',
          },
          userAgentMode: {
            type: 'string',
            enum: ['default', 'desktop'],
            description: '本地 UA 模式：default 使用默认 UA；desktop 使用匹配本机 Chrome 的 UA',
            default: 'default',
          },
          persistent: {
            type: 'boolean',
            description: '本地实例关闭后是否保留独立 Profile，默认 false',
            default: false,
          },
          url: {
            type: 'string',
            description: '新浏览器打开的初始 URL',
          },
          executablePath: {
            type: 'string',
            description: 'Chrome 可执行文件路径；省略时自动发现，也可用环境变量配置',
          },
          copyCookieDomains: {
            oneOf: [
              { type: 'array', items: { type: 'string' } },
              { type: 'string', minLength: 1 },
              { type: 'object', properties: { presets: { type: 'array', items: { type: 'string', minLength: 1 } }, domains: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
            ],
            description:
              '从控制浏览器复制 Cookie，可传域名数组、已安装能力提供的范围名称，或 {presets, domains} 组合。保留 HttpOnly/Secure/SameSite/过期时间等属性；所需域名权限仍由宿主管理。',
          },
        },
        anyOf: [{ required: ['name'] }, { required: ['provider'] }],
      },
    },
    {
      name: 'browser_close',
      description:
        '关闭一个 Provider 托管浏览器；持久化数据默认按 Provider 策略保留，deleteProfile=true 时一并删除。名称有歧义时使用完整 browserId。',
      inputSchema: {
        type: 'object',
        properties: {
          browser: {
            type: 'string',
            description: 'browser_launch 返回的 browserId 或实例名称',
          },
          deleteProfile: {
            type: 'boolean',
            description: '是否强制删除 Provider 持久化数据，默认 false',
            default: false,
          },
        },
        required: ['browser'],
      },
    },
    {
      name: 'browser_release',
      description:
        '仅在用户明确要求结束调试、退出接管或清理会话资源时调用，不作为普通任务收尾。它会释放 debugger/CDP 控制和会话级临时效果，后续浏览器操作可自动重新建立控制；Provider 实例的生命周期操作由 Browser Manager 处理。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'browser_tab_open',
      description:
        '打开或按 URL 规则复用标签页。默认新建并等待加载完成；reuse=prefer 可优先复用，reuse=require 可限制为只复用。响应的 opened/reused 可用于判断流程结束时是否应关闭该 Tab。',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '要打开的页面 URL',
          },
          active: {
            type: 'boolean',
            description:
              '是否激活目标标签页。默认 false；扩展免打扰默认开启，使用后台焦点模拟，关闭后才切换前台。activation.mode 区分 background/foreground，visibilityState 不代表窗口在前台',
            default: false,
          },
          openerTabId: {
            type: 'number',
            description:
              '来源标签页 ID。侧边栏对话继续任务时传入，用于把新开或复用的标签页关联到同一对话',
          },
          closeExisting: {
            type: 'boolean',
            description: '打开前是否先关闭 Agent 受控的已有标签页。默认 false',
            default: false,
          },
          group: {
            type: 'string',
            description:
              '把新标签页加入指定标题的标签页分组（同窗口同名分组存在则加入，否则新建）。仅扩展模式支持，CDP 模式忽略',
          },
          reuse: {
            type: 'string',
            enum: ['never', 'prefer', 'require'],
            description:
              'never 始终新建；prefer 匹配到则复用、否则新建；require 只允许复用。默认 never',
            default: 'never',
          },
          match: {
            type: 'object',
            description: '复用标签页时的 URL 匹配规则',
            properties: {
              urlPattern: {
                type: 'string',
                description: '支持 * 的完整 URL glob；省略时精确匹配 url',
              },
              ignoreSearch: {
                type: 'boolean',
                description: '匹配时是否忽略 URL query，默认 false',
              },
              ignoreHash: {
                type: 'boolean',
                description: '匹配时是否忽略 URL hash，默认 false',
              },
              onMultiple: {
                type: 'string',
                enum: ['error', 'first'],
                description: '匹配多个 Tab 时默认报错；first 显式取第一个',
              },
            },
          },
          restoreFocusOnClose: {
            type: 'boolean',
            description: '新建 active Tab 关闭后是否恢复原活动标签页，默认 false',
            default: false,
          },
          emulation: {
            type: 'object',
            description:
              '开 tab 即进入移动端模拟态，等价于随后立即调用 browser_set_device_emulation，但在导航前生效。deviceShell=true 时首屏显示系统栏和底部操作区。字段规则一致（无 enabled/reload）。',
            properties: {
              preset: {
                type: 'string',
                enum: [...BROWSER_DEVICE_PRESET_NAMES],
                description:
                  '内置设备预设，一键提供 viewport/DPR/UA。当前机型在前，旧机型 ID 继续兼容；可与下面字段组合，显式字段覆盖预设值',
              },
              width: { type: 'number', description: '视口宽度（覆盖 preset）' },
              height: { type: 'number', description: '视口高度（覆盖 preset）' },
              deviceScaleFactor: { type: 'number', description: 'devicePixelRatio（覆盖 preset）' },
              scale: {
                type: 'number',
                exclusiveMinimum: 0,
                description:
                  '画面视觉比例，不改变视口 CSS 尺寸或 devicePixelRatio；必须为有限正数，默认 1',
              },
              mobile: {
                type: 'boolean',
                description: '是否启用移动渲染模式。默认从 preset 推断，无 preset 默认 true',
              },
              userAgent: {
                type: 'string',
                description: '自定义 User-Agent（覆盖 preset）。无 preset 时必填',
              },
              orientation: {
                type: 'string',
                enum: ['portrait', 'landscape'],
                description: '横竖屏，landscape 会对调宽高。默认 portrait',
              },
              touch: {
                type: 'boolean',
                description:
                  '是否启用触摸事件并把鼠标事件转成 touch。默认从 preset 推断；无 preset 时跟随 mobile',
              },
              deviceShell: {
                type: 'boolean',
                description: '是否使用 iframe WebView 并渲染顶部状态栏与底部操作区，默认 false',
              },
              splitScreen: {
                type: 'boolean',
                description:
                  '是否在横屏时将首页与业务页分置左右 WebView；仅与 appProfile、deviceShell=true、orientation=landscape 同时生效，默认 false',
              },
            },
          },
          appProfile: {
            type: 'string',
            description:
              '开 tab 即注入 App 客户端环境与 JSBridge（等价于随后调用 browser_set_app_profile，但在首次导航前生效）。不创建根 iframe；需要系统栏时同时传 emulation.deviceShell=true',
          },
          os: {
            type: 'string',
            enum: ['ios', 'android'],
            description: '与 appProfile 配合；容器系统，默认 ios',
          },
          bridgeConfig: {
            type: 'object',
            description:
              '与 appProfile 配合；声明式覆盖桥方法，形如 {methods:{api:{behavior|response|noop,silent?}}}，不执行配置脚本',
          },
        },
        required: ['url'],
      },
    },
    {
      name: 'browser_tab_close',
      description: '关闭指定的浏览器标签页。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '要关闭的标签页 ID（从 tab_open 或 tab_list 获取）',
          },
        },
        required: ['tabId'],
      },
    },
    {
      name: 'browser_get_capabilities',
      description: '只读查询当前目标浏览器的已安装 App、动作、设备预设、限制与 Skill/帮助入口。app 可指定目录中的完整 ID，按需获取桥方法与设置详情；不打开页面或启用模拟。支持 action 不代表已取得页面权限或真实授权。',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: { app: { type: 'string', description: '可选，查询已安装 App ID 的详细能力' }, browser: { type: 'string', description: '目标浏览器 ID 或唯一名称；省略沿用当前选择' } },
      },
    },
    {
      name: 'browser_tab_list',
      description: '列出当前浏览器窗口中所有标签页的信息，包括 ID、URL、标题和是否活动。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'browser_tab_group',
      description: '将同一窗口中的标签页加入分组，或取消分组并保留标签页。仅扩展模式支持。',
      inputSchema: {
        type: 'object',
        properties: {
          tabIds: {
            type: 'array',
            items: { type: 'number' },
            description: '标签页 ID 列表，分组最多 100 个，取消分组最多 1000 个',
          },
          title: { type: 'string', description: '分组标题；取消分组时省略' },
          ungroup: { type: 'boolean', description: '为 true 时取消分组并保留标签页' },
        },
        required: ['tabIds'],
      },
    },
    {
      name: 'browser_page_click',
      description: '点击页面元素；selector、text、point 三种定位方式必须且只能提供一种。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID（从 browser_tab_open 或 browser_tab_list 获取）',
          },
          selector: {
            type: 'string',
            description:
              '原生 CSS 选择器（如 "[aria-label=\'提交\']"、"#login-btn"）或 page_snapshot / 页面动作 observation 返回的 ref（如 "@e3"，必须带 "@" 前缀）。注意字段名是 "selector" 而非 "ref"。不支持 :has-text/:visible 等 Playwright 扩展语法。与 text/point 互斥。',
          },
          text: {
            type: 'string',
            description:
              '按可见文本（accessibility name）定位。例如 "退款明细"。匹配到多个时会报错并列出候选——可加 role 或 exact:true 收敛，或用 page_snapshot 拿 @ref。与 selector/point 互斥。',
          },
          point: {
            type: 'object',
            description:
              '按视口坐标点击（CSS 像素，左上角为原点）。selector 和 text 都不适用时使用。与 selector/text 互斥。',
            properties: {
              x: { type: 'number', description: '横坐标（CSS 像素）' },
              y: { type: 'number', description: '纵坐标（CSS 像素）' },
            },
            required: ['x', 'y'],
          },
          frameId: {
            type: 'string',
            description:
              '仅扩展后端：CSS/text 查询或 active-frame 坐标所属的 frame；省略时容器使用当前业务 frame',
          },
          coordinateSpace: {
            type: 'string',
            enum: ['outer-viewport', 'active-frame'],
            description:
              '仅配合 point；扩展的手机壳预览默认 active-frame，其他页面默认 outer-viewport。active-frame 会换算 iframe 偏移与缩放',
          },
          role: {
            type: 'string',
            description:
              '配合 text 使用，按 AX role 过滤消歧（如 "button"、"link"、"heading"、"StaticText"）',
          },
          exact: {
            type: 'boolean',
            description: '配合 text 使用，默认 true 精确匹配；false 时按子串匹配',
            default: true,
          },
          scope: {
            type: 'string',
            description:
              '配合 text 使用，把 AX 文本匹配限制在指定 CSS 元素或 snapshot ref（如 "@e12"）子树内',
          },
          clickMode: {
            type: 'string',
            enum: ['auto', 'dom', 'mouse', 'touch'],
            description:
              '默认 auto：可见页使用匹配设备的可信输入，隐藏页使用 DOM；dom/mouse/touch 可强制指定派发方式',
            default: 'auto',
          },
          observe: OBSERVE_INPUT_SCHEMA,
          diagnostics: DIAGNOSTICS_INPUT_SCHEMA,
        },
        required: ['tabId'],
      },
    },
    {
      name: 'browser_page_drag',
      description: '连续拖动页面元素或视口坐标，适用于轮播图、滑块、Canvas 手势和拖放。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID（从 browser_tab_open 或 browser_tab_list 获取）',
          },
          from: {
            description: '拖动起点：CSS/@eN selector，或 {x,y} 视口坐标（CSS 像素）',
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: { x: { type: 'number' }, y: { type: 'number' } },
                required: ['x', 'y'],
              },
            ],
          },
          to: {
            description: '拖动终点：CSS/@eN selector，或 {x,y} 视口坐标（CSS 像素）',
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: { x: { type: 'number' }, y: { type: 'number' } },
                required: ['x', 'y'],
              },
            ],
          },
          dragMode: {
            type: 'string',
            enum: ['auto', 'dom', 'mouse', 'touch'],
            description:
              '默认 auto：可见页使用匹配设备的可信输入，隐藏页使用 DOM；dom/mouse/touch 可强制指定派发方式',
            default: 'auto',
          },
          durationMs: {
            type: 'number',
            minimum: 0,
            maximum: 5000,
            description: '拖动持续时间（毫秒），默认 400；内部自动分段移动',
            default: 400,
          },
          observe: OBSERVE_INPUT_SCHEMA,
          diagnostics: DIAGNOSTICS_INPUT_SCHEMA,
        },
        required: ['tabId', 'from', 'to'],
      },
    },
    {
      name: 'browser_page_type',
      description: '向输入框填写文本，兼容 React 等框架的受控组件。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID（从 browser_tab_open 或 browser_tab_list 获取）',
          },
          selector: {
            type: 'string',
            description:
              '原生 CSS 选择器，或 page_snapshot / 页面动作 observation 返回的 ref（如 "@e6"，必须带 "@" 前缀）。字段名是 "selector"。不支持 :has-text/:visible 等 Playwright 扩展。',
          },
          text: {
            type: 'string',
            description: '要输入的文本内容',
          },
          clearFirst: {
            type: 'boolean',
            description: '是否先清空输入框原有内容。默认 true',
            default: true,
          },
          observe: OBSERVE_INPUT_SCHEMA,
          diagnostics: DIAGNOSTICS_INPUT_SCHEMA,
        },
        required: ['tabId', 'selector', 'text'],
      },
    },
    {
      name: 'browser_page_scroll',
      description:
        '按方向滚动页面或指定容器；页面根不可滚动时自动发现活动滚动区，containerPolicy="nearest" 可从子节点解析最近的可滚动祖先。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID（从 browser_tab_open 或 browser_tab_list 获取）',
          },
          direction: {
            type: 'string',
            enum: ['up', 'down', 'top', 'bottom'],
            description: '滚动方向',
          },
          distance: {
            type: 'number',
            description: '滚动距离（像素），仅 up/down 方向有效。默认 600',
            default: 600,
          },
          selector: {
            type: 'string',
            description:
              '目标滚动容器的原生 CSS 选择器，或 page_snapshot / 页面动作 observation 返回的 ref（如 "@e6"，必须带 "@" 前缀）；不传时滚动页面。',
          },
          containerPolicy: {
            type: 'string',
            enum: ['self', 'nearest'],
            description:
              '默认 self，要求 selector 本身可滚动；nearest 会在其不可滚动时使用最近的可滚动祖先',
          },
          observe: OBSERVE_INPUT_SCHEMA,
          diagnostics: DIAGNOSTICS_INPUT_SCHEMA,
        },
        required: ['tabId', 'direction'],
      },
    },
    {
      name: 'browser_page_hover',
      description: '将鼠标悬停在页面元素上。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID（从 browser_tab_open 或 browser_tab_list 获取）',
          },
          selector: {
            type: 'string',
            description:
              '原生 CSS 选择器，或 page_snapshot / 页面动作 observation 返回的 ref（如 "@e1"，必须带 "@" 前缀）。字段名是 "selector"。不支持 :has-text/:visible 等 Playwright 扩展。',
          },
          observe: OBSERVE_INPUT_SCHEMA,
          diagnostics: DIAGNOSTICS_INPUT_SCHEMA,
        },
        required: ['tabId', 'selector'],
      },
    },
    {
      name: 'browser_page_eval',
      description:
        '在页面默认上下文执行最小 JavaScript 表达式，作为结构化工具无法表达时的补充。默认返回 { result }；observe 对象启用观察并返回 { action, observation }；仅开启 diagnostics 时返回 { action, diagnostics }，diagnostics=false 不启用包装。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID（从 browser_tab_open 或 browser_tab_list 获取）',
          },
          expression: {
            type: 'string',
            description: '要执行的 JavaScript 表达式',
          },
          frameId: {
            type: 'string',
            description:
              'browser_page_frames 返回的目标 frame ID，扩展/CDP 均支持；省略时容器/设备外壳使用当前业务 frame，普通页面使用主 frame。读取外层容器时显式传主 frame ID',
          },
          awaitPromise: {
            type: 'boolean',
            description: '是否等待表达式返回的 Promise，默认 true',
            default: true,
          },
          observe: {
            type: 'object',
            properties: OBSERVE_INPUT_SCHEMA.properties,
            description:
              '仅在表达式会修改页面且需要观察结果时显式传入；不传时轻量执行并直接返回结果',
          },
          diagnostics: DIAGNOSTICS_INPUT_SCHEMA,
        },
        required: ['tabId', 'expression'],
      },
    },
    {
      name: 'browser_page_inspect',
      description:
        '查询 DOM 元素的原生/ARIA 控件状态、数量、边框盒、计算样式、命中遮挡、溢出尺寸和最近滚动容器；也可读取 DevTools 当前选区或直接扫描全页。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID（从 browser_tab_open 或 browser_tab_list 获取）',
          },
          selector: {
            type: 'string',
            description:
              '原生 CSS、page_snapshot 返回的 ref（如 "@e8"），或 DevTools Elements 当前选区 "$0"；全页溢出诊断时可省略',
          },
          filter: {
            type: 'string',
            enum: ['all', 'overflowing', 'horizontal-overflow', 'vertical-overflow', 'scrollable'],
            description: '结果过滤；省略 selector 时必须指定非 all 的过滤条件',
          },
          styles: {
            type: 'array',
            items: { type: 'string' },
            description:
              '要返回的计算样式属性；默认 display/position/box-sizing/overflow-x/overflow-y',
          },
          maxResults: {
            type: 'number',
            minimum: 1,
            maximum: 100,
            description: '最多返回的明细数，默认 20；未触发 scanTruncated 时 count 为完整命中数',
          },
          includeOuterHTML: {
            type: 'boolean',
            description: '是否返回 outerHTML（最多 3000 字符）；$0 默认 true，其他目标默认 false',
          },
        },
        required: ['tabId'],
      },
    },
    {
      name: 'browser_page_snapshot',
      description:
        '获取带 @ref 的页面结构树；ref 可直接用于操作，内部节点映射不输出。默认使用无障碍树，AX 信息缺失时可显式读取渲染 DOM。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID（从 browser_tab_open 或 browser_tab_list 获取）',
          },
          depth: {
            type: 'number',
            description: '无障碍树的最大深度。默认 15，增大可获取更深层元素',
            default: 15,
          },
          mode: {
            type: 'string',
            enum: ['full', 'interactive', 'viewport', 'dom'],
            description:
              'full 为完整 AX 树；interactive 只保留当前视口内的 AX 语义控件，无控件时回退到 AX viewport；viewport 为当前可视 AX 树；dom 显式返回实际渲染文本、原生控件、显式 role 和高置信 clickable 节点。默认 full',
          },
          rootSelector: {
            type: 'string',
            description: '只获取指定 CSS 元素的局部子树，可与 mode 组合；与 rootRef 互斥',
          },
          rootRef: {
            type: 'string',
            description: '以已有 snapshot ref（如 "@e8"）为根获取局部子树',
          },
          ancestorDepth: {
            type: 'number',
            description: 'rootRef 向上扩展的 DOM 祖先层数，默认 0，最大 20',
            minimum: 0,
            maximum: 20,
          },
          query: {
            type: 'object',
            description: '服务端按 name / role 过滤当前模式的树，只保留命中节点及祖先路径',
            properties: {
              text: {
                type: 'string',
                description: '要匹配的 accessibility name',
              },
              role: {
                type: 'string',
                description: '要匹配的 AX role',
              },
              exact: {
                type: 'boolean',
                description: 'text 默认精确匹配；false 时按子串匹配',
              },
            },
          },
          maxNodes: {
            type: 'number',
            description: '最多输出节点数；超出时保留首尾。0 表示不限制',
          },
          maxChars: {
            type: 'number',
            description: '最多输出字符数，默认 60000；超出时保留首尾。0 表示不限制',
          },
        },
        required: ['tabId'],
      },
    },
    {
      name: 'browser_page_press',
      description: '在页面中按下键盘按键或组合键。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID（从 browser_tab_open 或 browser_tab_list 获取）',
          },
          key: {
            type: 'string',
            description:
              '按键名称。支持：Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, Space',
          },
          dialogId: { type: 'string', description: 'page_snapshot 或中断回执中的 dialog.id；仅配合 Enter 接受或 Escape 取消原生弹窗，不自动重放旧动作。' },
          promptText: { type: 'string', description: '仅用于 dialogId + Enter 接受原生 prompt 时填写文本。' },
          modifiers: {
            type: 'array',
            items: { type: 'string' },
            description: '修饰键数组，如 ["Alt", "Shift", "Control", "Meta"]',
          },
          pressMode: {
            type: 'string',
            enum: ['auto', 'dom', 'keyboard'],
            description: '派发模式；auto 默认在隐藏页降级为 DOM 键盘事件',
          },
          observe: OBSERVE_INPUT_SCHEMA,
          diagnostics: DIAGNOSTICS_INPUT_SCHEMA,
        },
        required: ['tabId', 'key'],
      },
    },
    {
      name: 'browser_page_wait',
      description:
        '独立等待接口：仅用于没有前置动作时等待指定时间、已知 selector 状态、可见文本或页面 condition。四种模式必须且只能提供一个；点击、输入后的异步稳定判断由页面交互工具内置的观察完成。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID（从 browser_tab_open 或 browser_tab_list 获取）',
          },
          time: {
            type: 'number',
            description: '固定等待毫秒数，与 selector/text/condition 四选一',
          },
          selector: {
            type: 'string',
            description: 'CSS 选择器，与 time/text/condition 四选一',
          },
          state: {
            type: 'string',
            enum: ['attached', 'detached', 'visible', 'hidden'],
            description: 'selector 的目标状态，默认 attached',
            default: 'attached',
          },
          text: {
            type: 'string',
            description: '等待页面出现的可见文本，与 time/selector/condition 四选一',
          },
          exact: {
            type: 'boolean',
            description: 'text 是否精确匹配，默认 false',
            default: false,
          },
          condition: {
            type: 'string',
            description:
              '在页面主上下文轮询的 JavaScript 表达式，返回 truthy 时结束，支持 Promise；与 time/selector/text 四选一',
          },
          timeout: {
            type: 'number',
            description: '等待超时时间（毫秒），默认 10000ms',
            default: 10000,
          },
          interval: {
            type: 'number',
            description: 'selector/condition 的轮询间隔（毫秒），默认 200ms',
            default: 200,
          },
        },
        required: ['tabId'],
      },
    },
    {
      name: 'browser_page_navigate',
      description:
        '在指定标签页中导航到 URL、设置 refresh:true 重新加载，或用 history:"back"|"forward" 沿浏览历史移动。三种模式互斥，返回最终 URL 和标题。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID（从 browser_tab_open 或 browser_tab_list 获取）',
          },
          url: {
            type: 'string',
            description: '要导航到的 URL；与 refresh/history 互斥',
          },
          refresh: {
            type: 'boolean',
            description: '为 true 时直接重新加载当前页面；与 url/history 互斥',
            default: false,
          },
          history: {
            type: 'string',
            enum: ['back', 'forward'],
            description: '沿当前标签页浏览历史后退或前进；与 url/refresh 互斥',
          },
        },
        required: ['tabId'],
      },
    },
    {
      name: 'browser_page_upload',
      description: '向 <input type="file"> 元素上传一个或多个本地文件。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID（从 browser_tab_open 或 browser_tab_list 获取）',
          },
          selector: {
            type: 'string',
            description:
              '原生 CSS 选择器，或 page_snapshot / 页面动作 observation 返回的 ref（如 "@e5"，必须带 "@" 前缀），用于定位 <input type="file"> 元素。字段名是 "selector"。',
          },
          filePaths: {
            type: 'array',
            items: { type: 'string' },
            description: '要上传的本地文件路径数组，如 ["/Users/me/photo.jpg"]',
          },
          observe: OBSERVE_INPUT_SCHEMA,
          diagnostics: DIAGNOSTICS_INPUT_SCHEMA,
        },
        required: ['tabId', 'selector', 'filePaths'],
      },
    },
    {
      name: 'browser_page_frames',
      description: '列出主 frame 和 iframe，返回可供 browser_page_eval 使用的 frameId。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID（从 browser_tab_open 或 browser_tab_list 获取）',
          },
        },
        required: ['tabId'],
      },
    },
    {
      name: 'browser_set_device_emulation',
      description:
        '把目标标签页切换为移动端模拟态：视口尺寸 / DPR / UA / 触摸事件按指定设备生效，并可独立调整视觉比例。deviceShell=true 时把业务页放入 iframe WebView，并在外层渲染顶部状态栏与底部操作区；false/省略时保持纯 CDP 模拟。作用域仅限该 tab，启用后默认 reload，enabled=false 清除模拟与系统栏。',
      inputSchema: {
        type: 'object',
        properties: {
          enabled: {
            type: 'boolean',
            description: '必填。true=启用模拟（按 preset/参数生效），false=清除模拟回到桌面态',
          },
          preset: {
            type: 'string',
            enum: [...BROWSER_DEVICE_PRESET_NAMES],
            description:
              '内置设备预设，一键提供 viewport/DPR/UA。当前机型在前，旧机型 ID 继续兼容；可与下面的字段组合，显式字段会覆盖预设值',
          },
          width: { type: 'number', description: '视口宽度（覆盖 preset）' },
          height: { type: 'number', description: '视口高度（覆盖 preset）' },
          deviceScaleFactor: { type: 'number', description: 'devicePixelRatio（覆盖 preset）' },
          scale: {
            type: 'number',
            exclusiveMinimum: 0,
            description:
              '画面视觉比例，不改变视口 CSS 尺寸或 devicePixelRatio；必须为有限正数，默认 1',
          },
          mobile: {
            type: 'boolean',
            description:
              '是否启用移动渲染模式（影响 hover/pointer media query、viewport meta 行为）。默认从 preset 推断，无 preset 默认 true',
          },
          userAgent: { type: 'string', description: '自定义 User-Agent（覆盖 preset）' },
          orientation: {
            type: 'string',
            enum: ['portrait', 'landscape'],
            description: '横竖屏，landscape 会对调宽高。默认 portrait',
          },
          touch: {
            type: 'boolean',
            description:
              '是否启用触摸事件并把鼠标事件转成 touch。默认从 preset 推断；无 preset 时跟随 mobile',
          },
          deviceShell: {
            type: 'boolean',
            description: '是否使用 iframe WebView 并渲染顶部状态栏与底部操作区，默认 false',
          },
          splitScreen: {
            type: 'boolean',
            description:
              '是否在横屏 App 容器中将首页与业务页分置左右 WebView；仅在当前已启用端模拟、deviceShell=true、orientation=landscape 时生效，默认 false',
          },
          reload: {
            type: 'boolean',
            description:
              '启用模拟后是否重载页面（让 JS 读到新的 navigator.userAgent / window.innerWidth）。默认 true',
          },
          tabId: {
            type: 'number',
            description: '目标标签页 ID（从 browser_tab_open 或 browser_tab_list 获取）',
          },
        },
        required: ['tabId', 'enabled'],
      },
    },
    {
      name: 'browser_set_app_profile',
      description:
        '设置目标标签页的端模拟；可用 App ID、限制和说明通过 browser_get_capabilities 查询。完整环境变量、JSBridge、桥协议和 Protocol 页面接口环境由已安装能力提供。传 emulation 时由同一个调用联动设备模拟与 iframe 系统外壳；省略 emulation 时不改变设备状态。',
      inputSchema: {
        type: 'object',
        properties: {
          enabled: {
            type: 'boolean',
            description: '必填。true=启用容器模拟，false=清除并还原设备模拟',
          },
          profile: {
            type: 'string',
            description: '端模拟 ID（enabled=true 时必填），决定 UA/桥对象/环境判断特征',
          },
          os: {
            type: 'string',
            enum: ['ios', 'android'],
            description: '容器系统，默认 ios',
          },
          refreshDefinition: {
            type: 'boolean',
            description: '立即采用最新端模拟配置，保留用户显式设置',
          },
          lockDefinition: {
            type: 'boolean',
            description: '固定当前定义；默认在下次刷新或文档导航时自动更新',
          },
          appVersion: { type: 'string', description: '覆盖配置中的默认 App 版本号' },
          deviceModel: {
            type: 'string',
            description: 'Android 机型名（拼入 UA 与 __DEVICE_MODEL__）',
          },
          bridgeConfig: {
            type: 'object',
            description:
              '声明式覆盖桥方法，形如 {methods:{api:{behavior|response|noop,silent?}}}；扩展会先合并同一端模拟的本地配置',
          },
          networkControl: {
            type: ['object', 'null'],
            properties: { id: { type: 'string' }, value: { type: 'string' } },
            required: ['id', 'value'], additionalProperties: false,
            description: '可选已安装网络控件 {id,value}；null 清除，省略时保持当前设置。',
          },
          emulation: {
            type: 'object',
            description:
              '可选设备联动参数；字段覆盖端模拟配置推荐的设备，空对象使用推荐设备，deviceShell 默认 true。省略时不设置或清除设备。',
            properties: {
              preset: {
                type: 'string',
                enum: [...BROWSER_DEVICE_PRESET_NAMES],
              },
              width: { type: 'number' },
              height: { type: 'number' },
              deviceScaleFactor: { type: 'number' },
              scale: { type: 'number', exclusiveMinimum: 0 },
              mobile: { type: 'boolean' },
              userAgent: { type: 'string' },
              orientation: {
                type: 'string',
                enum: ['portrait', 'landscape'],
              },
              touch: { type: 'boolean' },
              deviceShell: {
                type: 'boolean',
                description: '是否使用根 iframe WebView 并显示系统栏；在 emulation 内默认 true',
              },
              splitScreen: {
                type: 'boolean',
                description:
                  '是否在横屏时将首页与业务页分置左右 WebView；仅与 deviceShell=true、orientation=landscape 同时生效，默认 false',
              },
            },
          },
          reload: {
            type: 'boolean',
            description: '应用/清除后是否重载页面，默认 true',
          },
          tabId: {
            type: 'number',
            description: '目标标签页 ID（从 browser_tab_open 或 browser_tab_list 获取）',
          },
        },
        required: ['tabId', 'enabled'],
      },
    },
    {
      name: 'browser_set_timezone',
      description:
        '覆盖目标标签页的时区，作用域仅限该 tab，立即影响 Date / Intl 等页面时间 API。timezone 使用 IANA 时区标识（如 Asia/Shanghai、America/New_York）；传空字符串恢复浏览器默认时区。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '目标标签页 ID（从 browser_tab_open 或 browser_tab_list 获取）',
          },
          timezone: {
            type: 'string',
            description: 'IANA 时区标识；空字符串表示清除覆盖',
          },
        },
        required: ['tabId', 'timezone'],
      },
    },
    {
      name: 'browser_get_cookie',
      description:
        '从目标浏览器读取一个指定非分区 Cookie，用于验证页面分支、实验或当前账号标识。必须明确传 Cookie 名，不支持列举全部 Cookie；HttpOnly Cookie 会被拒绝，禁止读取认证 Token。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '可选；指定标签页的 Cookie 存储区，省略时使用浏览器默认存储区',
          },
          name: {
            type: 'string',
            description: 'Cookie 名称',
          },
          url: {
            type: 'string',
            description: 'Cookie 查询 URL；未传 tabId 时必填，省略时使用指定标签页 URL',
          },
          domain: {
            type: 'string',
            description: '可选精确域过滤，只允许 Cookie 查询 URL 的 host 或它的父域',
          },
          path: {
            type: 'string',
            description: '可选精确 path 过滤',
          },
        },
        required: ['name'],
        anyOf: [{ required: ['url'] }, { required: ['tabId'] }],
      },
    },
    {
      name: 'browser_set_cookie',
      description:
        '在目标浏览器设置一个指定非分区 session Cookie。url 与 tabId 至少传一个；未传 tabId 时使用浏览器默认存储区。domain 只允许目标 URL 的 host 或它的父域。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: {
            type: 'number',
            description: '可选；指定标签页的 Cookie 存储区，reload=true 时必填',
          },
          url: {
            type: 'string',
            description: 'Cookie 目标 URL；未传 tabId 时必填，省略时使用指定标签页 URL',
          },
          name: {
            type: 'string',
            description: 'Cookie 名称',
          },
          value: {
            type: 'string',
            description: 'Cookie 值，可传空字符串；空字符串不会删除 Cookie',
          },
          domain: {
            type: 'string',
            description: 'Cookie 域，默认目标 URL 的 host；只允许目标 host 或它的父域',
          },
          path: {
            type: 'string',
            description: 'Cookie path，默认 /',
          },
          reload: {
            type: 'boolean',
            description: '设置后是否刷新指定 tabId，默认 false；true 时必须传 tabId',
          },
        },
        required: ['name', 'value'],
        anyOf: [{ required: ['url'] }, { required: ['tabId'] }],
      },
    },
    {
      name: 'browser_run_actions',
      description:
        '批量顺序执行多个无需中间判断的原子操作，适合 hover→click 等必须紧密连续的序列。步骤内的页面动作不带内置观察；遇到第一个失败步骤立即停止，且不能嵌套 run_actions。需要条件、循环或处理返回数据时可用 browser_run_code；需要模型理解页面时使用逐步页面工具。不要用本工具固化「点击→等待→截图」循环。',
      inputSchema: {
        type: 'object',
        properties: {
          actions: {
            type: 'array',
            description: '要依次执行的 action 列表',
            items: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  description:
                    'action 名称（不带 browser_ 前缀），如 page_hover、page_click；仅组合无需中间判断的步骤',
                },
                data: {
                  type: 'object',
                  description: '该 action 的参数（与单独调用时相同）',
                },
              },
              required: ['action'],
            },
          },
          tabId: {
            type: 'number',
            description: '所有步骤共享的目标标签页 ID。步骤自身指定的 tabId 优先级更高',
          },
        },
        required: ['tabId', 'actions'],
      },
    },
    {
      name: RUN_CODE_TOOL_NAME,
      description:
        '在 MCP server 宿主的独立 Node.js 进程执行 JavaScript，预注入 mearl SDK，支持顶层 await、条件、循环和数据处理。浏览器调用用 mearl.pageClick({tabId,selector}) 等现有 SDK 方法或 mearl.invoke(action,payload,options?)；Skill 命令用 mearl.invokePlugin(name,{command,input},options?)。用 console.log(await mearl.help("pageClick")) 查共享命令帮助，help({plugin,command?}) 查插件帮助，mearl.structure(value) 查看有界结果结构。使用 console.log 输出必要结果，await 所有 SDK 调用。JS 变量每次重建；session 和 tabId 可跨调用复用。DOM 代码使用 mearl.pageEval。脚本拥有宿主 Node 权限，超时或取消不能撤销已派发操作。',
      inputSchema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'JavaScript 源码，最大 1 MiB；使用 await import() 加载模块',
          },
          browser: { type: 'string', description: '目标浏览器 ID 或唯一名称' },
          session: {
            type: 'string',
            description: '首次调用 tab_open/page_snapshot 等传 new；后续复用 sessionId',
          },
          timeoutSec: {
            type: 'number',
            exclusiveMinimum: 0,
            maximum: 2147483,
            description: '整个脚本的执行时限，默认 60 秒',
          },
        },
        required: ['code'],
      },
    },
    {
      name: 'browser_list',
      description:
        '列出所有浏览器。返回普通浏览器和 Provider 托管浏览器的 browserId、名称、类型、连接状态、稳定元数据及当前默认目标，但不返回带临时凭据的浏览器访问地址。只有 status=connected 的浏览器可用于后续操作。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'browser_select_browser',
      description:
        '选择后续所有浏览器操作的默认目标浏览器（有多个浏览器连接时）。传入 browser_list 返回且 status=connected 的 browserId 或名称即可锁定；传空字符串则清除锁定，回到自动模式（操作最近聚焦的浏览器）。',
      inputSchema: {
        type: 'object',
        properties: {
          browser: {
            type: 'string',
            description: '目标浏览器的 browserId / 名称；空字符串表示清除锁定、恢复自动选择',
          },
        },
        required: ['browser'],
      },
    },
    {
      name: 'browser_request_permission',
      description:
        '申请访问指定域名的权限。调用后浏览器会弹出确认窗口让用户授权（90 秒超时），返回 granted 表示是否已获得授权。扩展模式下发送非内置域的 HTTP 请求（browser_send_request）前需先获得用户授权。',
      inputSchema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: '需要授权的域名，如 example.com',
          },
        },
        required: ['domain'],
      },
    },
  ]);

  type _MissingMcpTools = AssertNever<Exclude<McpToolName, (typeof tools)[number]['name']>>;

  // 处理工具列表请求
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map(
        (tool: Tool): Tool =>
          tool.name === PLUGIN_INVOKE_TOOL_NAME || tool.name === RUN_CODE_TOOL_NAME
            ? tool
            : {
                ...tool,
                inputSchema: {
                  ...tool.inputSchema,
                  ...(tool.name === 'browser_page_upload'
                    ? {
                        required: (tool.inputSchema.required ?? []).filter(
                          field => field !== 'filePaths',
                        ),
                      }
                    : {}),
                  properties: {
                    ...tool.inputSchema.properties,
                    ...(tool.name === 'browser_release'
                      ? {
                          closeCreatedTabs: { type: 'boolean' },
                          keepTabIds: { type: 'array', items: { type: 'number' } },
                          preserveEnvironment: { type: 'boolean' },
                          keepArtifactIds: { type: 'array', items: { type: 'string' } },
                        }
                      : {}),
                    ...(tool.name === 'browser_page_upload'
                      ? {
                          files: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                filePath: { type: 'string' },
                                artifactId: { type: 'string' },
                              },
                            },
                          },
                        }
                      : {}),
                    session: {
                      type: 'string',
                      description:
                        '首次 tab_open/page_snapshot 传 new；后续复用返回的 session.sessionId',
                    },
                  },
                },
              },
      ),
    };
  });

  // 处理工具调用请求
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { arguments: args } = request.params;
    const name =
      request.params.name === 'browser_capture_checkpoint'
        ? 'browser_tab_checkpoint'
        : request.params.name;

    try {
      if (name === RUN_CODE_TOOL_NAME) {
        const input = (args ?? {}) as Record<string, any>;
        const result = await executeScript(input.code, {
          ...(input.browser ? { browser: input.browser } : {}),
          ...(input.session ? { session: input.session } : {}),
          ...(input.timeoutSec !== undefined ? { executionTimeoutSec: input.timeoutSec } : {}),
          signal: extra?.signal,
          source: 'mcp',
        });
        const tooLarge = Buffer.byteLength(JSON.stringify(result)) >= RESPONSE_SIZE_MAX;
        return {
          content: formatResponseWithSizeCheck(result, name, input),
          ...(result.success && !tooLarge ? {} : { isError: true }),
        };
      }
      if (name !== PLUGIN_INVOKE_TOOL_NAME && !(name in MCP_TOOL_ACTIONS)) {
        throw new Error(`Unknown tool: ${name}`);
      }
      let result: any;
      if (name === PLUGIN_INVOKE_TOOL_NAME) {
        result = await invokePluginTool(args, client.invokePlugin);
      } else {
        const { session, outputPath, ...payload } = (args ?? {}) as Record<string, any>;
        if (name === 'browser_set_mock' && payload.payloadFile) {
          if (!existsSync(payload.payloadFile))
            throw new Error(`Payload file not found: ${payload.payloadFile}`);
          const fileData = JSON.parse(readFileSync(payload.payloadFile, 'utf-8'));
          for (const field of [
            'tabId',
            'apiName',
            'mockData',
            'fields',
            'enabled',
            'duration',
            'conditions',
          ]) {
            if (fileData[field] !== undefined) payload[field] = fileData[field];
          }
          delete payload.payloadFile;
        }
        const browser = name === 'browser_get_capabilities' ? payload.browser : undefined;
        if (name === 'browser_get_capabilities') delete payload.browser;
        result = await client.invoke(
          MCP_TOOL_ACTIONS[name as McpBrowserToolName],
          payload,
          { ...(session ? { session } : {}), ...(browser ? { browser } : {}) },
        );
        if (name === 'browser_page_download' && outputPath) {
          await client.saveArtifact(result.download, outputPath, session ? { session } : {});
          result = { ...result, outputPath };
        }
        if (name === 'browser_page_screenshot') {
          return {
            content: [
              {
                type: 'image' as const,
                data: result.data,
                mimeType: result.meta?.format === 'jpeg' ? 'image/jpeg' : 'image/png',
              },
              {
                type: 'text' as const,
                text: JSON.stringify({
                  meta: result.meta,
                  ...(result.session ? { session: result.session } : {}),
                }),
              },
            ],
          };
        }
        if (name === 'browser_run_actions') {
          const screenshots = (result.results ?? []).filter(
            (step: any) => step.success && step.action === 'page_screenshot' && step.data?.data,
          );
          if (screenshots.length) {
            return {
              content: [
                ...screenshots.map((step: any) => ({
                  type: 'image' as const,
                  data: step.data.data,
                  mimeType: step.data.meta?.format === 'jpeg' ? 'image/jpeg' : 'image/png',
                })),
                ...formatResponseWithSizeCheck(
                  {
                    ...result,
                    results: result.results.map((step: any) =>
                      step.action === 'page_screenshot' && step.success
                        ? { ...step, data: { meta: step.data?.meta } }
                        : step,
                    ),
                  },
                  name,
                  args,
                ),
              ],
              ...(result.failedStep !== undefined ? { isError: true } : {}),
            };
          }
        }
      }

      // 使用智能格式化返回结果
      return {
        content: formatResponseWithSizeCheck(result, name, args),
        ...(result?.action?.success === false || result?.failedStep !== undefined
          ? { isError: true }
          : {}),
      };
    } catch (error) {
      log(`Error executing tool ${name}:`, error);

      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  // 使用 stdio 传输层启动服务器
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('MCP Server started and ready');
}

// 错误处理
process.on('uncaughtException', error => {
  console.error('[MCP Server] Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', error => {
  console.error('[MCP Server] Unhandled rejection:', error);
  process.exit(1);
});

// 启动服务器
main().catch(error => {
  console.error('[MCP Server] Failed to start:', error);
  process.exit(1);
});
