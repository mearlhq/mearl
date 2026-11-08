interface PersistentBrowserProcessRecord {
  pid: number;
  hostPid?: number;
  persistent?: boolean;
}

/** Keep restart metadata only when closing a persistent Profile without deleting it. */
export function stoppedPersistentBrowserRecord<T extends PersistentBrowserProcessRecord>(
  record: T,
  deleteProfile: boolean,
): T | null {
  if (deleteProfile || record.persistent !== true) return null;
  const stopped = { ...record, pid: 0 };
  return 'hostPid' in stopped ? { ...stopped, hostPid: 0 } : stopped;
}
