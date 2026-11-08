import { rmSync } from 'node:fs';
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
import { PluginTaskStore, pluginTaskExecutionUnconfirmed } from './pluginTaskStore.js';

/** Complete uninstall discards execution caches after every plugin has been removed. */
export async function cleanupPluginRuntime(): Promise<void> {
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
  try {
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
    if (store.list().some(pluginTaskExecutionUnconfirmed))
      throw new Error('Plugin execution is not confirmed stopped; task records were retained');
    store.recover(randomUUID());
    if (store.list().some(pluginTaskExecutionUnconfirmed))
      throw new Error('Plugin execution is not confirmed stopped; task records were retained');
    const replacement = readRecord(paths.lease);
    if ((replacement && isProcessOwnerAlive(replacement)) || listPluginNames().length)
      throw new Error('Plugin execution service restarted during cleanup; caches were retained');
    for (const file of [paths.tasks, paths.revisions, paths.log, `${paths.log}.1`])
      rmSync(file, { recursive: true, force: true });
    if (current) removeRecordIfPid(paths.lease, current.pid);
    if (process.platform !== 'win32') rmSync(paths.socket, { force: true });
  } finally {
    removeRecordIfPid(lock, process.pid);
  }
}
