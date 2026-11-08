import { PluginTaskManager } from './pluginTaskManager.js';
import type { PluginTaskManagerOptions } from './pluginTaskManager.js';
import { PluginStateManager } from './pluginStateManager.js';
import { PluginPageManager } from './pluginPageManager.js';
import { PluginModelCatalog } from './pluginModelCatalog.js';
import { PluginModelSessions } from './pluginModelSessions.js';
import { dirname, join } from 'node:path';
import { buildDiagnosticReport, normalizeDiagnosticOptions } from './pluginDiagnostics.js';
import type { PluginDiagnosticOptions } from '@mearl/browser-core';
import type { PluginTaskScope } from '../pluginTaskProtocol.js';

/** The host owns service composition; task execution receives explicit service dependencies. */
export class PluginHost {
  readonly tasks: PluginTaskManager;
  readonly state: PluginStateManager;
  readonly pages: PluginPageManager;
  readonly models = new PluginModelCatalog();
  readonly modelSessions: PluginModelSessions;
  private closing?: Promise<void>;

  constructor(configuration: PluginTaskManagerOptions = {}) {
    this.modelSessions = new PluginModelSessions(
      undefined,
      Math.max(2, configuration.modelConcurrency ?? 2),
      configuration.workerPath
        ? join(dirname(configuration.workerPath), 'pluginModelSessionWorker.js')
        : undefined,
    );
    this.tasks = new PluginTaskManager(configuration, {
      state: (...args) => this.state.call(...args),
      page: (...args) => this.pages.call(...args),
      listModels: provider => this.models.list(provider),
      model: (owner, ...args) => this.modelSessions.execute(owner, ...args),
      releaseModels: owner => this.modelSessions.release(owner),
    });
    this.state = new PluginStateManager(this.tasks);
    this.pages = new PluginPageManager(this.tasks, this.state, owner =>
      this.modelSessions.release(owner),
    );
    this.state.resolveTarget = (...args) => this.pages.resolveStateTarget(...args);
  }

  diagnose(value: PluginDiagnosticOptions, scope: PluginTaskScope) {
    const options = normalizeDiagnosticOptions(value);
    if (scope.plugin && options.plugin && scope.plugin !== options.plugin)
      throw Object.assign(new Error('Plugin task was not found'), {
        code: 'PLUGIN_TASK_NOT_FOUND',
      });
    return buildDiagnosticReport(
      this.tasks.host,
      scope,
      options,
      this.tasks.store.diagnosticRecords(options.taskId),
      this.pages.diagnosticSnapshot(),
    );
  }

  close(): Promise<void> {
    this.closing ??= Promise.allSettled([
      this.pages.close(),
      this.tasks.close(),
      this.state.close(),
      this.models.close(),
      this.modelSessions.close(),
    ]).then(results => {
      const failures = results.flatMap(result =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length) throw new AggregateError(failures, 'Plugin host cleanup failed');
    });
    return this.closing;
  }
}
