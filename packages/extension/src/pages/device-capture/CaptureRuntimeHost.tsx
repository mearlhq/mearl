import { sendBrowserDocumentMessage } from '../../shared/browserDocument';
import { parseCaptureState, type CaptureState as State } from './captureState';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CapturedRequest } from '../panel/types';
import type { ConnectionState, ModifyApi, PlatformId } from './platforms/types';
import type { SelectedBrowserView } from '@mearl/preset/bundles';
import { useBrowserView, refreshBrowserView } from '../panel/components/browser-view/viewState';
import { useCaptureIdentity } from '../panel/hooks/useCaptureIdentity';
import { getCurrentLanguage, t } from '../panel/utils/i18n';
import { showToast } from '../panel/utils/toast';
import { trackEvent } from '../../shared/analytics';
import { BROWSER_CONTROLLER_EVENT_TARGET } from '../../shared/browserCapabilityMessages';
import { CaptureProxyContext, type CaptureProxyContextValue } from './CaptureProxyContext';
import type { CaptureProxyConfig } from '../panel/utils/captureProxy';

interface Runtime {
  channels: Record<string, { label: string; supportsModify: boolean; modify: ModifyApi | null; connection: ConnectionState }>;
  subscribe(listener: (request: CapturedRequest) => void): () => void;
}
const CaptureRuntime = createContext<Runtime | null>(null);
interface ProviderProps { platformId: PlatformId; enabled: boolean; children: ReactNode; onPlatformChange?(id: string): void }
function useRequests() {
  const listeners = useRef(new Set<(request: CapturedRequest) => void>());
  return useMemo(() => ({
    emit: (request: CapturedRequest) => { for (const listener of listeners.current) listener(request); },
    subscribe: (listener: (request: CapturedRequest) => void) => { listeners.current.add(listener); return () => { listeners.current.delete(listener); }; },
  }), []);
}
function emptyState(): State {
  return { proxy: { activeProxy: null, loading: true, synced: false, storageReady: false, sseUrl: '' }, channels: {} };
}
function RemoteController({ children, platformId, enabled, selected, onAccepted, onRetry, onPlatformChange }: ProviderProps & { selected: SelectedBrowserView; onAccepted(): void; onRetry(): Promise<void> }) {
  const acceptedCallback = useRef(onAccepted); acceptedCallback.current = onAccepted;
  const requests = useRequests();
  const changePlatform = useRef(onPlatformChange); changePlatform.current = onPlatformChange;
  const account = useCaptureIdentity({ lazy: true });
  const accountRef = useRef(account); accountRef.current = account;
  const [state, setState] = useState<State>(emptyState);
  const [failure, setFailure] = useState('');
  const context = useMemo(() => ({ platformId, enabled, identity: { userInfo: account.userInfo, loading: account.loading, loginRequired: account.loginRequired } }), [platformId, enabled, account.userInfo, account.loading, account.loginRequired]);
  const contextRef = useRef(context); contextRef.current = context;
  const instanceId = useMemo(() => crypto.randomUUID(), [selected.bundleId, selected.revision]);
  const startup = useRef<Promise<unknown>>(Promise.resolve());
  const lifecycle = useRef(0);
  const active = useRef(false);
  const connectLifetime = useRef<() => void>(() => {});
  const request = useCallback(async (operation: string, input: Record<string, unknown> = {}) => {
    const response = await sendBrowserDocumentMessage({ action: 'browserView', data: { ...input, operation, instanceId, bundleId: selected.bundleId, revision: selected.revision, slot: 'captureController' } });
    if (!response?.success) throw new Error(response?.error || 'Browser capture controller failed');
    return response.data;
  }, [instanceId, selected.bundleId, selected.revision]);
  useEffect(() => {
    let disposed = false;
    const generation = ++lifecycle.current;
    active.current = true;
    const onMessage = (message: any, sender: chrome.runtime.MessageSender, sendResponse: (value: unknown) => void) => {
      if (disposed || message?.target !== BROWSER_CONTROLLER_EVENT_TARGET || message.id !== instanceId || sender.id !== chrome.runtime.id || !(sender.url === chrome.runtime.getURL('src/pages/offscreen/index.html') || message.call && sender.documentId === undefined && sender.tab === undefined)) return;
      if (message.event?.type === 'state') {
        let next: State;
        try { next = parseCaptureState(message.event.state); }
        catch (error) { console.warn('[CaptureRuntime] Invalid state', error); setFailure(String(error)); showToast(t('browserCaptureUnavailable'), 'error'); return; }
        setState(next);
        const ids = Object.keys(next.channels);
        if (ids.length && !Object.hasOwn(next.channels, contextRef.current.platformId)) changePlatform.current?.(ids[0]);
        return;
      }
      if (message.event?.type === 'request') { if (!contextRef.current.platformId || message.event.platformId === contextRef.current.platformId) requests.emit(message.event.request); return; }
      if (!message.call) return;
      const operation = async () => {
        const { method, input } = message.call;
        if (method === 'owner.call' && input?.method === 'account.fetch') return accountRef.current.fetchUserInfo({ silent: input.input?.silent === true });
        if (method === 'toast') { showToast(String(input.message), input.type, typeof input.duration === 'number' && input.duration > 0 && input.duration <= 10000 ? input.duration : undefined); return null; }
        if (method === 'analytics') return trackEvent(String(input.name), input.params);
        throw new Error('Unknown capture owner callback');
      };
      void operation().then(data => sendResponse({ success: true, data }), error => sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    };
    chrome.runtime.onMessage.addListener(onMessage);
    let port: chrome.runtime.Port | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (disposed || port) return;
      const connected = chrome.runtime.connect({ name: 'mearl-browser-controller:' + instanceId });
      port = connected;
      connected.onDisconnect.addListener(() => {
        if (port !== connected) return;
        port = undefined;
        if (!disposed) timer = setTimeout(connect, 300);
      });
    };
    connectLifetime.current = connect;
    const starting = request('controllerStart', { bootstrap: { locale: getCurrentLanguage(), context: contextRef.current } });
    startup.current = starting;
    void starting.then(() => { if (!disposed) { acceptedCallback.current(); setFailure(''); connect(); } }, error => { if (!disposed) { console.warn('[CaptureRuntime] Startup failed', error); setFailure(String(error.message || error)); showToast(t('browserCaptureUnavailable'), 'error'); void refreshBrowserView(); } });
    return () => {
      disposed = true;
      active.current = false;
      connectLifetime.current = () => {};
      clearTimeout(timer);
      port?.disconnect();
      chrome.runtime.onMessage.removeListener(onMessage);
      const stopping = startup.current;
      queueMicrotask(() => {
        if (lifecycle.current !== generation) return;
        void stopping.catch(() => {}).then(() => request('controllerClose')).catch(console.warn);
      });
    };
  }, [instanceId, request, requests]);
  useEffect(() => {
    void startup.current.then(() => request('controllerContext', { context })).catch(() => {});
  }, [context, request]);
  const command = useCallback(async (method: string, input: Record<string, unknown> = {}) => {
    const generation = lifecycle.current;
    const starting = startup.current;
    try { await starting; } catch {
      if (!active.current) throw new Error('Capture page closed');
      if (startup.current === starting) startup.current = request('controllerStart', { bootstrap: { locale: getCurrentLanguage(), context: contextRef.current } });
      await startup.current;
      if (!active.current || lifecycle.current !== generation) throw new Error('Capture page closed');
      acceptedCallback.current();
      setFailure('');
      connectLifetime.current();
    }
    if (!active.current || lifecycle.current !== generation) throw new Error('Capture page closed');
    return request('controllerCommand', { method: 'command', input: { method, input } });
  }, [request]);
  const runtime = useMemo<Runtime>(() => {
    const channels = Object.fromEntries(Object.entries(state.channels).map(([id, channel]) => {
      const modify: ModifyApi | null = channel.supportsModify ? {
        apiOverrides: new Map(channel.overrides),
        prepareOverride: async request => { await command(id + '.prepareOverride', { request }); },
        setOverride: async (request, modifiedData) => { await command(id + '.setOverride', { request, modifiedData }); },
        removeOverride: async request => { await command(id + '.removeOverride', { request }); },
        removeAllOverrides: async () => { await command(id + '.removeAllOverrides'); },
        ...(channel.onlineMocks ? {
          onlineMocks: channel.onlineMocks,
          refreshOnlineMocks: async () => { await command(id + '.refreshOnlineMocks'); },
          cleanOnlineMock: async (apiUrl: string) => { await command(id + '.cleanOnlineMock', { apiUrl }); },
        } : {}),
      } : null;
      const connection: ConnectionState = { ...channel.connection, ...(failure ? { status: 'error', errorMessage: failure } : {}),
        reconnect: () => { void command(id + '.reconnect').catch(console.warn); },
        disconnect: () => { void command(id + '.disconnect').catch(console.warn); },
      };
      return [id, { label: channel.label, supportsModify: channel.supportsModify, modify, connection }];
    }));
    return { channels, subscribe: requests.subscribe };
  }, [state, command, requests, failure]);
  const proxy = useMemo<CaptureProxyContextValue>(() => ({ ...state.proxy,
    refreshFromServer: async () => { await command('proxy.refresh'); },
    acquireProxy: area => command('proxy.acquire', { area }), releaseProxy: () => command('proxy.release'),
    setActiveProxy: async (proxy: CaptureProxyConfig | null) => { await command('proxy.select', { proxy }); },
    setSseUrl: async (url: string) => { await command('proxy.stream', { url }); },
  }), [state.proxy, command]);
  return <CaptureProxyContext.Provider value={proxy}><CaptureRuntime.Provider value={runtime}>{children}{failure && <div role="alert" className="fixed bottom-3 left-3 right-3 z-50 flex items-center justify-between gap-3 rounded border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary"><span>{t('browserCaptureUnavailable')}</span><button className="h-7 rounded bg-blue-600 px-3 text-white" onClick={() => { void onRetry().catch(console.warn); }}>{t('retry')}</button></div>}</CaptureRuntime.Provider></CaptureProxyContext.Provider>;
}

/** Each page accepts one implementation; updates never replace a live session's resource owner. */
export function CaptureRuntimeProvider(props: ProviderProps) {
  const view = useBrowserView('captureController');
  const accepted = useRef<{ selected?: SelectedBrowserView } | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  if (!accepted.current && !view.loaded) return null;
  const selected = accepted.current ? accepted.current.selected : view.selected;
  if (selected) return <RemoteController key={selected.bundleId + ':' + selected.revision + ':' + attempt} {...props} selected={selected} onAccepted={() => { accepted.current ??= { selected }; }} onRetry={async () => { await refreshBrowserView(); setAttempt(value => value + 1); }} />;
  return <div role="alert" className="flex h-full items-center justify-center gap-3 text-xs text-text-primary"><span>{t('browserCaptureUnavailable')}</span><button className="h-7 rounded bg-blue-600 px-3 text-white" onClick={() => { void refreshBrowserView().catch(console.warn); }}>{t('retry')}</button></div>;
}
export function useCaptureRuntime(onMessage: (request: CapturedRequest) => void) {
  const value = useContext(CaptureRuntime);
  if (!value) throw new Error('Capture runtime is unavailable');
  const callback = useRef(onMessage); callback.current = onMessage;
  useEffect(() => value.subscribe(request => callback.current(request)), [value.subscribe]);
  return value;
}
export function useCaptureRuntimeState() {
  const value = useContext(CaptureRuntime);
  if (!value) throw new Error('Capture runtime is unavailable');
  return value;
}
