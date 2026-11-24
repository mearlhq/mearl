import { existsSync, realpathSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  claimRecord,
  isProcessOwnerAlive,
  processIdentity,
  readRecord,
  removeInvalidRecord,
  removeRecordIfPid,
} from '@mearl/daemon-core';
import { pluginHostPaths } from './pluginHostPaths.js';
import { listPluginNames } from '../pluginRegistry.js';
import { PluginTaskClient } from '../clients/pluginTasks.js';
import {
  PluginTaskStore,
  pluginTaskExecutionUnconfirmed,
  pluginTaskExecutorAlive,
} from './pluginTaskStore.js';

function assertTaskExecutorsStopped(store: PluginTaskStore): void {
  if (store.list({ allowMissing: true }).some(pluginTaskExecutorAlive))
    throw new Error('Plugin task executors are still running. Stop them and rerun the uninstall.');
}

/** Complete uninstall discards execution caches after every plugin has been removed. */
export async function cleanupPluginRuntime({
  removeData,
  defaultRegistry,
}: { removeData?: () => void; defaultRegistry?: string } = {}): Promise<void> {
  const paths = pluginHostPaths();
  if (listPluginNames().length)
    throw new Error('Registered plugins still use the execution service');
  // The service launcher uses this same claim before creating a replacement host.
  const lock = `${paths.lease}.start`;
  const starter = readRecord(lock);
  if (starter && !isProcessOwnerAlive(starter)) removeRecordIfPid(lock, starter.pid);
  else if (!starter) removeInvalidRecord(lock);
  if (!claimRecord(lock, { pid: process.pid, processIdentity: processIdentity(process.pid) }))
    throw new Error('Plugin execution service is starting; caches were retained');
  let ownedLock = lock;
  try {
    ownedLock = realpathSync(lock);
    const lease = readRecord(paths.lease);
    if (lease && isProcessOwnerAlive(lease)) {
      const client = new PluginTaskClient({ autoStart: false });
      try {
        await client.stopHost();
      } finally {
        client.disconnect();
      }
    }
    const current = readRecord(paths.lease);
    if ((current && isProcessOwnerAlive(current)) || listPluginNames().length)
      throw new Error('Plugin execution service restarted during cleanup; caches were retained');
    const store = new PluginTaskStore();
    if (removeData) {
      assertTaskExecutorsStopped(store);
      if (defaultRegistry && defaultRegistry !== paths.registry) {
        const local = pluginHostPaths(defaultRegistry);
        const service = readRecord(local.lease);
        const starter = readRecord(`${local.lease}.start`);
        if (
          (service && isProcessOwnerAlive(service)) ||
          (starter && starter.pid !== process.pid && isProcessOwnerAlive(starter))
        )
          throw new Error(
            'The default Mearl plugin service is running. Uninstall with the default plugin directory first.',
          );
        assertTaskExecutorsStopped(new PluginTaskStore(local.tasks));
      }
    } else {
      if (store.list().some(pluginTaskExecutionUnconfirmed))
        throw new Error('Plugin execution is not confirmed stopped; task records were retained');
      store.recover(randomUUID());
      if (store.list().some(pluginTaskExecutionUnconfirmed))
        throw new Error('Plugin execution is not confirmed stopped; task records were retained');
    }
    const replacement = readRecord(paths.lease);
    if ((replacement && isProcessOwnerAlive(replacement)) || listPluginNames().length)
      throw new Error('Plugin execution service restarted during cleanup; caches were retained');
    if (current) removeRecordIfPid(paths.lease, current.pid);
    if (process.platform !== 'win32') rmSync(paths.socket, { force: true });
    if (removeData) removeData();
    else
      for (const file of [paths.tasks, paths.revisions, paths.log, `${paths.log}.1`])
        rmSync(file, { recursive: true, force: true });
  } finally {
    if (existsSync(ownedLock)) removeRecordIfPid(ownedLock, process.pid);
  }
}
