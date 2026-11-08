import { createContext, useContext } from 'react';
import type { CaptureProxyConfig, CaptureProxyResult } from '../panel/utils/captureProxy';
export interface CaptureProxyContextValue {
  activeProxy: CaptureProxyConfig | null;
  loading: boolean; synced: boolean; storageReady: boolean; sseUrl: string;
  refreshFromServer(): Promise<void>;
  acquireProxy(area: string): Promise<CaptureProxyResult>;
  releaseProxy(): Promise<CaptureProxyResult>;
  setActiveProxy(proxy: CaptureProxyConfig | null): Promise<void>;
  setSseUrl(url: string): Promise<void>;
}
export const CaptureProxyContext = createContext<CaptureProxyContextValue | null>(null);
export function useCaptureProxyContext() {
  const value = useContext(CaptureProxyContext);
  if (!value) throw new Error('Capture proxy runtime is unavailable');
  return value;
}
