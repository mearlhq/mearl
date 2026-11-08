import { pluginStateSignature } from '../sdk/pluginStateDefinition.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findPluginRegistration } from '../pluginRegistry.js';
import { pluginHostPaths } from './pluginHostPaths.js';
import { capturePluginRevision } from './pluginRevision.js';
import type { PluginRevision } from './pluginRevision.js';
import { PluginStateStore } from './pluginStateStore.js';
import type { PluginTaskManager, PluginTaskBridge } from './pluginTaskManager.js';
import type { PluginOptions } from '../sdk/plugin.js';
import type { PluginPageTarget } from '@mearl/browser-core';
import type {
  PluginStateDeclaration,
  PluginStateTransaction,
} from '@mearl/browser-core';

export class PluginStateManager {
  readonly store = new PluginStateStore();
  private readonly descriptions = new Map<
    string,
    Promise<{ stateStorage?: PluginStateDeclaration }>
  >();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly controller = new AbortController();
  resolveTarget?: (
    plugin: string,
    instanceId: unknown,
    bridge: PluginTaskBridge,
    options: PluginOptions,
  ) => Promise<{ target: PluginPageTarget; assertActive(): void }>;
  private readonly maintenance: ReturnType<typeof setInterval>;
  constructor(private readonly tasks: PluginTaskManager) {
    this.store.prune();
    this.maintenance = setInterval(() => {
      try {
        this.store.prune();
      } catch (error) {
        console.error('Plugin cache maintenance failed:', error);
      }
    }, 60000);
    this.maintenance.unref();
  }
  async call(
    plugin: string,
    input: Record<string, unknown>,
    bridge: PluginTaskBridge,
    options: PluginOptions = {},
    binding?: { revision: PluginRevision; signal?: AbortSignal; expectedTarget?: PluginPageTarget },
  ): Promise<unknown> {
    this.controller.signal.throwIfAborted();
    binding?.signal?.throwIfAborted();
    if (
      !/^[a-z][a-z0-9_-]*$/.test(plugin) ||
      (bridge.scope.plugin && bridge.scope.plugin !== plugin) ||
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input)
    )
      throw new Error('Invalid plugin state scope');
    const revision = binding?.revision ?? capturePluginRevision(plugin);
    const id = `${revision.installationId}/${revision.revision}`;
    let description = this.descriptions.get(id);
    if (!description) {
      if (this.descriptions.size >= 64)
        this.descriptions.delete(this.descriptions.keys().next().value!);
      const release = this.tasks.pinRevision(revision);
      description = this.tasks
        .describeRevision(revision, this.controller.signal, { cache: true })
        .finally(release);
      this.descriptions.set(id, description);
      this.pending.add(description);
      void description.finally(() => this.pending.delete(description!)).catch(() => {});
      void description.catch(() => {
        if (this.descriptions.get(id) === description) this.descriptions.delete(id);
      });
    }
    const declaration = (await description).stateStorage;
    this.controller.signal.throwIfAborted();
    binding?.signal?.throwIfAborted();
    const name = String(input.collection ?? '');
    const definition =
      declaration && Object.hasOwn(declaration.collections, name)
        ? declaration.collections[name]
        : undefined;
    if (!definition || !/^[a-z][a-z0-9-]{0,63}$/.test(name))
      throw Object.assign(new Error('Plugin state collection is not declared'), {
        code: 'PLUGIN_STATE_NOT_DECLARED',
      });
    if (
      input.expectedDeclaration !== undefined &&
      input.expectedDeclaration !== pluginStateSignature(definition)
    )
      throw Object.assign(new Error('Plugin state declaration changed during command execution'), {
        code: 'PLUGIN_STATE_REVISION_CHANGED',
      });
    let scope: string = definition.scope;
    let assertScope = () => {};
    if (definition.scope === 'host') scope += `:${this.tasks.host.hostId}`;
    if (definition.scope === 'instance' || definition.scope === 'browser-session') {
      if (!this.resolveTarget) throw new Error('Page state scope is unavailable');
      const resolved = await this.resolveTarget(plugin, input.instanceId, bridge, options);
      const target = resolved.target;
      const expected = binding?.expectedTarget;
      if (
        expected &&
        (target.browserSessionId !== expected.browserSessionId ||
          target.tabId !== expected.tabId ||
          target.frameId !== expected.frameId ||
          target.documentId !== expected.documentId)
      )
        throw Object.assign(new Error('State access cannot change the inherited document'), {
          code: 'PLUGIN_PAGE_TARGET_CHANGED',
        });
      assertScope = resolved.assertActive;
      scope +=
        definition.scope === 'instance'
          ? `:${String(input.instanceId)}`
          : `:${target.browserSessionId}`;
    }
    // No await occurs between the final target check and the atomic store operation.
    this.controller.signal.throwIfAborted();
    binding?.signal?.throwIfAborted();
    let installation: { installationId?: string } | undefined;
    try {
      installation = JSON.parse(
        readFileSync(join(pluginHostPaths().installations, `${plugin}.json`), 'utf8'),
      );
    } catch {
      /* Removed installations have no writable state scope. */
    }
    if (!findPluginRegistration(plugin) || installation?.installationId !== revision.installationId)
      throw Object.assign(new Error('Plugin state installation was removed or replaced'), {
        code: 'PLUGIN_STATE_SCOPE_ENDED',
      });
    assertScope();
    const namespace = { installationId: revision.installationId, collection: name, scope };
    switch (input.operation) {
      case 'get':
        return this.store.get(namespace, definition, input.key as string);
      case 'get-many':
        return this.store.getMany(namespace, definition, input.keys);
      case 'list':
        return this.store.list(namespace, definition, input);
      case 'transact':
        return this.store.transact(
          namespace,
          definition,
          input.transaction as PluginStateTransaction,
        );
      default:
        throw new Error('Invalid state operation');
    }
  }
  async close(): Promise<void> {
    clearInterval(this.maintenance);
    this.controller.abort();
    this.descriptions.clear();
    this.store.clearMemory();
    await Promise.allSettled([...this.pending]);
  }
}
