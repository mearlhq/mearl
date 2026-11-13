import { isProcessOwnerAlive } from '@mearl/daemon-core';
import { basename } from 'node:path';
import type { PluginModelDiagnostic } from '@mearl/browser-core';
import type {
  PluginDiagnosticFailure,
  PluginDiagnosticOptions,
  PluginDiagnosticPage,
  PluginDiagnosticPageBinding,
  PluginDiagnosticReport,
  PluginDiagnosticTask,
} from '@mearl/browser-core';
import type { PluginTaskRecord } from './pluginTaskStore.js';
import { isPluginTaskId, PLUGIN_TASK_PROTOCOL_VERSION } from '@mearl/browser-core';
import { isPluginPageInstanceId } from '@mearl/browser-core';
import type { PluginTaskScope } from '../pluginTaskProtocol.js';
import type { PluginExecutionHost } from '@mearl/browser-core';

export const MAX_PLUGIN_DIAGNOSTIC_BYTES = 256 * 1024;
function text(value: unknown, maximum = 256): string | undefined {
  if (typeof value !== 'string') return;
  const bytes = Buffer.from(value);
  return bytes.length <= maximum
    ? value
    : bytes
        .subarray(0, maximum)
        .toString('utf8')
        .replace(/\uFFFD$/, '');
}
export function normalizeDiagnosticOptions(value: unknown): PluginDiagnosticOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid diagnostic options');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      key =>
        !['taskId', 'plugin', 'instanceId', 'includeErrorMessages', 'includeLocalPaths'].includes(
          key,
        ),
    )
  )
    throw new Error('Unknown diagnostic option');
  if (input.taskId !== undefined && !isPluginTaskId(input.taskId))
    throw new Error('Invalid diagnostic task ID');
  if (input.instanceId !== undefined && !isPluginPageInstanceId(input.instanceId))
    throw new Error('Invalid diagnostic instance ID');
  if (
    input.plugin !== undefined &&
    (typeof input.plugin !== 'string' ||
      !/^[a-z][a-z0-9_-]*$/.test(input.plugin) ||
      input.plugin.length > 128)
  )
    throw new Error('Invalid diagnostic plugin');
  for (const key of ['includeErrorMessages', 'includeLocalPaths'])
    if (input[key] !== undefined && typeof input[key] !== 'boolean')
      throw new Error('Invalid diagnostic content option');
  return {
    ...(input.taskId ? { taskId: String(input.taskId) } : {}),
    ...(input.plugin ? { plugin: String(input.plugin) } : {}),
    ...(input.instanceId ? { instanceId: String(input.instanceId) } : {}),
    ...(input.includeErrorMessages !== undefined
      ? { includeErrorMessages: input.includeErrorMessages as boolean }
      : {}),
    ...(input.includeLocalPaths !== undefined
      ? { includeLocalPaths: input.includeLocalPaths as boolean }
      : {}),
  };
}
export function diagnosticFailure(
  value: { code?: string; message?: string } | undefined,
  options: PluginDiagnosticOptions,
): PluginDiagnosticFailure | undefined {
  if (!value) return;
  const message = options.includeErrorMessages ? text(value.message, 4096) : undefined;
  return {
    code: text(value.code) ?? 'PLUGIN_ERROR_UNCLASSIFIED',
    ...(message !== undefined
      ? {
          message,
          ...(Buffer.byteLength(value.message ?? '') > 4096 ? { messageTruncated: true } : {}),
        }
      : {}),
  };
}
/** A worker can publish only this small operational vocabulary. */
export function normalizeModelDiagnostic(
  value: unknown,
  previous: PluginModelDiagnostic = {},
): PluginModelDiagnostic {
  const result: PluginModelDiagnostic = { ...previous };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const input = value as Record<string, any>;
  for (const key of ['requestedModel', 'selectedModel', 'activeModel'] as const)
    if (typeof input[key] === 'string') result[key] = text(input[key]);
  if (['apikey', 'chatgpt', 'chatgptAuthTokens', 'unknown'].includes(input.authentication))
    result.authentication = input.authentication;
  for (const key of ['threadRestrictionsAccepted', 'turnRestrictionsAccepted'] as const)
    if (typeof input[key] === 'boolean') result[key] = input[key];
  if (Number.isSafeInteger(input.retryCount) && input.retryCount >= 0)
    result.retryCount = Math.min(input.retryCount, 1000000);
  const runtime = input.runtime;
  if (runtime && ['explicit', 'automatic'].includes(runtime.selection))
    result.runtime = {
      ...(typeof runtime.executable === 'string'
        ? { executable: text(runtime.executable, 4096) }
        : {}),
      ...(typeof runtime.version === 'string' ? { version: text(runtime.version) } : {}),
      selection: runtime.selection,
      ...(typeof runtime.started === 'boolean' ? { started: runtime.started } : {}),
    };
  const config = input.configuration;
  if (
    config &&
    ['default', 'environment'].includes(config.source) &&
    typeof config.filePresent === 'boolean'
  )
    result.configuration = {
      source: config.source,
      filePresent: config.filePresent,
      ...(typeof config.home === 'string' ? { home: text(config.home, 4096) } : {}),
      ...(typeof config.baseProvider === 'string'
        ? { baseProvider: text(config.baseProvider) }
        : {}),
      ...(['file', 'keyring', 'auto', 'ephemeral', 'unknown'].includes(config.credentialStore)
        ? { credentialStore: config.credentialStore }
        : {}),
    };
  return result;
}
export function diagnosticBinding(value: {
  instanceId: string;
  target: { browserSessionId: string; tabId: number; frameId: string | number; documentId: string };
}): PluginDiagnosticPageBinding {
  return {
    instanceId: value.instanceId,
    browserSessionId: value.target.browserSessionId,
    tabId: value.target.tabId,
    frameId: value.target.frameId,
    documentId: value.target.documentId,
  };
}
function modelProjection(
  record: PluginTaskRecord,
  options: PluginDiagnosticOptions,
): PluginModelDiagnostic | undefined {
  if (record.task.kind !== 'model') return;
  const request = record.task.input.request as Record<string, unknown> | undefined;
  const metadata = normalizeModelDiagnostic(
    record.diagnostics?.model,
    typeof request?.model === 'string' ? { requestedModel: text(request.model) } : {},
  );
  if (!options.includeLocalPaths) {
    if (metadata.runtime?.executable)
      metadata.runtime = { ...metadata.runtime, executable: basename(metadata.runtime.executable) };
    if (metadata.configuration) {
      const { home: _home, ...configuration } = metadata.configuration;
      metadata.configuration = configuration;
    }
  }
  return metadata;
}
function taskProjection(
  record: PluginTaskRecord,
  options: PluginDiagnosticOptions,
  observedAt: number,
): PluginDiagnosticTask {
  const { task, diagnostics, execution, executorOwner: owner } = record;
  const events = record.events.filter(event => event.type !== 'progress');
  const first = record.events[0]?.sequence ?? task.sequence + 1;
  const alive = owner && !diagnostics?.executorStoppedAt ? isProcessOwnerAlive(owner) : false;
  const stopped = diagnostics?.executorStoppedAt;
  const state = alive
    ? 'observed-alive'
    : stopped
      ? 'stop-confirmed'
      : diagnostics?.executorAttempted === false
        ? 'never-started'
        : 'unknown';
  const routing = execution?.options;
  return {
    taskId: task.taskId,
    plugin: text(task.plugin)!,
    kind: task.kind ?? 'command',
    command: text(task.command)!,
    state: task.state,
    source: task.source,
    host: { hostId: task.host.hostId, epoch: task.host.epoch },
    installationId: task.installationId,
    revision: task.revision,
    ...(diagnostics?.invocationId ? { invocationId: diagnostics.invocationId } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    sequence: task.sequence,
    ...(diagnostics?.page
      ? {
          page: diagnosticBinding({
            instanceId: diagnostics.page.instanceId,
            target: diagnostics.page,
          }),
        }
      : {}),
    ...(routing
      ? {
          routing: {
            ...(routing.browser ? { browser: text(routing.browser, 1024) } : {}),
            ...(routing.session ? { session: text(routing.session) } : {}),
            ...(routing.connector ? { connector: text(routing.connector) } : {}),
            ...(routing.local !== undefined ? { local: routing.local } : {}),
          },
        }
      : {}),
    ...(execution?.executionTimeoutMs ? { executionTimeoutMs: execution.executionTimeoutMs } : {}),
    executor: {
      state,
      observedAt,
      ...(owner ? { pid: owner.pid } : {}),
      ...(stopped ? { stoppedAt: stopped } : {}),
    },
    ...(task.error ? { failure: diagnosticFailure(task.error, options) } : {}),
    ...(task.checkpoint
      ? {
          checkpoint: {
            sequence: task.checkpoint.sequence,
            version: task.checkpoint.version,
            schemaHash: task.checkpoint.schemaHash,
            updatedAt: task.checkpoint.updatedAt,
          },
        }
      : {}),
    ...(task.result
      ? {
          result: {
            bytes: task.result.bytes,
            chunks: task.result.chunks,
            sha256: task.result.sha256,
          },
        }
      : {}),
    ...(task.kind === 'model' ? { model: modelProjection(record, options) } : {}),
    metadataIncomplete:
      !diagnostics ||
      Boolean(diagnostics.updatesDropped) ||
      (task.kind === 'model' && !diagnostics.model?.runtime),
    history: {
      firstRetainedSequence: first,
      gap: first > 1,
      omitted: Math.max(0, events.length - 8),
      events: events.slice(-8).map(event => ({
        sequence: event.sequence,
        time: event.time,
        state: event.state,
        type: event.type,
      })),
    },
  };
}
export function buildDiagnosticReport(
  host: PluginExecutionHost,
  scope: PluginTaskScope,
  options: PluginDiagnosticOptions,
  scan: { records: PluginTaskRecord[]; limited: boolean },
  snapshots: PluginDiagnosticPage[],
): PluginDiagnosticReport {
  const records = scan.records.filter(
    record =>
      (!scope.plugin || record.task.plugin === scope.plugin) &&
      (scope.access !== 'toolbox' || record.access !== 'public') &&
      (!options.plugin || record.task.plugin === options.plugin) &&
      (!options.instanceId || record.diagnostics?.page?.instanceId === options.instanceId),
  );
  const visible = new Map(records.map(record => [record.task.taskId, record]));
  let selected = records.sort(
    (a, b) => b.task.createdAt - a.task.createdAt || a.task.taskId.localeCompare(b.task.taskId),
  );
  if (options.taskId) {
    if (!visible.has(options.taskId))
      throw Object.assign(new Error('Plugin task was not found'), {
        code: 'PLUGIN_TASK_NOT_FOUND',
      });
    const ids = new Set([options.taskId]),
      pending = [options.taskId];
    while (pending.length) {
      const id = pending.shift()!,
        item = visible.get(id)!;
      const candidates = [
        item.task.parentTaskId,
        item.task.resumedFrom?.taskId,
        ...records
          .filter(
            record => record.task.parentTaskId === id || record.task.resumedFrom?.taskId === id,
          )
          .map(record => record.task.taskId),
      ];
      for (const candidate of candidates)
        if (candidate && visible.has(candidate) && !ids.has(candidate)) {
          ids.add(candidate);
          pending.push(candidate);
        }
    }
    selected = [...ids].map(id => visible.get(id)!);
  }
  const generatedAt = Date.now(),
    chosen = selected.slice(0, 128);
  const tasks = chosen.map(record => taskProjection(record, options, generatedAt));
  const pages = snapshots.filter(
    page =>
      (!scope.plugin || page.plugin === scope.plugin) &&
      (!options.plugin || page.plugin === options.plugin) &&
      (!options.instanceId || page.binding.instanceId === options.instanceId) &&
      (!options.taskId || tasks.some(task => task.page?.instanceId === page.binding.instanceId)),
  );
  for (const task of tasks)
    if (task.page && !pages.some(page => page.binding.instanceId === task.page!.instanceId))
      pages.push({
        plugin: task.plugin,
        installationId: task.installationId,
        revision: task.revision,
        host: task.host,
        binding: task.page,
        observation: 'historical-binding',
      });
  const report: PluginDiagnosticReport = {
    version: 1,
    generatedAt,
    host: { hostId: host.hostId, epoch: host.epoch },
    protocolVersion: PLUGIN_TASK_PROTOCOL_VERSION,
    selection: {
      ...(options.taskId ? { taskId: options.taskId } : {}),
      ...(options.plugin ? { plugin: options.plugin } : {}),
      ...(options.instanceId ? { instanceId: options.instanceId } : {}),
    },
    coverage: {
      scanLimited: scan.limited,
      tasksOmitted: selected.length - tasks.length,
      pagesOmitted: Math.max(0, pages.length - 64),
      byteLimited: false,
    },
    tasks,
    pages: pages.slice(0, 64),
    links: [],
  };
  const links = () => {
    const retained = new Set(report.tasks.map(task => task.taskId));
    report.links = report.tasks.flatMap(task => {
      const record = visible.get(task.taskId)!;
      return (
        [
          ['parent', record.task.parentTaskId],
          ['resume', record.task.resumedFrom?.taskId],
        ] as const
      ).flatMap(([kind, from]) =>
        from && retained.has(from) ? [{ from, to: task.taskId, kind }] : [],
      );
    });
  };
  links();
  while (Buffer.byteLength(JSON.stringify(report)) > MAX_PLUGIN_DIAGNOSTIC_BYTES) {
    report.coverage.byteLimited = true;
    if (report.pages.length) {
      report.pages.pop();
      report.coverage.pagesOmitted++;
    } else {
      report.tasks.pop();
      report.coverage.tasksOmitted++;
      links();
    }
  }
  return report;
}
