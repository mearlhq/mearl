import {
  BrowserBundleStore,
  selectBrowserView,
  type SelectedBrowserView,
  type BrowserViewSlot,
} from '@mearl/preset/bundles';
import { BROWSER_REQUEST_UI_CHANGED } from '../../../../shared/browserRequestUi';
import { useEffect, useState } from 'react';
import { validateBrowserViewPreferences } from '../../../../shared/browserViewPreferences';

type ViewState = { loaded: boolean; selected?: SelectedBrowserView };
let current: Partial<Record<BrowserViewSlot, ViewState>> = {};
const empty: ViewState = { loaded: false };
let inFlight: Promise<void> | undefined;
const listeners = new Set<() => void>();
let listening = false;
let dirty = false;
export async function refreshBrowserView() {
  if (inFlight) {
    dirty = true;
    return inFlight;
  }
  inFlight = (async () => {
    do {
      dirty = false;
      try {
        const stored = await new BrowserBundleStore({ mearlApiVersion: '1.0.0' }).list();
        if (
          stored.activationError ||
          stored.errors.some(error =>
            Object.hasOwn(stored.activation?.snapshot.bundleRevisions ?? {}, error.id),
          )
        )
          throw new Error('The browser view graph is unavailable');
        current = Object.fromEntries(
          (['requestImport', 'requestCases', 'captureLauncher', 'captureController'] as const).map(
            slot => [
              slot,
              {
                loaded: true,
                selected: validateBrowserViewPreferences(
                  selectBrowserView(stored.bundles, slot, '1.0.0'),
                ),
              },
            ],
          ),
        );
      } catch {
        current = Object.fromEntries(
          (['requestImport', 'requestCases', 'captureLauncher', 'captureController'] as const).map(
            slot => [slot, { ...current[slot], loaded: true }],
          ),
        );
      }
      for (const listener of listeners) listener();
    } while (dirty);
  })().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}
export function useBrowserView(slot: BrowserViewSlot = 'requestImport') {
  const [snapshot, setSnapshot] = useState(current[slot] ?? empty);
  useEffect(() => {
    const listener = () => setSnapshot(current[slot] ?? empty);
    listeners.add(listener);
    if (!listening) {
      listening = true;
      chrome.runtime.onMessage?.addListener(message => {
        if (message?.action === BROWSER_REQUEST_UI_CHANGED) void refreshBrowserView();
      });
    }
    listener();
    if (!current[slot]?.loaded) void refreshBrowserView();
    return () => {
      listeners.delete(listener);
    };
  }, [slot]);
  return snapshot;
}

export function getBrowserViewState(slot: BrowserViewSlot) { return current[slot] ?? empty; }
