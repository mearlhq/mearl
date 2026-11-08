import type { EnvironmentComponent } from '@mearl/app-profiles';

const revisions = new Map<string, number>();
const queues = new Map<string, Promise<unknown>>();
const unreliable = new Set<string>();
const keyFor = (tabId: number, component: EnvironmentComponent) => `environmentRevision:${tabId}:${component}`;

export async function cleanupEnvironmentRevisions(tabId: number): Promise<void> {
  const keys = (['device', 'app', 'timezone'] as const).map(component => keyFor(tabId, component));
  await Promise.allSettled(keys.flatMap(key => queues.has(key) ? [queues.get(key)!] : []));
  keys.forEach(key => { revisions.delete(key); unreliable.delete(key); });
  await chrome.storage.session.remove(keys);
}

export async function getEnvironmentRevision(tabId: number, component: EnvironmentComponent): Promise<number> {
  const key = keyFor(tabId, component);
  await queues.get(key)?.catch(() => {});
  if (unreliable.has(key) || !chrome.storage?.session)
    throw new Error('ENVIRONMENT_REVISION_UNAVAILABLE');
  const known = revisions.get(key);
  if (known !== undefined) return known;
  const stored = await chrome.storage.session.get(key) ?? {};
  const revision = Number.isSafeInteger(stored[key]) && stored[key] >= 0 ? stored[key] : 0;
  revisions.set(key, revision);
  return revision;
}

/** Ordinary actions keep working if storage fails; cooperative cleanup then fails closed. */
export async function markEnvironmentMutation(tabId: number, component: EnvironmentComponent): Promise<void> {
  const key = keyFor(tabId, component);
  const previous = queues.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    let revision = revisions.get(key);
    if (revision === undefined) {
      const stored = await chrome.storage.session.get(key) ?? {};
      revision = Number.isSafeInteger(stored[key]) && stored[key] >= 0 ? stored[key] : 0;
    }
    const current = revision ?? 0;
    if (current === Number.MAX_SAFE_INTEGER) throw new Error('Environment revision exhausted');
    await chrome.storage.session.set({ [key]: current + 1 });
    revisions.set(key, current + 1);
  });
  queues.set(key, pending);
  try { await pending; } catch {
    unreliable.add(key);
  } finally { if (queues.get(key) === pending) queues.delete(key); }
}
