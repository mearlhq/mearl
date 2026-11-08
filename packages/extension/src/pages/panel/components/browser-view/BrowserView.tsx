import { sendBrowserDocumentMessage } from '../../../../shared/browserDocument';
import { createBrowserViewTransports } from './transports';
import {
  PROXY_PERMISSION_STORAGE_KEY,
  DISABLED_BUILTIN_ORIGINS_STORAGE_KEY,
  AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY,
} from '../../../../shared/proxyPermissions';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildBrowserViewPage,
  browserUiText,
  type SelectedBrowserView,
} from '@mearl/preset/bundles';
import type { JsonObject } from '@mearl/preset';
import { browserViewPreferenceKey } from '../../../../shared/browserViewPreferences';
import { createBrowserLoginLease } from '../../utils/browserLoginLease';
import { LoginModal } from '../LoginModal';
import { t, getCurrentLanguage } from '../../utils/i18n';
import { showToast } from '../../utils/toast';
import { trackEvent } from '../../../../shared/analytics';
import { copyToClipboard, readFromClipboard } from '../../utils/clipboard';

interface BrowserViewProps {
  selected: SelectedBrowserView;
  isOpen: boolean;
  context: JsonObject;
  keyboardActive?: boolean;
  onAccepted(selected: SelectedBrowserView): void;
  onRefresh(): Promise<void>;
  onCall(method: string, input: any): Promise<unknown>;
}
interface LoginLease {
  id: string;
  close(): Promise<void>;
  definition: NonNullable<SelectedBrowserView['definition']['logins']>[string];
}
interface LoginBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}
function loginBounds(input: unknown): LoginBounds | undefined {
  if (input === undefined || input === null) return;
  const value = input as LoginBounds;
  if (
    !value ||
    ![value.left, value.top, value.width, value.height].every(
      number => typeof number === 'number' && Number.isFinite(number),
    ) ||
    value.left < 0 ||
    value.top < 0 ||
    value.width <= 0 ||
    value.height <= 0 ||
    value.left + value.width > innerWidth + 1 ||
    value.top + value.height > innerHeight + 1
  )
    throw new Error('Invalid browser view login bounds');
  return { left: value.left, top: value.top, width: value.width, height: value.height };
}

function browserViewAppearance() {
  const root = document.documentElement,
    computed = getComputedStyle(root);
  return {
    className: root.className,
    fontSize: computed.fontSize,
    colorScheme: computed.colorScheme,
    variables: Object.fromEntries(
      Array.from(computed)
        .filter(name => name.startsWith('--'))
        .map(name => [name, computed.getPropertyValue(name)]),
    ),
  };
}

export function BrowserView({
  selected,
  isOpen,
  context,
  keyboardActive = true,
  onAccepted,
  onRefresh,
  onCall,
}: BrowserViewProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const channelRef = useRef<MessageChannel | null>(null);
  const contextRef = useRef(context);
  contextRef.current = context;
  const callbackRef = useRef(onCall);
  callbackRef.current = onCall;
  const acceptedRef = useRef(onAccepted);
  acceptedRef.current = onAccepted;
  const cleanupTransportsRef = useRef<() => void>(() => {});
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const keyboardActiveRef = useRef(keyboardActive);
  keyboardActiveRef.current = keyboardActive;
  const cleanupLoginRef = useRef<() => void>(() => {});
  const instanceId = useMemo(
    () => crypto.randomUUID(),
    [selected.bundleId, selected.revision, selected.slot],
  );
  const [visible, setVisible] = useState(isOpen);
  const [login, setLogin] = useState<{
    name: string;
    lease: LoginLease;
    bounds?: LoginBounds;
  } | null>(null);
  const activeLogins = useRef(new Map<string, LoginLease>());
  const loginClosed = useRef(new Map<string, () => void>());
  const [failed, setFailed] = useState('');
  const [attempt, setAttempt] = useState(0);
  const releaseLoginRef = useRef<(name: string) => Promise<void>>(async () => {});
  const locale = getCurrentLanguage();

  useEffect(() => {
    if (isOpen) {
      setVisible(true);
      return;
    }
    cleanupLoginRef.current();
    cleanupTransportsRef.current();
    const timer = setTimeout(() => setVisible(false), 200);
    return () => clearTimeout(timer);
  }, [isOpen]);

  useEffect(() => {
    const frame = frameRef.current!;
    const channel = new MessageChannel();
    channelRef.current = channel;
    let disposed = false,
      connected = false,
      mounted = false;
    setFailed('');
    const startupTimeout = setTimeout(() => {
      if (!disposed && !mounted) {
        console.warn('[BrowserView] Startup timed out', { slot: selected.slot, connected });
        setFailed('Browser view startup timed out');
      }
    }, 15000);
    const preparing = new Map<string, Promise<LoginLease>>();
    const loginPlacements = new Map<string, LoginBounds | undefined>();
    const silentLogins = new Set<() => void>();
    const documentToken = crypto.randomUUID();
    const request = async (operation: string, input: Record<string, unknown> = {}) => {
      const result = await sendBrowserDocumentMessage({
        action: 'browserView',
        data: {
          ...input,
          operation,
          instanceId,
          bundleId: selected.bundleId,
          revision: selected.revision,
          slot: selected.slot,
        },
      });
      if (!result?.success) throw new Error(result?.error || 'Browser view request failed');
      return result.data;
    };
    const transports = createBrowserViewTransports(
      async input => {
        if (!isOpenRef.current) throw new Error('Browser view is closed');
        const policy = await request('transport', { name: input.name, url: input.url });
        if (!isOpenRef.current) throw new Error('Browser view closed while preparing transport');
        return policy;
      },
      event => {
        if (!disposed)
          channel.port1.postMessage({
            type: 'view-event',
            event: { ...event, source: 'transport' },
          });
      },
      selected.definition.transports ?? {},
    );
    const invalidateTransports = () => transports.invalidate();
    cleanupTransportsRef.current = invalidateTransports;
    const transportSettings = new Set(
      Object.values(selected.definition.transports ?? {}).map(value => value.setting),
    );
    const onTransportSettings = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (
        area === 'sync' &&
        Object.keys(changes).some(
          key =>
            transportSettings.has(key) ||
            [
              PROXY_PERMISSION_STORAGE_KEY,
              DISABLED_BUILTIN_ORIGINS_STORAGE_KEY,
              AGENT_ALLOW_ALL_DOMAINS_STORAGE_KEY,
            ].includes(key),
        )
      )
        invalidateTransports();
    };
    chrome.storage.onChanged?.addListener(onTransportSettings);
    chrome.permissions?.onRemoved?.addListener(invalidateTransports);
    const sendContext = () => {
      if (connected && !disposed)
        channel.port1.postMessage({
          type: 'view-context',
          context: { ...contextRef.current, appearance: browserViewAppearance() },
        });
    };
    const closeLease = async (name: string) => {
      const lease = activeLogins.current.get(name);
      if (!lease) return;
      activeLogins.current.delete(name);
      await lease.close();
    };
    releaseLoginRef.current = closeLease;
    const prepareLogin = async (name: string): Promise<LoginLease> => {
      const inFlight = preparing.get(name);
      if (inFlight) return inFlight;
      const existing = activeLogins.current.get(name);
      if (existing) return existing;
      const definition = selected.definition.logins?.[name];
      if (!definition || disposed || contextRef.current.isOpen !== true)
        throw new Error('Browser view login is unavailable');
      const opening = (async () => {
        const id = crypto.randomUUID();
        const connection = createBrowserLoginLease(
          id,
          async () => {
            await request('loginOpen', { login: name, id });
          },
          async () => {
            await request('loginClose', { id });
          },
        );
        const lease = { id, close: connection.close, definition };
        activeLogins.current.set(name, lease);
        try {
          await connection.connect();
          if (
            disposed ||
            activeLogins.current.get(name) !== lease ||
            contextRef.current.isOpen !== true
          )
            throw new Error('Browser view closed');
          return lease;
        } catch (error) {
          if (activeLogins.current.get(name) === lease) activeLogins.current.delete(name);
          await connection.close().catch(() => {});
          throw error;
        }
      })().finally(() => preparing.delete(name));
      preparing.set(name, opening);
      return opening;
    };
    const handleCall = async (method: string, input: any) => {
      if (method === 'mounted') {
        mounted = true;
        clearTimeout(startupTimeout);
        setFailed('');
        return null;
      }
      if (method === 'transport.open') return transports.open(input);
      if (method === 'transport.close') {
        transports.close(input.id);
        return null;
      }
      if (method === 'invoke')
        return request('invoke', { action: input.action, input: input.input });
      if (method === 'preference') {
        const declaration = selected.definition.preferences?.[input.key];
        if (!declaration) throw new Error('Unknown browser view preference');
        if (declaration.area === 'session') {
          sessionStorage.setItem(
            browserViewPreferenceKey(selected, input.key),
            JSON.stringify(input.value),
          );
          return null;
        }
        return request('preferences', { key: input.key, value: input.value });
      }
      if (method === 'toast') {
        showToast(
          String(input.message),
          input.type,
          typeof input.duration === 'number' && Number.isFinite(input.duration) && input.duration >= 0
            ? input.duration
            : undefined,
        );
        return null;
      }
      if (method === 'analytics') {
        await trackEvent(String(input.name), input.params);
        return null;
      }
      if (method === 'clipboard.writeText') return copyToClipboard(String(input.text));
      if (method === 'clipboard.readText') return readFromClipboard();
      if (method === 'openUrl') {
        if (typeof input.url !== 'string') throw new Error('Expected an HTTP(S) link');
        const url = new URL(input.url);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
          throw new Error('Expected an HTTP(S) link without credentials');
        await chrome.tabs.create({ url: url.href, active: input.background !== true });
        return null;
      }
      if (method === 'login.prepare') {
        await prepareLogin(input.name);
        return null;
      }
      if (method === 'login.release') {
        await closeLease(input.name);
        return null;
      }
      if (method === 'login.show') {
        const bounds = loginBounds(input.bounds);
        if (
          typeof input.name !== 'string' ||
          !Object.hasOwn(selected.definition.logins ?? {}, input.name)
        )
          throw new Error('Unknown browser view login');
        loginPlacements.set(input.name, bounds);
        const lease = await prepareLogin(input.name);
        if (
          disposed ||
          contextRef.current.isOpen !== true ||
          activeLogins.current.get(input.name) !== lease
        )
          throw new Error('Browser view login closed');
        return new Promise(resolve => {
          loginClosed.current.set(input.name, () => resolve(null));
          setLogin({ name: input.name, lease, bounds: loginPlacements.get(input.name) });
        });
      }
      if (method === 'login.bounds') {
        const bounds = loginBounds(input.bounds);
        if (
          typeof input.name !== 'string' ||
          !Object.hasOwn(selected.definition.logins ?? {}, input.name)
        )
          throw new Error('Unknown browser view login');
        loginPlacements.set(input.name, bounds);
        setLogin(current =>
          current && current.name === input.name ? { ...current, bounds } : current,
        );
        return null;
      }
      if (method === 'login.hide') {
        loginPlacements.delete(input.name);
        setLogin(null);
        loginClosed.current.get(input.name)?.();
        loginClosed.current.delete(input.name);
        await closeLease(input.name);
        return null;
      }
      if (method === 'login.silent') {
        const lease = await prepareLogin(input.name);
        const iframe = document.createElement('iframe');
        iframe.src = lease.definition.url;
        iframe.style.cssText =
          'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;';
        iframe.sandbox.add(
          'allow-scripts',
          'allow-same-origin',
          'allow-forms',
          'allow-popups',
          'allow-popups-to-escape-sandbox',
        );
        try {
          return await new Promise<boolean>(resolve => {
            let settled = false;
            const cancel = () => finish(false);
            const finish = (loaded: boolean) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              silentLogins.delete(cancel);
              iframe.remove();
              resolve(loaded);
            };
            const timer = setTimeout(
              () => finish(false),
              Math.min(10000, Math.max(1, Number(input.timeoutMs) || 10000)),
            );
            silentLogins.add(cancel);
            iframe.addEventListener('load', () => finish(true), { once: true });
            document.body.append(iframe);
          });
        } finally {
          iframe.remove();
          await closeLease(input.name);
        }
      }
      return callbackRef.current(method, input);
    };
    channel.port1.onmessage = event => {
      const value = event.data;
      if (value?.type === 'view-ready') {
        void request('open')
          .then(() => {
            if (disposed) throw new Error('Browser view closed');
            acceptedRef.current(selected);
            return request('preferences');
          })
          .then(preferences => {
            for (const [key, declaration] of Object.entries(
              selected.definition.preferences ?? {},
            )) {
              if (declaration.area !== 'session') continue;
              const value = sessionStorage.getItem(browserViewPreferenceKey(selected, key));
              if (value !== null) {
                try {
                  preferences[key] = JSON.parse(value);
                } catch {
                  /* Invalid old preferences use the view's default. */
                }
              }
            }
            if (!disposed)
              channel.port1.postMessage({
                type: 'view-init',
                bootstrap: {
                  locale,
                  context: { ...contextRef.current, appearance: browserViewAppearance() },
                  preferences,
                },
              });
          })
          .catch(error => {
            if (!disposed) {
              console.warn('[BrowserView] Initialization failed', selected.slot, error);
              setFailed(error.message);
            }
          });
        return;
      }
      if (
        value?.type !== 'view-call' ||
        !Number.isSafeInteger(value.id) ||
        typeof value.method !== 'string'
      )
        return;
      void handleCall(value.method, value.input ?? {}).then(
        result => {
          if (!disposed)
            channel.port1.postMessage({
              type: 'view-result',
              id: value.id,
              success: true,
              value: result,
            });
        },
        error => {
          if (!disposed)
            channel.port1.postMessage({
              type: 'view-result',
              id: value.id,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
        },
      );
    };
    channel.port1.start();
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      if (event.data?.type === 'mearl-plugin-host-ready' && event.data.context === documentToken)
        frame.contentWindow?.postMessage(
          { type: 'mearl-plugin-load', html: buildBrowserViewPage(selected.html) },
          '*',
        );
      if (event.data?.type === 'mearl-plugin-ready' && !connected) {
        connected = true;
        frame.contentWindow?.postMessage({ type: 'mearl-plugin-connect' }, '*', [channel.port2]);
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        !keyboardActiveRef.current ||
        !contextRef.current.isOpen ||
        loginClosed.current.size
      )
        return;
      if (mounted) channel.port1.postMessage({ type: 'view-key', key: 'Escape' });
      else void callbackRef.current('close', {});
    };
    const observer = new MutationObserver(sendContext);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    });
    const cleanupLogins = () => {
      loginPlacements.clear();
      for (const cancel of silentLogins) cancel();
      setLogin(null);
      for (const name of activeLogins.current.keys()) void closeLease(name).catch(() => {});
      for (const resolve of loginClosed.current.values()) resolve();
      loginClosed.current.clear();
    };
    cleanupLoginRef.current = cleanupLogins;
    window.addEventListener('message', onMessage);
    document.addEventListener('keydown', onEscape);
    frame.src = chrome.runtime.getURL('plugin/sandbox.html') + '?context=' + documentToken;
    return () => {
      disposed = true;
      clearTimeout(startupTimeout);
      transports.dispose();
      chrome.storage.onChanged?.removeListener(onTransportSettings);
      chrome.permissions?.onRemoved?.removeListener(invalidateTransports);
      observer.disconnect();
      window.removeEventListener('message', onMessage);
      document.removeEventListener('keydown', onEscape);
      cleanupLogins();
      channel.port1.postMessage({ type: 'view-close' });
      channel.port1.close();
      channel.port2.close();
      channelRef.current = null;
    };
  }, [selected.bundleId, selected.revision, selected.slot, locale, attempt]);

  useEffect(
    () => () => {
      void sendBrowserDocumentMessage({
          action: 'browserView',
          data: {
            operation: 'close',
            instanceId,
            bundleId: selected.bundleId,
            revision: selected.revision,
            slot: selected.slot,
          },
        })
        .catch(() => {});
    },
    [instanceId],
  );

  useEffect(() => {
    channelRef.current?.port1.postMessage({
      type: 'view-context',
      context: { ...context, appearance: browserViewAppearance() },
    });
  }, [context]);
  const closeLogin = () => {
    const current = login;
    setLogin(null);
    if (current) {
      loginClosed.current.get(current.name)?.();
      loginClosed.current.delete(current.name);
      void releaseLoginRef.current(current.name).catch(() => {});
    }
  };
  return (
    <>
      <iframe
        ref={frameRef}
        title={selected.slot}
        className="fixed inset-0 w-full h-full border-0 z-50"
        style={{ display: visible ? undefined : 'none' }}
      />
      {visible && failed && (
        <div
          role="alert"
          className="fixed inset-0 z-50 flex flex-col gap-3 items-center justify-center bg-bg-primary text-text-primary"
        >
          <p>{t('browserViewUnavailable')}</p>
          <div className="flex gap-2">
            <button
              className="h-8 px-3 rounded border border-border text-text-primary"
              onClick={() => {
                void callbackRef.current('close', {});
              }}
            >
              {t('close')}
            </button>
            <button
              className="h-8 px-3 rounded bg-blue-600 text-white"
              onClick={() => {
                void onRefresh().then(() => setAttempt(value => value + 1));
              }}
            >
              {t('retry')}
            </button>
          </div>
        </div>
      )}
      {login && (
        <div
          style={
            login.bounds
              ? { position: 'fixed', ...login.bounds, transform: 'translateZ(0)', zIndex: 50 }
              : { display: 'contents' }
          }
        >
          <LoginModal
            isOpen
            onClose={closeLogin}
            url={login.lease.definition.url}
            title={browserUiText(login.lease.definition.title, locale)}
            size={login.lease.definition.size}
          />
        </div>
      )}
    </>
  );
}
