import { sendBrowserDocumentMessage } from '../../../shared/browserDocument';
import { useSyncExternalStore } from 'react';
import type { BrowserUiSettings } from '../../../shared/browserUiSettings';
import { createBrowserLoginLease } from './browserLoginLease';

type Definition = NonNullable<BrowserUiSettings['logins']>[string];
interface Snapshot { open: boolean; definition?: Definition }
interface State { snapshot: Snapshot; listeners: Set<() => void>; lease?: Awaited<ReturnType<typeof createBrowserUiLoginLease>>; transition: Promise<unknown> }
const states = new Map<string, State>();
function stateFor(name: string) {
  let value = states.get(name);
  if (!value) { value = { snapshot: { open: false }, listeners: new Set(), transition: Promise.resolve() }; states.set(name, value); }
  return value;
}
export async function createBrowserUiLoginLease(name: string) {
  const id = crypto.randomUUID();
  let definition: Definition | undefined;
  const lease = createBrowserLoginLease(id, async () => {
    // A reconnect retains the accepted URL; a package update applies on the next open.
    if (definition) return;
    const result = await sendBrowserDocumentMessage({ action: 'browserUiService', data: { operation: 'loginOpen', name, id } });
    if (!result?.success || result.data?.id !== id || !result.data?.definition) throw new Error(result?.error || 'Login preparation failed');
    definition = result.data.definition;
  }, async () => {
    const result = await sendBrowserDocumentMessage({ action: 'browserUiService', data: { operation: 'loginClose', id } });
    if (!result?.success) throw new Error(result?.error || 'Login release failed');
  });
  try { await lease.connect(); return { ...lease, definition: definition! }; }
  catch (error) { await lease.close().catch(() => {}); throw error; }
}
export function setBrowserUiLoginOpen(name: string, open: boolean): Promise<void> {
  const state = stateFor(name);
  const change = async () => {
    if (state.snapshot.open === open) return;
    if (open) {
      state.lease = await createBrowserUiLoginLease(name);
      state.snapshot = { open: true, definition: state.lease.definition };
    } else {
      const lease = state.lease; state.lease = undefined;
      state.snapshot = { open: false, definition: state.snapshot.definition };
      for (const listener of state.listeners) listener();
      await lease?.close();
      return;
    }
    for (const listener of state.listeners) listener();
  };
  const pending = state.transition.then(change, change);
  state.transition = pending.catch(() => {});
  return pending;
}
export function useBrowserUiLogin(name: string) {
  const state = stateFor(name);
  return useSyncExternalStore(listener => { state.listeners.add(listener); return () => { state.listeners.delete(listener); }; }, () => state.snapshot);
}
