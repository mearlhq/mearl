import {
  extensionRpcErrorCode,
  type AgentSkillInstallOptions,
  type ToolboxPluginTool,
} from '@mearl/browser-core';
import { toolboxSkillSource } from '../../shared/toolboxCatalog';
import type {
  ToolboxInstallJob,
  ToolboxInstallQueueEvent,
  ToolboxInstallQueueState,
} from '../../shared/toolboxInstallQueue';

export function createToolboxInstallQueue(
  install: (options: AgentSkillInstallOptions) => Promise<unknown>,
  list: () => Promise<{ tools: ToolboxPluginTool[] }>,
) {
  const ports = new Set<chrome.runtime.Port>();
  const pending: ToolboxInstallJob[] = [];
  let active: ToolboxInstallJob | undefined;

  const send = (port: chrome.runtime.Port, event: ToolboxInstallQueueEvent) => {
    try {
      port.postMessage(event);
    } catch {
      ports.delete(port);
    }
  };
  const publish = (event: ToolboxInstallQueueEvent) => {
    for (const port of ports) send(port, event);
  };
  const snapshot = (): ToolboxInstallQueueState => ({
    type: 'queue',
    installing: active?.id ?? null,
    queued: pending.map(job => job.id),
  });

  // Keep installation and its list refresh together so the next job sees the current registry.
  async function drain() {
    if (active) return;
    while ((active = pending.shift())) {
      const job = active;
      publish(snapshot());
      let stage: 'install' | 'list' = 'install';
      try {
        await install({
          providerId: 'codex',
          source: toolboxSkillSource(job.repository),
          name: job.skill,
          scope: 'global',
        });
        stage = 'list';
        const { tools } = await list();
        publish({ type: 'installed', job, tools });
      } catch (cause) {
        publish({
          type: 'failed',
          job,
          error: cause instanceof Error ? cause.message : String(cause),
          code: extensionRpcErrorCode(cause),
          stage,
        });
      }
    }
    publish(snapshot());
  }

  return (port: chrome.runtime.Port) => {
    ports.add(port);
    send(port, snapshot());
    port.onDisconnect.addListener(() => ports.delete(port));
    port.onMessage.addListener((job: ToolboxInstallJob | undefined) => {
      if (
        !job ||
        [job.id, job.plugin, job.repository, job.skill, job.title].some(
          value => typeof value !== 'string' || !value,
        )
      ) {
        return;
      }
      if (active?.id === job.id || pending.some(candidate => candidate.id === job.id)) return;
      pending.push(job);
      if (active) publish(snapshot());
      else void drain();
    });
  };
}
