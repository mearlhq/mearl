import { useEffect, useSyncExternalStore } from 'react';
import {
  ensureBrowserUiSettings,
  getBrowserAppProfiles,
  getBrowserControl,
  getBrowserUiSettings,
  getSetupManagement,
  subscribeBrowserUiSettings,
} from '../../../shared/browserUiSettingsClient';

export * from '../../../shared/browserUiSettingsClient';

export function useBrowserUiSettings() {
  const value = useSyncExternalStore(subscribeBrowserUiSettings, getBrowserUiSettings);
  useEffect(() => {
    void ensureBrowserUiSettings().catch(console.warn);
  }, []);
  return value;
}

export function useSetupManagement() {
  useBrowserUiSettings();
  return getSetupManagement();
}

export function useBrowserControl(_text: (key: string) => string) {
  useBrowserUiSettings();
  return getBrowserControl();
}

export function useBrowserAppProfiles() {
  useBrowserUiSettings();
  return getBrowserAppProfiles();
}
