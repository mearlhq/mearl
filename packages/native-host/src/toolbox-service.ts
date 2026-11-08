import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import {
  findPluginRegistration,
  invokeRegisteredToolboxPlugin,
  PluginTaskClient,
  pluginDirectory,
  listPluginNames,
  readPluginPageBundleChunk,
  refreshRegisteredPlugin,
  getSkillEnabled,
  setSkillEnabled,
  type PluginExecutionContext,
} from '@mearl/client/plugin';
import { uninstallPlugin } from '@mearl/setup/plugin';
import { runCommand } from '@mearl/daemon-core';
import type {
  ToolboxTaskRequest,
  ToolboxServiceResponse,
  ToolboxPluginActionResult,
  ToolboxPageChunkResult,
  ToolboxPluginTool,
  ToolboxToolInvokeResult,
  ToolboxToolOpenResult,
  ToolboxToolsListResult,
  ToolboxSkillUpdate,
  PluginTaskStartResult,
} from '@mearl/browser-core';

const PLUGIN_TOOL_PREFIX = 'plugin:';
const taskQueries = new Map<string, PluginTaskClient>();

function globalSkillUpdate(entry: string): ToolboxSkillUpdate | undefined {
  const directory = dirname(dirname(resolve(entry)));
  const name = basename(directory);
  if (directory !== resolve(homedir(), '.agents', 'skills', name)) return undefined;
  return { name, scope: 'global' };
}

export interface ToolboxServiceDependencies {
  taskClient?: (plugin: string, context?: PluginExecutionContext) => PluginTaskClient;
  findRegistration?: typeof findPluginRegistration;
  invokePlugin?: typeof invokeRegisteredToolboxPlugin;
  listPlugins?: typeof listPluginNames;
  readPageChunk?: typeof readPluginPageBundleChunk;
  refreshRegistration?: typeof refreshRegisteredPlugin;
  uninstallPlugin?: typeof uninstallPlugin;
}

export interface ToolboxAgentRuntime {
  toolId: string;
  skill: string;
}

function pluginNameFromToolId(id: unknown): string {
  if (typeof id !== 'string' || !id.startsWith(PLUGIN_TOOL_PREFIX)) {
    throw new Error('Tool id is invalid');
  }
  const plugin = id.slice(PLUGIN_TOOL_PREFIX.length);
  if (!/^[a-z][a-z0-9_-]*$/.test(plugin)) throw new Error('Tool id is invalid');
  return plugin;
}

function jsonValue(value: unknown, label: string, maximumBytes: number): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable`);
  }
  if (serialized === undefined) throw new Error(`${label} must be JSON serializable`);
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw new Error(`${label} is too large`);
  }
  return JSON.parse(serialized);
}

function invocation(
  id: unknown,
  command: unknown,
  input: unknown,
  dependencies: ToolboxServiceDependencies,
) {
  const plugin = pluginNameFromToolId(id);
  if (typeof command !== 'string' || !/^[a-z][a-z0-9-]*$/.test(command)) {
    throw new Error('Tool command is invalid');
  }
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) {
    throw new Error('Tool input must be an object');
  }
  const find = dependencies.findRegistration ?? findPluginRegistration;
  const page = find(plugin)?.toolbox?.page;
  if (!page || !page.commands.includes(command)) {
    throw new Error(`Tool command is not allowed: ${command}`);
  }
  return {
    command,
    input: jsonValue(input ?? {}, 'Tool input', 256 * 1024) as Record<string, unknown>,
    invoke: dependencies.invokePlugin ?? invokeRegisteredToolboxPlugin,
    plugin,
  };
}

export async function listToolboxPluginTools(
  dependencies: ToolboxServiceDependencies = {},
): Promise<ToolboxToolsListResult> {
  const list = dependencies.listPlugins ?? listPluginNames;
  const find = dependencies.findRegistration ?? findPluginRegistration;
  const refresh = dependencies.refreshRegistration ?? refreshRegisteredPlugin;
  const registrations = await Promise.all(
    list().map(async plugin => {
      try {
        const registration =
          dependencies.findRegistration && !dependencies.refreshRegistration
            ? find(plugin)
            : await refresh(plugin);
        return { plugin, registration };
      } catch {
        // 不完整的本地更新保留上一次有效快照，打开工具时会报告具体错误。
        try {
          return { plugin, registration: find(plugin) };
        } catch {
          return { plugin, registration: undefined };
        }
      }
    }),
  );
  const candidates = registrations.flatMap<{ entry: string; tool: ToolboxPluginTool }>(
    ({ plugin, registration }) => {
      try {
        const contribution = registration?.toolbox;
        if (!registration || !contribution) return [];
        const skillUpdate = globalSkillUpdate(registration.entry);
        const skillEnabled =
          basename(dirname(registration.entry)) === 'scripts'
            ? getSkillEnabled(dirname(dirname(resolve(registration.entry))))
            : undefined;
        return [
          {
            entry: registration.entry,
            tool: {
              id: `${PLUGIN_TOOL_PREFIX}${plugin}`,
              plugin,
              title: contribution.title,
              ...(contribution.displayMode ? { displayMode: contribution.displayMode } : {}),
              ...(contribution.description ? { description: contribution.description } : {}),
              ...(contribution.icon ? { icon: contribution.icon } : {}),
              ...(contribution.locales ? { locales: contribution.locales } : {}),
              order: contribution.order ?? 100,
              ...(skillUpdate ? { skillUpdate } : {}),
              ...(skillEnabled !== undefined ? { skillEnabled } : {}),
            },
          },
        ];
      } catch {
        return [];
      }
    },
  );
  candidates.sort(
    (left, right) =>
      left.tool.order - right.tool.order ||
      left.tool.title.localeCompare(right.tool.title) ||
      left.tool.plugin.localeCompare(right.tool.plugin),
  );
  const seenEntries = new Set<string>();
  const tools = candidates.flatMap(({ entry, tool }) => {
    if (seenEntries.has(entry)) return [];
    seenEntries.add(entry);
    return [tool];
  });
  return { tools };
}

export async function uninstallToolboxPlugin(
  id: unknown,
  dependencies: ToolboxServiceDependencies = {},
): Promise<ToolboxPluginActionResult> {
  const plugin = pluginNameFromToolId(id);
  const registration = (dependencies.findRegistration ?? findPluginRegistration)(plugin);
  if (!registration?.toolbox) throw new Error(`Tool is not registered: ${id}`);
  const result = await (dependencies.uninstallPlugin ?? uninstallPlugin)(
    plugin,
    (command, args, options) =>
      runCommand(command, args, {
        ...options,
        tee: false,
        capture: true,
      }),
  );
  return { plugin, removed: result.removed };
}

export function setToolboxSkillEnabled(
  id: unknown,
  enabled: unknown,
  dependencies: ToolboxServiceDependencies = {},
): { enabled: boolean } {
  if (typeof enabled !== 'boolean') throw new Error('Skill enabled must be a boolean');
  const plugin = pluginNameFromToolId(id);
  const registration = (dependencies.findRegistration ?? findPluginRegistration)(plugin);
  if (!registration?.toolbox) throw new Error(`Tool is not registered: ${id}`);
  if (basename(dirname(registration.entry)) !== 'scripts') {
    throw new Error('找不到工具对应的 Skill 目录');
  }
  setSkillEnabled(dirname(dirname(resolve(registration.entry))), enabled);
  return { enabled };
}

export async function openToolboxPluginTool(
  id: unknown,
  _context: PluginExecutionContext,
  dependencies: ToolboxServiceDependencies = {},
): Promise<ToolboxToolOpenResult> {
  const plugin = pluginNameFromToolId(id);
  const find = dependencies.findRegistration ?? findPluginRegistration;
  const registration =
    dependencies.findRegistration && !dependencies.refreshRegistration
      ? find(plugin)
      : await (dependencies.refreshRegistration ?? refreshRegisteredPlugin)(plugin, true);
  const contribution = registration?.toolbox;
  const bundle = registration?.pageBundle;
  if (!contribution || !bundle) throw new Error(`Tool is not registered: ${id}`);
  const { agent } = contribution;
  const skillUpdate = globalSkillUpdate(registration.entry);
  return {
    title: contribution.title,
    ...(contribution.displayMode ? { displayMode: contribution.displayMode } : {}),
    ...(contribution.icon ? { icon: contribution.icon } : {}),
    ...(contribution.locales ? { locales: contribution.locales } : {}),
    ...(agent
      ? {
          agent: {
            enabled: true,
            layout: agent.layout ?? 'drawer',
            ...(agent.pageElementActions !== undefined
              ? { pageElementActions: agent.pageElementActions }
              : {}),
          },
        }
      : {}),
    ...(skillUpdate ? { skillUpdate } : {}),
    page: {
      type: 'sandbox',
      ...(contribution.page.runtime ? { runtime: contribution.page.runtime } : {}),
      hash: bundle.hash,
      size: bundle.size,
      chunks: bundle.chunks,
    },
  };
}

export function resolveToolboxPluginAgent(
  id: unknown,
  dependencies: ToolboxServiceDependencies = {},
): ToolboxAgentRuntime {
  const plugin = pluginNameFromToolId(id);
  const find = dependencies.findRegistration ?? findPluginRegistration;
  const contribution = find(plugin)?.toolbox;
  const agent = contribution?.agent;
  if (!contribution || !agent) throw new Error(`Tool Agent is not registered: ${String(id)}`);
  return {
    toolId: id as string,
    skill: agent.skill,
  };
}

export function readToolboxPluginPageChunk(
  id: unknown,
  hash: unknown,
  index: unknown,
  dependencies: ToolboxServiceDependencies = {},
): ToolboxPageChunkResult {
  const plugin = pluginNameFromToolId(id);
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('Tool page hash is invalid');
  }
  if (!Number.isInteger(index)) throw new Error('Tool page chunk index is invalid');
  return (dependencies.readPageChunk ?? readPluginPageBundleChunk)(plugin, hash, index as number);
}

export async function invokeToolboxPluginTool(
  id: unknown,
  command: unknown,
  input: unknown,
  context: PluginExecutionContext,
  dependencies: ToolboxServiceDependencies = {},
): Promise<ToolboxToolInvokeResult> {
  const prepared = invocation(id, command, input, dependencies);
  const result = await prepared.invoke(
    prepared.plugin,
    { command: prepared.command, input: prepared.input },
    context,
  );
  return {
    result: jsonValue(result, 'Tool result', 512 * 1024),
  };
}

function taskClient(
  plugin: string,
  context: PluginExecutionContext | undefined,
  dependencies: ToolboxServiceDependencies,
): PluginTaskClient {
  if (dependencies.taskClient) return dependencies.taskClient(plugin, context);
  const options = {
    plugin,
    access: 'toolbox' as const,
    source: 'toolbox' as const,
    scopeId: String(process.pid),
    invoke:
      context?.invoke ??
      (async () => {
        throw new Error('Query connections cannot invoke browser actions');
      }),
  };
  if (context) return new PluginTaskClient(options);
  const key = `${pluginDirectory()}:${plugin}`;
  let client = taskQueries.get(key);
  if (!client) {
    client = new PluginTaskClient(options);
    taskQueries.set(key, client);
  }
  return client;
}

async function startToolboxTask(
  id: unknown,
  command: unknown,
  input: unknown,
  context: PluginExecutionContext,
  dependencies: ToolboxServiceDependencies = {},
  options: { executionTimeoutMs?: number; idempotencyKey?: string } = {},
): Promise<PluginTaskStartResult> {
  const prepared = invocation(id, command, input, dependencies);
  const client = taskClient(prepared.plugin, context, dependencies);
  try {
    const started = await client.start(
      prepared.plugin,
      { command: prepared.command, input: prepared.input },
      options,
    );
    const observe = async () => {
      let cursor = 0;
      while (true) {
        const page = await client.events(started.taskId, cursor, 25000);
        cursor = page.nextCursor;
        if (!['queued', 'running', 'cancelling'].includes(page.task.state)) return;
      }
    };
    void observe()
      .finally(() => client.disconnect())
      .catch(() => {});
    return started;
  } catch (error) {
    client.disconnect();
    throw error;
  }
}

export async function handleToolboxTask(
  data: ToolboxTaskRequest,
  context: PluginExecutionContext,
  dependencies: ToolboxServiceDependencies = {},
): Promise<ToolboxServiceResponse<'toolbox_task'>> {
  const query = () => taskClient(pluginNameFromToolId(data.id), undefined, dependencies);
  const operation = data?.operation;
  switch (operation) {
    case 'start':
      return startToolboxTask(data.id, data.command, data.input, context, dependencies, {
        executionTimeoutMs: data.executionTimeoutMs,
        idempotencyKey: data.idempotencyKey,
      });
    case 'get':
      return query().get(data.taskId);
    case 'list':
      return query().list(data.activeOnly !== false, {
        cursor: data.cursor,
        limit: data.limit,
      });
    case 'cancel':
      return query().cancel(data.taskId);
    case 'events':
      return query().events(data.taskId, data.cursor ?? 0, data.waitMs ?? 0);
    case 'result':
      return query().resultChunk(data.taskId, data.index);
    case 'diagnose': {
      const { id: _id, operation: _operation, ...options } = data;
      if (
        Object.keys(options).some(
          key =>
            !['taskId', 'instanceId', 'includeErrorMessages', 'includeLocalPaths'].includes(key),
        )
      )
        throw new Error('Invalid diagnostic options');
      return query().diagnose(options);
    }
    default: {
      const unhandledOperation: never = operation;
      throw new Error(`Invalid toolbox task operation: ${String(unhandledOperation)}`);
    }
  }
}
