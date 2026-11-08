import {
  BrowserBundleStore,
  selectBrowserRequestUi,
  type BrowserRequestUi,
  type SelectedBrowserRequestUi,
} from '@mearl/preset/bundles';
import {
  BROWSER_REQUEST_UI_ACTION,
  BROWSER_REQUEST_UI_CHANGED,
} from '../../../shared/browserRequestUi';
import { validateRequestUiSetting } from '../../../shared/browserRequestUiValidation';

interface RequestUiState {
  selected: SelectedBrowserRequestUi | null;
  definition: BrowserRequestUi | null;
}
let snapshot: RequestUiState = { selected: null, definition: null };
const store = new BrowserBundleStore({ mearlApiVersion: '1.0.0' });
let inFlight: Promise<RequestUiState> | undefined;
let listening = false;
let loaded = false;
let dirty = false;
const listeners = new Set<() => void>();
export function getBrowserRequestUiState() {
  return snapshot;
}
export function refreshBrowserRequestUiState(): Promise<RequestUiState> {
  if (inFlight) {
    dirty = true;
    return inFlight;
  }
  const refresh = async () => {
    try {
      const current = await store.list();
      if (
        current.activationError ||
        current.errors.some(error =>
          Object.hasOwn(current.activation?.snapshot.bundleRevisions ?? {}, error.id),
        )
      )
        throw new Error('The selected browser UI is unavailable');
      const selected = selectBrowserRequestUi(current.bundles, '1.0.0') ?? null;
      if (selected) validateRequestUiSetting(selected.definition);
      loaded = true;
      if (selected?.revision !== snapshot.selected?.revision) {
        snapshot = { selected, definition: selected?.definition ?? null };
        for (const listener of listeners) listener();
      }
    } catch {
      /* A failed refresh retains the currently rendered definition and drafts. */
    }
    return snapshot;
  };
  inFlight = (async () => {
    do {
      dirty = false;
      await refresh();
    } while (dirty);
    return snapshot;
  })().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}
export function ensureBrowserRequestUiState() {
  return loaded ? Promise.resolve(snapshot) : inFlight ?? refreshBrowserRequestUiState();
}
export function subscribeBrowserRequestUi(listener: () => void) {
  listeners.add(listener);
  if (!listening) {
    listening = true;
    chrome.runtime.onMessage?.addListener(message => {
      if (message?.action === BROWSER_REQUEST_UI_CHANGED) void refreshBrowserRequestUiState();
    });
  }
  return () => {
    listeners.delete(listener);
  };
}
export async function updateBrowserRequestUiPreference(enabled: boolean): Promise<void> {
  const response = await chrome.runtime.sendMessage({
    action: BROWSER_REQUEST_UI_ACTION,
    data: { operation: 'preference', revision: snapshot.selected?.revision ?? null, enabled },
  });
  if (!response?.success) {
    await refreshBrowserRequestUiState();
    throw new Error(response?.error || 'Failed to save service preference');
  }
}
