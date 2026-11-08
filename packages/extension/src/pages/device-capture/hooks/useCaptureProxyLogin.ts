import { useCallback } from 'react';
import { setBrowserUiLoginOpen, useBrowserUiLogin } from '../../panel/utils/browserUiLogin';

export function useCaptureProxyLogin() {
  const login = useBrowserUiLogin('captureProxy');
  const openLoginWindow = useCallback(() => setBrowserUiLoginOpen('captureProxy', true), []);
  const closeLoginWindow = useCallback(() => { void setBrowserUiLoginOpen('captureProxy', false).catch(console.warn); }, []);
  return { loginModalOpen: login.open, loginDefinition: login.definition, openLoginWindow, closeLoginWindow };
}
