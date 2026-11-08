import { acquireDebuggerLease, type DebuggerLease } from './debuggerSessionManager';

interface PageActivity {
  lease: DebuggerLease;
  enabled: boolean;
}

const activities = new Map<number, PageActivity>();
const queues = new Map<number, Promise<void>>();

/** Focus emulation keeps an explicitly activated page running without focusing its window. */
export async function setBackgroundPageActivity(
  tabId: number,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const previous = queues.get(tabId) ?? Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(async () => {
      let activity = activities.get(tabId);
      if (enabled) {
        signal?.throwIfAborted();
        if (activity?.enabled) return;
        if (!activity) {
          let invalidated = false;
          const lease = await acquireDebuggerLease(tabId, {
            consumer: 'agent-page-activity',
            onInvalidated: () => {
              invalidated = true;
              activities.delete(tabId);
            },
          });
          if (invalidated) {
            await lease.release();
            throw new Error('Background page debugger session was invalidated');
          }
          activity = { lease, enabled: false };
          activities.set(tabId, activity);
        }
        try {
          signal?.throwIfAborted();
          await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', {
            enabled: true,
          });
          if (activities.get(tabId) !== activity) {
            throw new Error('Background page debugger session was invalidated');
          }
          signal?.throwIfAborted();
          activity.enabled = true;
        } catch (error) {
          if (activities.get(tabId) === activity) {
            try {
              await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', {
                enabled: false,
              });
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                'Failed to enable and restore background page activity',
                { cause: cleanupError },
              );
            }
            activities.delete(tabId);
          }
          await activity.lease.release();
          throw error;
        }
      } else if (activity) {
        await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', {
          enabled: false,
        });
        activities.delete(tabId);
        await activity.lease.release();
      }
    });
  queues.set(tabId, operation);
  try {
    await operation;
  } finally {
    if (queues.get(tabId) === operation) queues.delete(tabId);
  }
}

export async function releaseBackgroundPageActivities(): Promise<void> {
  await Promise.allSettled(
    [...new Set([...activities.keys(), ...queues.keys()])].map(tabId =>
      setBackgroundPageActivity(tabId, false),
    ),
  );
}
