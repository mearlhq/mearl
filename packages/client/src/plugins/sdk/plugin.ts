import { normalizePluginState, pluginStateSignature } from './pluginStateDefinition.js';
import type { CommandRunner } from '@mearl/daemon-core';
import {
  normalizePluginTaskRecovery,
  pluginRecoverySignature,
} from './pluginRecoveryDefinition.js';
import type {
  PluginTaskRecoveryDeclaration,
  PluginTaskCheckpoint,
  PluginCheckpointMigrationInput,
} from '@mearl/browser-core';
import type { PluginStateDeclaration } from '@mearl/browser-core';
import type { PluginModelRequest, PluginModelResult } from '@mearl/browser-core';
import { normalizePluginPageRuntime } from './pluginPageDefinition.js';
import type { PluginPageRuntime } from '@mearl/browser-core';
import { loadPluginAppProfiles } from './pluginAppProfiles.js';
import type { AppProfileContribution } from '@mearl/browser-core';
export type { AppProfileContribution, AppProfileDefinition } from '@mearl/browser-core';
export { invokePageEvalWithArgs } from '../../pageEvalArguments.js';
import { readInstalledSkillMetadata } from '../skillManifest.js';
import { dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { COMMAND_MAP } from '../../commands.js';
import { findOfficialPlugin } from '../officialPluginCatalog.js';
import {
  ensureOfficialPluginRegistered,
  type OfficialPluginInstaller,
} from '../officialPluginInstaller.js';
import {
  findPluginRegistration,
  pluginRegistrationNeedsRefresh,
  registerPlugin,
  pluginDirectory,
  normalizePluginToolboxContribution,
  PluginError,
  type PluginToolboxContribution,
  type PluginRegistration,
} from '../pluginRegistry.js';
import { pluginFileVersion } from '../pluginSource.js';
import { describePythonPlugin, runPythonPluginCommand } from '../runtime/pythonPlugin.js';
import {
  createPluginInvocationIdentity,
  type PluginCommandContext,
  type PluginInvocationIdentity,
  type PluginInvocationSource,
} from '../runtime/pluginExecution.js';
import type { UnifiedInvokeOptions } from '../../unified.js';

export type {
  PluginCommandContext,
  PluginExecutionHost,
  PluginInvocationIdentity,
  PluginInvocationSource,
} from '../runtime/pluginExecution.js';
export {
  executeRegisteredPlugin,
  type PluginExecutorOptions,
  type PluginExecutorDependencies,
} from '../runtime/pluginExecutor.js';
export { PluginTaskClient } from '../clients/pluginTasks.js';
export { cleanupPluginRuntime } from '../runtime/pluginRuntimeCleanup.js';
export { PluginPageClient } from '../clients/pluginPages.js';

export {
  assertPluginName,
  findPluginDirectoryEntry,
  findPluginEntry,
  findPluginRegistration,
  pluginRegistrationNeedsRefresh,
  listPluginNames,
  pluginDirectory,
  registerPlugin,
  resolvePluginEntry,
  unregisterPlugin,
  PluginError,
  readPluginPageBundleChunk,
  type PluginRegistration,
  type PluginRegistrationOptions,
  type PluginToolboxAgentConfig,
  type PluginPageBundleRegistration,
  type PluginToolboxContribution,
  type PluginToolboxLocale,
  type PluginToolboxSandboxPage,
} from '../pluginRegistry.js';

export {
  findOfficialPlugin,
  listOfficialPluginNames,
  OFFICIAL_PLUGIN_MANAGER,
  OFFICIAL_PLUGINS,
  readOfficialPluginCatalog,
  replaceOfficialPluginCatalog,
  uninstallOfficialPluginCatalog,
  validateOfficialPluginCatalog,
  type PluginCatalogSelection,
  type PluginCatalog,
  type OfficialPluginDefinition,
  type OfficialPluginName,
} from '../officialPluginCatalog.js';

export type PluginOptions = UnifiedInvokeOptions;

export interface StructuredPluginProgress {
  message: string;
  data?: Record<string, unknown>;
}

export type PluginProgress = string | StructuredPluginProgress;

export interface PluginInvocation {
  command: string;
  input: Record<string, any>;
}

export interface PluginInvokeOptions extends UnifiedInvokeOptions {
  onProgress?: (progress: PluginProgress) => void;
  signal?: AbortSignal;
  /** Audit label supplied by the entry point, never an authorization decision. */
  source?: PluginInvocationSource;
}

export interface PluginExecutionContext {
  runModel?(
    plugin: string,
    request: PluginModelRequest,
    options: Pick<PluginInvokeOptions, 'signal' | 'onProgress'>,
  ): Promise<PluginModelResult>;
  ensurePlugin?: OfficialPluginInstaller;
  source?: PluginInvocationSource;
  parentInvocation?: PluginInvocationIdentity;
  invocation?: PluginInvocationIdentity;
  resolveRegistration?: (name: string) => PluginRegistration | undefined;
  invoke(
    action: string,
    payload?: Record<string, any>,
    options?: UnifiedInvokeOptions,
    onProgress?: PluginInvokeOptions['onProgress'],
  ): Promise<any>;
}

export interface PluginApp {
  readonly options: Readonly<PluginOptions>;
  /** Examples omit the `mearl <plugin>` prefix, which help adds when displayed. */
  command(
    signature: string,
    handler: PluginHandler,
    description?: string,
    examples?: string[],
  ): void;
  /** Registers a page-only command, also declared in toolbox.page.commands. */
  state(collection: string, operation: string, input?: Record<string, unknown>): Promise<any>;
  model(
    request: PluginModelRequest,
    options?: Pick<PluginInvokeOptions, 'onProgress'>,
  ): Promise<PluginModelResult>;
  runtimeCommand(
    signature: string,
    handler: PluginHandler,
    description?: string,
    examples?: string[],
  ): void;
  recoveryCommand(command: string, handler: PluginHandler): void;
  checkpointMigration(
    command: string,
    handler: (
      input: PluginCheckpointMigrationInput,
      context: PluginCommandContext,
    ) => unknown | Promise<unknown>,
  ): void;
  checkpoint(data: unknown, expectedSequence: number): Promise<PluginTaskCheckpoint>;
  page(operation: string, input?: Record<string, unknown>): Promise<any>;
  toolboxCommand(
    signature: string,
    handler: PluginHandler,
    description?: string,
    examples?: string[],
  ): void;
  invoke(
    action: string,
    payload?: Record<string, any>,
    options?: UnifiedInvokeOptions,
  ): Promise<any>;
  progress(progress: PluginProgress): void;
}

export type PluginHandler = (
  input: Record<string, any>,
  context: PluginCommandContext,
) => unknown | Promise<unknown>;

interface RegisteredCommand {
  command: Command;
  signature: string;
  handler: PluginHandler;
  examples: string[];
  toolboxOnly: boolean;
  runtimeOnly: boolean;
}

interface PluginExecutionState {
  stack: string[];
}

function readPluginVersion(entry: string): string | undefined {
  try {
    return readInstalledSkillMetadata(resolve(dirname(entry), '..'))?.version;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPluginInvocation(value: unknown): value is PluginInvocation {
  return isObject(value) && typeof value.command === 'string' && isObject(value.input);
}

function normalizePluginProgress(progress: PluginProgress): PluginProgress {
  if (typeof progress === 'string') {
    if (!progress) throw new Error('app.progress 需要非空消息');
    return progress;
  }
  if (!isObject(progress) || typeof progress.message !== 'string' || !progress.message) {
    throw new Error('app.progress 需要非空消息');
  }
  if (progress.data !== undefined && !isObject(progress.data)) {
    throw new Error('app.progress data 必须是对象');
  }
  let data: Record<string, unknown> | undefined;
  if (progress.data) {
    try {
      const serialized = JSON.stringify(progress.data);
      const parsed = serialized === undefined ? undefined : JSON.parse(serialized);
      if (!isObject(parsed)) throw new Error('invalid object');
      data = Object.freeze(parsed);
    } catch {
      throw new Error('app.progress data 必须是可 JSON 序列化的对象');
    }
  }
  return Object.freeze({
    message: progress.message,
    ...(data ? { data } : {}),
  });
}

function missingPluginEntryMessage(entry: string, pluginName?: string): string {
  const name = pluginName ?? '<name>';
  return [
    '插件入口已失效',
    '',
    `插件：${name}`,
    `入口：${entry}`,
    '',
    `卸载命令：npx @mearl/setup plugin uninstall ${name}`,
  ].join('\n');
}

const registrationRefreshes = new Map<string, Promise<PluginRegistration | undefined>>();

/** 工具列表仅检查入口；页面资源只在打开对应工具时检查。 */
export async function refreshRegisteredPlugin(
  name: string,
  includePage = false,
): Promise<PluginRegistration | undefined> {
  const key = `${pluginDirectory()}/${name}`;
  const pending = registrationRefreshes.get(key);
  if (pending) {
    await pending;
    return refreshRegisteredPlugin(name, includePage);
  }
  const registration = findPluginRegistration(name);
  if (!registration) return undefined;
  const entryChanged = pluginRegistrationNeedsRefresh(registration);
  if (!entryChanged && (!includePage || !pluginRegistrationNeedsRefresh(registration, true))) {
    return registration;
  }
  const refresh = (async () => {
    const entryVersion = pluginFileVersion(registration.entry);
    const loaded = entryChanged
      ? await loadPlugin(
          registration.entry,
          {
            options: {},
            invoke: async () => {
              throw new Error('注册时不能执行浏览器操作');
            },
            progress: () => {
              throw new Error('注册时不能报告执行进度');
            },
          },
          name,
        )
      : registration;
    // 异步加载期间其他进程可能卸载或重新绑定同名插件。
    const current = findPluginRegistration(name);
    if (JSON.stringify(current) !== JSON.stringify(registration)) return current;
    if (pluginFileVersion(registration.entry) !== entryVersion) {
      throw new PluginError('PLUGIN_SOURCE_CHANGED', `插件更新进行中，请重新打开工具: ${name}`);
    }
    registerPlugin(name, registration.entry, loaded.description, {
      hasPublicCommands:
        'commandHelp' in loaded ? Boolean(loaded.commandHelp(name)) : loaded.hasPublicCommands,
      toolbox: loaded.toolbox,
      appProfiles: loaded.appProfiles,
      profileSources: 'profileSources' in loaded ? loaded.profileSources : loaded.source?.profiles,
      ...(registration.managedBy ? { managedBy: registration.managedBy } : {}),
    });
    return findPluginRegistration(name);
  })();
  registrationRefreshes.set(key, refresh);
  try {
    return await refresh;
  } finally {
    registrationRefreshes.delete(key);
  }
}

/** 注册和执行复用同一宿主能力边界；仅 handler 执行期间开放浏览器调用。 */
export async function loadPlugin(
  entry: string,
  context: Pick<PluginApp, 'options' | 'progress'> & {
    invoke: PluginExecutionContext['invoke'];
    source?: PluginInvocationSource;
    parentInvocation?: PluginInvocationIdentity;
    invocation?: PluginInvocationIdentity;
    signal?: AbortSignal;
    runModel?: PluginExecutionContext['runModel'];
    onInvocation?: (identity: PluginInvocationIdentity | undefined) => void;
  },
  pluginName?: string,
) {
  let entryVersion: string;
  try {
    entryVersion = pluginFileVersion(entry);
  } catch {
    throw new PluginError('PLUGIN_ENTRY_MISSING', missingPluginEntryMessage(entry, pluginName));
  }
  const commands = new Map<string, RegisteredCommand>();
  const recoveries = new Map<string, PluginHandler>();
  const migrations = new Map<string, PluginHandler>();
  let executing = false;
  let checkpointDeclaration: string | undefined;
  let invocationGeneration = 0;
  let registering = true;
  let name: string | undefined;
  let description: string | undefined;
  let defaultCommand: string | undefined;
  let toolbox: PluginToolboxContribution | undefined;
  let pageRuntime: PluginPageRuntime | undefined;
  let stateStorage: PluginStateDeclaration | undefined;
  let taskRecovery: PluginTaskRecoveryDeclaration | undefined;
  let appProfiles: AppProfileContribution | undefined;
  let profileSources: Record<string, string> | undefined;
  let setup: ((context: { runCommand: CommandRunner }) => unknown | Promise<unknown>) | undefined;
  const registerCommand = (
    signature: string,
    handler: PluginHandler,
    description = '',
    examples: string[] = [],
    toolboxOnly = false,
    runtimeOnly = false,
  ) => {
    if (!registering) throw new Error('命令只能在入口注册阶段声明');
    const [name, ...args] = signature.trim().split(/\s+/);
    if (
      !/^[a-z][a-z0-9-]*$/.test(name) ||
      commands.has(name) ||
      typeof handler !== 'function' ||
      !Array.isArray(examples) ||
      examples.some((example: unknown) => typeof example !== 'string' || !example.trim())
    ) {
      throw new Error(`无效或重复的命令: ${signature}`);
    }
    const command = new Command(name).description(description);
    for (const argument of args) {
      if (!/^(?:<[a-zA-Z][\w-]*(?:\.\.\.)?>|\[[a-zA-Z][\w-]*(?:\.\.\.)?\])$/.test(argument)) {
        throw new Error(`无效的位置参数: ${argument}`);
      }
      command.argument(argument);
    }
    const names = command.registeredArguments.map(argument => argument.name());
    if (new Set(names).size !== names.length) throw new Error(`参数名称重复: ${signature}`);
    commands.set(name, {
      command,
      signature,
      handler,
      examples: [...examples],
      toolboxOnly,
      runtimeOnly,
    });
  };
  const app: PluginApp = Object.freeze({
    options: Object.freeze({ ...context.options }),
    command: (
      signature: string,
      handler: PluginHandler,
      description = '',
      examples: string[] = [],
    ) => registerCommand(signature, handler, description, examples),
    runtimeCommand: (
      signature: string,
      handler: PluginHandler,
      description = '',
      examples: string[] = [],
    ) => registerCommand(signature, handler, description, examples, false, true),
    recoveryCommand(command: string, handler: PluginHandler) {
      if (
        !registering ||
        !/^[a-z][a-z0-9-]*$/.test(command) ||
        typeof handler !== 'function' ||
        recoveries.has(command)
      )
        throw new Error('Invalid or duplicate recovery command');
      recoveries.set(command, handler);
    },
    checkpointMigration(
      command: string,
      handler: (
        input: PluginCheckpointMigrationInput,
        context: PluginCommandContext,
      ) => unknown | Promise<unknown>,
    ) {
      if (
        !registering ||
        !/^[a-z][a-z0-9-]*$/.test(command) ||
        typeof handler !== 'function' ||
        migrations.has(command)
      )
        throw new Error('Invalid or duplicate checkpoint migration');
      migrations.set(command, (input, commandContext) =>
        handler(input as PluginCheckpointMigrationInput, commandContext),
      );
    },
    checkpoint(data: unknown, expectedSequence: number) {
      if (!executing || !context.invocation?.taskId)
        throw new PluginError('PLUGIN_TASK_REQUIRED', 'Checkpoints require a managed task');
      context.signal?.throwIfAborted();
      return context.invoke('plugin_task_checkpoint', {
        plugin: pluginName ?? name,
        data,
        expectedSequence,
        expectedDeclaration: checkpointDeclaration,
      });
    },
    state(collection: string, operation: string, input: Record<string, unknown> = {}) {
      if (!executing) throw new Error('app.state is only available during command execution');
      context.signal?.throwIfAborted();
      if (!stateStorage || !Object.hasOwn(stateStorage.collections, collection))
        throw new PluginError(
          'PLUGIN_STATE_NOT_DECLARED',
          'Plugin state collection is not declared',
        );
      return context.invoke('plugin_state', {
        ...input,
        plugin: pluginName ?? name,
        collection,
        operation,
        expectedDeclaration: pluginStateSignature(stateStorage.collections[collection]),
      });
    },
    model(request: PluginModelRequest, options: Pick<PluginInvokeOptions, 'onProgress'> = {}) {
      if (!executing) throw new Error('app.model is only available during command execution');
      context.signal?.throwIfAborted();
      const generation = invocationGeneration;
      const observing = () =>
        executing && generation === invocationGeneration && !context.signal?.aborted;
      if (context.runModel)
        return context.runModel(pluginName ?? name!, request, {
          signal: context.signal,
          onProgress: progress => {
            if (!observing()) return;
            context.progress(progress);
            options.onProgress?.(progress);
          },
        });
      const payload = {
        plugin: pluginName ?? name,
        operation: 'run',
        request,
      };
      return (
        options.onProgress
          ? context.invoke('plugin_model', payload, {}, progress => {
              if (observing()) options.onProgress?.(progress);
            })
          : context.invoke('plugin_model', payload)
      ) as Promise<PluginModelResult>;
    },
    page(operation: string, input: Record<string, unknown> = {}) {
      if (!executing) throw new Error('app.page is only available during command execution');
      context.signal?.throwIfAborted();
      return context.invoke('plugin_page', { ...input, plugin: pluginName ?? name, operation });
    },
    toolboxCommand: (
      signature: string,
      handler: PluginHandler,
      description = '',
      examples: string[] = [],
    ) => registerCommand(signature, handler, description, examples, true),
    invoke(action: string, payload: Record<string, unknown> = {}, options = {}) {
      if (!executing) throw new Error('app.invoke 只能在命令执行期间调用');
      context.signal?.throwIfAborted();
      return context.invoke(action, payload, options);
    },
    progress(progress: PluginProgress) {
      if (!executing) throw new Error('app.progress 只能在命令执行期间调用');
      context.progress(normalizePluginProgress(progress));
    },
  });
  try {
    if (extname(entry).toLowerCase() === '.py') {
      const descriptor = await describePythonPlugin(entry, app.options);
      name = descriptor.name;
      description = descriptor.description;
      toolbox = normalizePluginToolboxContribution(descriptor.toolbox);
      pageRuntime = normalizePluginPageRuntime(descriptor.pageRuntime);
      stateStorage = normalizePluginState(descriptor.stateStorage);
      taskRecovery = normalizePluginTaskRecovery(descriptor.taskRecovery);
      ({ appProfiles, profileSources } = loadPluginAppProfiles(entry, descriptor.appProfiles));
      for (const command of descriptor.commands) {
        const commandName = command.signature.trim().split(/\s+/)[0];
        if (command.migrationOnly) {
          app.checkpointMigration(commandName, (input, commandContext) =>
            runPythonPluginCommand(
              entry,
              commandName,
              input,
              app,
              commandContext,
              'migration',
              descriptor,
            ),
          );
          continue;
        }
        if (command.recoveryOnly) {
          app.recoveryCommand(commandName, (input, commandContext) =>
            runPythonPluginCommand(
              entry,
              commandName,
              input,
              app,
              commandContext,
              true,
              descriptor,
            ),
          );
          continue;
        }
        const register = command.runtimeOnly
          ? app.runtimeCommand
          : command.toolboxOnly
            ? app.toolboxCommand
            : app.command;
        register(
          command.signature,
          (input, commandContext) =>
            runPythonPluginCommand(
              entry,
              commandName,
              input,
              app,
              commandContext,
              false,
              descriptor,
              command.runtimeOnly,
            ),
          command.description,
        );
      }
    } else {
      const moduleUrl = pathToFileURL(entry);
      moduleUrl.searchParams.set('mearl-version', entryVersion);
      const module = await import(moduleUrl.href);
      if (module.name !== undefined && typeof module.name !== 'string')
        throw new Error('入口的 name 导出必须为字符串');
      name = module.name;
      if (module.description !== undefined && typeof module.description !== 'string')
        throw new Error('入口的 description 导出必须为字符串');
      description = module.description;
      if (module.setup !== undefined && typeof module.setup !== 'function')
        throw new Error('入口的 setup 导出必须为函数');
      setup = module.setup;
      if (module.defaultCommand !== undefined && typeof module.defaultCommand !== 'string')
        throw new Error('入口的 defaultCommand 导出必须为字符串');
      defaultCommand = module.defaultCommand;
      toolbox = normalizePluginToolboxContribution(module.toolbox);
      pageRuntime = normalizePluginPageRuntime(module.pageRuntime);
      stateStorage = normalizePluginState(module.stateStorage);
      taskRecovery = normalizePluginTaskRecovery(module.taskRecovery);
      ({ appProfiles, profileSources } = loadPluginAppProfiles(entry, module.appProfiles));
      if (module.default !== undefined && typeof module.default !== 'function')
        throw new Error('入口必须默认导出 register(app) 函数');
      if (typeof module.default === 'function') await module.default(app);
      else if (!appProfiles) throw new Error('入口必须默认导出 register(app) 函数');
    }
    if (commands.size === 0 && !appProfiles) throw new Error('入口未注册任何命令');
    if (
      defaultCommand !== undefined &&
      (!commands.has(defaultCommand) ||
        commands.get(defaultCommand)?.toolboxOnly ||
        commands.get(defaultCommand)?.runtimeOnly)
    )
      throw new Error('defaultCommand 必须指向公开命令');
    for (const command of Object.keys(taskRecovery?.commands ?? {})) {
      if (
        !commands.has(command) ||
        commands.get(command)?.runtimeOnly ||
        commands.get(command)?.toolboxOnly ||
        !recoveries.has(command)
      )
        throw new Error(`Recovery requires a command and recoveryCommand: ${command}`);
    }
    for (const command of recoveries.keys())
      if (!Object.hasOwn(taskRecovery?.commands ?? {}, command))
        throw new Error(`Undeclared recovery command: ${command}`);
    for (const [command, definition] of Object.entries(taskRecovery?.commands ?? {})) {
      if (Boolean(definition.migrateFrom?.length) !== migrations.has(command))
        throw new Error(
          `Checkpoint migrations require a declaration and checkpointMigration: ${command}`,
        );
    }
    for (const command of migrations.keys())
      if (!Object.hasOwn(taskRecovery?.commands ?? {}, command))
        throw new Error(`Undeclared checkpoint migration: ${command}`);
    const runtimeCommands = new Set(
      Object.values(pageRuntime?.events ?? {}).map(event => event.command),
    );
    if (pageRuntime?.initialize) runtimeCommands.add(pageRuntime.initialize);
    for (const [name, command] of commands) {
      if (command.runtimeOnly && !runtimeCommands.has(name))
        throw new Error(`runtimeCommand is not declared in pageRuntime.events: ${name}`);
    }
    for (const name of runtimeCommands)
      if (!commands.has(name) || commands.get(name)?.toolboxOnly)
        throw new Error(`Invalid page runtime command: ${name}`);
    const toolboxCommands = toolbox?.page.commands ?? [];
    for (const [name, command] of commands) {
      if (command.toolboxOnly && !toolboxCommands.includes(name)) {
        throw new Error(`toolboxCommand 未声明在 toolbox.page.commands 中: ${name}`);
      }
    }
    for (const command of toolboxCommands) {
      if (!commands.has(command)) throw new Error(`toolbox 命令未注册: ${command}`);
    }
  } catch (error) {
    throw new PluginError(
      'PLUGIN_LOAD_FAILED',
      `${entry}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    registering = false;
  }

  const find = (name: string, toolboxPage: boolean | 'runtime' = false): RegisteredCommand => {
    const command = commands.get(name);
    if (!command) throw new PluginError('PLUGIN_COMMAND_NOT_FOUND', `未知子命令: ${name}`);
    if (toolboxPage === 'runtime') {
      if (
        !(
          pageRuntime?.initialize === name ||
          Object.values(pageRuntime?.events ?? {}).some(event => event.command === name)
        ) ||
        command.toolboxOnly
      )
        throw new PluginError('PLUGIN_COMMAND_NOT_ALLOWED', 'Page runtime command is not declared');
    } else if (command.runtimeOnly) {
      throw new PluginError('PLUGIN_COMMAND_RUNTIME_ONLY', `命令仅供页面运行时调用: ${name}`);
    } else if (toolboxPage) {
      if (!toolbox?.page.commands.includes(name)) {
        throw new PluginError('PLUGIN_COMMAND_NOT_ALLOWED', `工具页面不允许调用命令: ${name}`);
      }
    } else if (command.toolboxOnly) {
      throw new PluginError('PLUGIN_COMMAND_TOOLBOX_ONLY', `命令仅供工具页面调用: ${name}`);
    }
    return command;
  };

  const publicCommands = () =>
    [...commands.values()].filter(command => !command.toolboxOnly && !command.runtimeOnly);

  const run = async (
    positionals: string[],
    payload?: unknown,
    namedInput: Record<string, unknown> = {},
    toolboxPage: boolean | 'runtime' | 'recovery' | 'migration' = false,
  ): Promise<unknown> => {
    if (payload !== undefined && positionals.length > 0) {
      throw new PluginError('PLUGIN_INVALID_INPUT', '位置参数调用与 --payload 调用不能混用');
    }
    if (payload !== undefined && Object.keys(namedInput).length > 0) {
      throw new PluginError('PLUGIN_INVALID_INPUT', '插件业务选项与 --payload 调用不能混用');
    }
    const defaultPayload =
      defaultCommand &&
      toolboxPage === false &&
      isObject(payload) &&
      !Object.hasOwn(payload, 'command');
    if (payload !== undefined && !defaultPayload && !isPluginInvocation(payload)) {
      throw new PluginError(
        'PLUGIN_INVALID_INPUT',
        '--payload 必须为 {"command":"...","input":{...}}',
      );
    }
    const envelope = (defaultPayload ? { command: defaultCommand, input: payload } : payload) as
      { command: string; input: Record<string, any> } | undefined;
    const positionalOffset =
      defaultCommand && !commands.has(positionals[0]) && toolboxPage === false ? 0 : 1;
    const commandName =
      envelope?.command ?? (positionalOffset === 0 ? defaultCommand! : (positionals[0] ?? ''));
    const hidden = toolboxPage === 'recovery' || toolboxPage === 'migration';
    const selected = find(commandName, hidden ? false : toolboxPage);
    const command = selected.command;
    const handler =
      toolboxPage === 'recovery'
        ? recoveries.get(commandName)
        : toolboxPage === 'migration'
          ? migrations.get(commandName)
          : selected.handler;
    if (!handler || (toolboxPage === 'recovery' && !context.invocation?.recovery))
      throw new PluginError(
        'PLUGIN_TASK_RECOVERY_UNAVAILABLE',
        'Recovery handler requires a managed recovery attempt',
      );
    if (
      toolboxPage === 'recovery' &&
      context.invocation?.recovery?.declarationHash !==
        pluginRecoverySignature(taskRecovery!.commands[commandName])
    )
      throw new PluginError(
        'PLUGIN_RECOVERY_DECLARATION_CHANGED',
        'Recovery declaration differs from the admitted format',
      );
    const positionalInput = envelope
      ? { ...envelope.input }
      : Object.fromEntries(
          command.registeredArguments
            .map((argument, index) => [
              argument.name(),
              argument.variadic
                ? positionals.slice(index + positionalOffset)
                : positionals[index + positionalOffset],
            ])
            .filter(([, value]) => value !== undefined),
        );
    for (const name of Object.keys(namedInput)) {
      if (Object.hasOwn(positionalInput, name)) {
        throw new PluginError('PLUGIN_INVALID_INPUT', `参数不能重复传入: ${name}`);
      }
    }
    const input = { ...positionalInput, ...namedInput };
    if (
      !envelope &&
      !command.registeredArguments.some(argument => argument.variadic) &&
      positionals.length - positionalOffset > command.registeredArguments.length
    ) {
      throw new PluginError('PLUGIN_INVALID_INPUT', '位置参数过多');
    }
    for (const argument of hidden ? [] : command.registeredArguments) {
      const value = Object.hasOwn(input, argument.name()) ? input[argument.name()] : undefined;
      if (
        argument.required &&
        (value === undefined ||
          value === null ||
          value === '' ||
          (Array.isArray(value) && value.length === 0))
      ) {
        throw new PluginError('PLUGIN_INVALID_INPUT', `缺少必填参数: ${argument.name()}`);
      }
      if (argument.variadic && value !== undefined && !Array.isArray(value)) {
        throw new PluginError('PLUGIN_INVALID_INPUT', `${argument.name()} 必须为数组`);
      }
    }
    if (executing) throw new PluginError('PLUGIN_BUSY', '同一命令实例不能并发执行');
    const signal = context.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const identity =
      context.invocation ??
      createPluginInvocationIdentity(
        pluginName ?? name ?? 'unregistered',
        context.source ?? 'sdk',
        context.parentInvocation,
      );
    const generation = ++invocationGeneration;
    const assertActive = () => {
      if (!executing || generation !== invocationGeneration)
        throw new PluginError('PLUGIN_INVOCATION_ENDED', '命令调用已结束');
      signal.throwIfAborted();
    };
    const commandContext = Object.freeze<PluginCommandContext>({
      identity,
      signal,
      ...(identity.recovery ? { recovery: structuredClone(identity.recovery) } : {}),
      checkpoint: (data, expectedSequence) => {
        assertActive();
        return app.checkpoint(data, expectedSequence);
      },
      ...(identity.page
        ? {
            page: Object.freeze({
              send: (message: unknown, options: { timeoutSec?: number } = {}) => {
                assertActive();
                return app.page('send', {
                  instanceId: identity.page!.instanceId,
                  message,
                  ...(options.timeoutSec !== undefined ? { timeoutSec: options.timeoutSec } : {}),
                });
              },
              get: () => {
                assertActive();
                return app.page('get', { instanceId: identity.page!.instanceId });
              },
            }),
          }
        : {}),
      invoke: (action, payload, options) => {
        assertActive();
        return app.invoke(action, payload, options);
      },
      state: (collection, operation, input) => {
        assertActive();
        return app.state(collection, operation, {
          ...(identity.page ? { instanceId: identity.page.instanceId } : {}),
          ...input,
        });
      },
      model: (request, options) => {
        assertActive();
        return app.model(request, options);
      },
      progress: progress => {
        assertActive();
        app.progress(progress);
      },
    });
    checkpointDeclaration =
      taskRecovery && Object.hasOwn(taskRecovery.commands, commandName)
        ? pluginRecoverySignature(taskRecovery.commands[commandName])
        : undefined;
    executing = true;
    context.onInvocation?.(identity);
    try {
      return await handler(input, commandContext);
    } finally {
      executing = false;
      checkpointDeclaration = undefined;
      context.onInvocation?.(undefined);
    }
  };

  return {
    name,
    setup,
    description,
    defaultCommand,
    toolbox,
    pageRuntime,
    stateStorage,
    taskRecovery,
    appProfiles,
    profileSources,
    version: readPluginVersion(entry),
    commandHelp(namespace: string): string {
      return publicCommands()
        .map(
          ({ command, signature }) =>
            `  ${namespace} ${command.name() === defaultCommand ? signature.slice(defaultCommand.length).trim() : signature}  ${command.description()}`,
        )
        .join('\n');
    },
    help(namespace: string, name?: string): string {
      const selected = name
        ? [find(defaultCommand && !commands.has(name) ? defaultCommand : name)]
        : publicCommands();
      if (!selected.length) {
        const location = toolbox
          ? `请在 Mearl ${toolbox.displayMode === 'popup' ? 'Popup' : '工具箱'} 中打开「${toolbox.title}」使用。`
          : '此插件未提供公开 CLI 命令。';
        return `${namespace} 未提供 CLI 命令。\n${location}`;
      }
      const examples = selected.flatMap(({ examples }) => examples);
      return [
        '用法：',
        ...selected.map(
          ({ command, signature }) =>
            `  ${namespace} ${command.name() === defaultCommand ? signature.slice(defaultCommand.length).trim() : signature}  ${command.description()}`,
        ),
        ...(examples.length
          ? ['', '示例：', ...examples.map(example => `  ${namespace} ${example}`)]
          : []),
      ].join('\n');
    },
    run(
      positionals: string[],
      payload?: unknown,
      namedInput: Record<string, unknown> = {},
    ): Promise<unknown> {
      return run(positionals, payload, namedInput);
    },
    runRuntime(invocation: PluginInvocation): Promise<unknown> {
      return run([], invocation, {}, 'runtime');
    },
    runRecovery(invocation: PluginInvocation): Promise<unknown> {
      return run([], invocation, {}, 'recovery');
    },
    runMigration(invocation: PluginInvocation): Promise<unknown> {
      return run([], invocation, {}, 'migration');
    },
    runToolbox(invocation: PluginInvocation): Promise<unknown> {
      return run([], invocation, {}, true);
    },
  };
}

async function loadRegisteredPluginWithState(
  name: string,
  context: PluginExecutionContext,
  options: PluginInvokeOptions = {},
  state: PluginExecutionState = { stack: [] },
) {
  if (state.stack.includes(name)) {
    throw new PluginError(
      'PLUGIN_INVOCATION_CYCLE',
      `插件调用形成循环: ${[...state.stack, name].join(' -> ')}`,
    );
  }
  let registration = context.resolveRegistration
    ? context.resolveRegistration(name)
    : findPluginRegistration(name);
  if (!registration && findOfficialPlugin(name)) {
    await (context.ensurePlugin ?? ensureOfficialPluginRegistered)(
      name,
      options.onProgress ? message => options.onProgress?.(message) : undefined,
    );
    registration = findPluginRegistration(name);
  }
  if (!registration) {
    throw new PluginError('PLUGIN_NOT_REGISTERED', `插件未注册: ${name}`);
  }
  const { onProgress, signal, source, ...invokeOptions } = options;
  const childState = { stack: [...state.stack, name] };
  let activeInvocation: PluginInvocationIdentity | undefined;
  return loadPlugin(
    registration.entry,
    {
      options: invokeOptions,
      source: source ?? context.source,
      parentInvocation: context.parentInvocation,
      invocation: context.invocation,
      signal,
      runModel: context.runModel,
      onInvocation: identity => {
        activeInvocation = identity;
      },
      progress: onProgress ?? (() => undefined),
      async invoke(action, payload, overrides, progress) {
        const nestedOptions = {
          ...invokeOptions,
          ...overrides,
        };
        if (COMMAND_MAP.has(action) || action === 'connector_list') {
          const result = await context.invoke(action, payload, nestedOptions);
          if (result?.action?.success === false) {
            throw new Error(result.action.error || `${action} failed`);
          }
          return result;
        }
        const pluginInvocation = isPluginInvocation(payload);
        if (findPluginRegistration(action) || findOfficialPlugin(action) || pluginInvocation) {
          if (!pluginInvocation) {
            throw new PluginError(
              'PLUGIN_INVALID_INPUT',
              `调用插件 ${action} 需要 {"command":"...","input":{...}}`,
            );
          }
          if (activeInvocation?.taskId) {
            if (!findPluginRegistration(action) && findOfficialPlugin(action))
              await (context.ensurePlugin ?? ensureOfficialPluginRegistered)(action);
            return context.invoke(
              'plugin_invoke_child',
              { plugin: action, invocation: payload },
              nestedOptions,
            );
          }
          return invokeRegisteredPluginWithState(
            action,
            payload,
            { ...context, invocation: undefined, parentInvocation: activeInvocation },
            {
              ...nestedOptions,
              ...(onProgress ? { onProgress } : {}),
              ...(signal ? { signal } : {}),
              ...(source ? { source } : {}),
            },
            childState,
          );
        }
        const result = await (progress
          ? context.invoke(action, payload, nestedOptions, progress)
          : context.invoke(action, payload, nestedOptions));
        if (result?.action?.success === false) {
          throw new Error(result.action.error || `${action} failed`);
        }
        return result;
      },
    },
    name,
  );
}

export function loadRegisteredPlugin(
  name: string,
  context: PluginExecutionContext,
  options: PluginInvokeOptions = {},
) {
  return loadRegisteredPluginWithState(name, context, options);
}

async function invokeRegisteredPluginWithState(
  name: string,
  invocation: PluginInvocation,
  context: PluginExecutionContext,
  options: PluginInvokeOptions = {},
  state: PluginExecutionState = { stack: [] },
): Promise<unknown> {
  const plugin = await loadRegisteredPluginWithState(name, context, options, state);
  return plugin.run([], invocation);
}

export function invokeRegisteredPlugin(
  name: string,
  invocation: PluginInvocation,
  context: PluginExecutionContext,
  options: PluginInvokeOptions = {},
): Promise<unknown> {
  return invokeRegisteredPluginWithState(name, invocation, context, options);
}

/** Entry point for the native toolbox service; nested plugin calls retain public-command access. */
export async function invokeRegisteredToolboxPlugin(
  name: string,
  invocation: PluginInvocation,
  context: PluginExecutionContext,
  options: PluginInvokeOptions = {},
): Promise<unknown> {
  const plugin = await loadRegisteredPluginWithState(name, context, options);
  return plugin.runToolbox(invocation);
}

export async function invokeRegisteredRuntimePlugin(
  name: string,
  invocation: PluginInvocation,
  context: PluginExecutionContext,
  options: PluginInvokeOptions = {},
): Promise<unknown> {
  const plugin = await loadRegisteredPluginWithState(name, context, options);
  return plugin.runRuntime(invocation);
}

export async function invokeRegisteredRecoveryPlugin(
  name: string,
  invocation: PluginInvocation,
  context: PluginExecutionContext,
  options: PluginInvokeOptions = {},
): Promise<unknown> {
  const plugin = await loadRegisteredPluginWithState(name, context, options);
  return plugin.runRecovery(invocation);
}

export { PluginStateClient } from '../clients/pluginState.js';
export { PluginModelClient } from '../clients/pluginModels.js';
export type * from '@mearl/browser-core';
