import { captureStorageKeys } from '../../shared/browserUiSettings';
import type { PlatformId } from './platforms/types';
import { useCaptureRuntimeState } from './CaptureRuntimeHost';
import type { CaptureProxyConfig } from '../panel/utils/captureProxy';
import { useBrowserUiSettings } from '../panel/utils/browserUiSettings';
import { useMemo, useState } from 'react';
import { BrowserView } from '../panel/components/browser-view/BrowserView';
import { useBrowserView, refreshBrowserView } from '../panel/components/browser-view/viewState';
import { useCaptureIdentity } from '../panel/hooks/useCaptureIdentity';
import { useLocalStorage } from '../panel/hooks/useLocalStorage';
import { useCaptureProxyContext } from './CaptureProxyContext';
import { useCaptureProxyLogin } from './hooks/useCaptureProxyLogin';
import type { SelectedBrowserView } from '@mearl/preset/bundles';
import { Modal, ModalHeader, ModalContent } from '../panel/components/modal';
import { t } from '../panel/utils/i18n';
import { resetSilentLoginState } from '../panel/utils/silentLogin';

interface LauncherModalProps { isOpen: boolean; requestCasesEnabled?: boolean; onClose(): void; platformId: PlatformId; onPlatformChange(id: PlatformId): void }
export function LauncherModal(props: LauncherModalProps) {
  const view = useBrowserView('captureLauncher');
  const { channels } = useCaptureRuntimeState();
  const account = useCaptureIdentity({ lazy: true });
  const storage = captureStorageKeys(useBrowserUiSettings());
  const [allRequestsEnabled] = useLocalStorage<boolean>(storage.allRequests, false, { sync: true });
  const proxy = useCaptureProxyContext();
  const proxyLogin = useCaptureProxyLogin();
  const settings = useBrowserUiSettings();
  const [accepted, setAccepted] = useState<{ selected: SelectedBrowserView } | null>(null);
  const context = useMemo(() => ({
    isOpen: props.isOpen,
    requestCasesEnabled: props.requestCasesEnabled === true,
    proxyLoginOpen: proxyLogin.loginModalOpen,
    platformId: props.platformId,
    allRequestsEnabled,
    identity: { userInfo: account.userInfo, loginRequired: account.loginRequired, loading: account.loading },
    proxy: { activeProxy: proxy.activeProxy ? { ...proxy.activeProxy } : null, loading: proxy.loading, synced: proxy.synced, storageReady: proxy.storageReady, sseUrl: proxy.sseUrl },
  }), [props.isOpen, props.requestCasesEnabled, props.platformId, allRequestsEnabled, proxyLogin.loginModalOpen, account.userInfo, account.loginRequired, account.loading, proxy.activeProxy, proxy.loading, proxy.synced, proxy.storageReady, proxy.sseUrl]);
  if (!props.requestCasesEnabled) return null;
  const selected = accepted ? accepted.selected : view.selected;
  if (!view.loaded || !selected) return <Modal isOpen={props.isOpen} onClose={props.onClose} size="default"><ModalHeader title={t('startCapture')} onClose={props.onClose} /><ModalContent><span aria-busy={!view.loaded}>{view.loaded ? t('browserViewUnavailable') : t('loading')}</span></ModalContent></Modal>;
  if (!props.isOpen && !accepted) return null;
  return <BrowserView selected={selected} isOpen={props.isOpen} context={context} keyboardActive={!proxyLogin.loginModalOpen}
    onAccepted={value => setAccepted(previous => previous ?? { selected: value })}
    onRefresh={async () => { if (!accepted) await refreshBrowserView(); }}
    onCall={async (method, input) => {
      if (method === 'close') return props.onClose();
      if (method === 'platform') {
        if (typeof input.id !== 'string' || !Object.hasOwn(channels, input.id)) throw new Error('Unknown capture platform');
        return props.onPlatformChange(input.id);
      }
      if (method === 'account.fetch') return account.fetchUserInfo({ silent: input.silent === true });
      if (method === 'account.probe') return account.fetchUserInfo({ silent: true, loginProbe: true });
      if (method === 'account.loginClose') return account.closeLoginWindow();
      if (method === 'account.loginComplete') { resetSilentLoginState('capture'); return null; }
      if (method === 'proxy.login.open') return proxyLogin.openLoginWindow();
      if (method === 'proxy.login.close') return proxyLogin.closeLoginWindow();
      if (method === 'proxy.refresh') return proxy.refreshFromServer();
      if (method === 'proxy.acquire') {
        if (typeof input.area !== 'string') throw new Error('Expected a capture area');
        return proxy.acquireProxy(input.area);
      }
      if (method === 'proxy.release') return proxy.releaseProxy();
      if (method === 'proxy.select') {
        const value = input.proxy as CaptureProxyConfig | null;
        if (value !== null && (!value || typeof value.name !== 'string' || !value.name || value.name.length > 256)) throw new Error('Invalid capture proxy');
        await proxy.setActiveProxy(value);
        return null;
      }
      if (method === 'proxy.stream') {
        if (typeof input.url !== 'string') throw new Error('Expected a capture stream');
        await proxy.setSseUrl(input.url);
        return null;
      }
      if (method === 'vpnInstaller') {
        const url = settings.installers?.captureVpnIos;
        if (!url) throw new Error('The configured installer is unavailable');
        await chrome.tabs.create({ url, active: input.background !== true }); return null;
      }
      throw new Error('Unknown capture launcher callback');
    }} />;
}
