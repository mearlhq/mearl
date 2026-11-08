import { readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { cleanupPluginRuntime, pluginDirectory } from '@mearl/client/plugin';
import {
  isProcessOwnerAlive,
  listRecordFiles,
  pruneOrphanLogs,
  readRecord,
  removeRecordIfPid,
} from '@mearl/daemon-core';

/** User state, browser profiles and CDP tab-ID counters survive uninstall. */
export async function cleanupUninstalledRuntime(): Promise<void> {
  await cleanupPluginRuntime();
  const root = join(homedir(), '.mearl');
  if (resolve(pluginDirectory()) !== resolve(join(root, 'plugins'))) return;
  if (listRecordFiles(join(root, 'providers/installed')).length)
    throw new Error('Registered Providers still use runtime caches; caches were retained');
  for (const directory of ['providers/live', 'providers/starting']) {
    if (
      listRecordFiles(join(root, directory)).some(file => {
        const record = readRecord(file);
        return record && isProcessOwnerAlive(record);
      })
    )
      throw new Error('Providers still use runtime caches; caches were retained');
  }
  pruneOrphanLogs(join(root, 'managed-browsers'), 0);
  pruneOrphanLogs(join(root, 'providers/logs'), 0);
  let entries;
  try {
    entries = readdirSync(join(root, 'plugin-pages'), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{16}\.json\.d$/.test(entry.name)) continue;
    for (const file of listRecordFiles(join(root, 'plugin-pages', entry.name))) {
      if (!/^session-[a-f0-9]{16}\.json$/.test(basename(file))) continue;
      const record = readRecord(file);
      if (record && !isProcessOwnerAlive(record)) removeRecordIfPid(file, record.pid);
    }
  }
}
