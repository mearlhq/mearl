import { useEffect, useSyncExternalStore } from 'react';
import {
  getBrowserRequestUiState,
  ensureBrowserRequestUiState,
  subscribeBrowserRequestUi,
} from '../utils/browserRequestUiState';

export function useBrowserRequestUi() {
  const value = useSyncExternalStore(subscribeBrowserRequestUi, getBrowserRequestUiState);
  useEffect(() => {
    void ensureBrowserRequestUiState();
  }, []);
  return value;
}
