import { requestBrowserSessions } from '../../../shared/browserManager';
import { useCallback, useEffect, useState } from 'react';
import { Bot, ExternalLink, Hand, LoaderCircle, LogOut, Play } from 'lucide-react';
import { clsx } from 'clsx';
import type { ControlSessionInfo } from '@mearl/browser-core';
import { t } from '../../panel/utils/i18n';

type ControlOperation = 'handoff' | 'resume' | 'release';

export function useControlSessions() {
  const [sessions, setSessions] = useState<ControlSessionInfo[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const refresh = useCallback(async () => {
    try {
      const response = await requestBrowserSessions({ operation: 'list' });
      setSessions(response.sessions);
      setError('');
    } catch (failure) {
      setError(String(failure));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const listener = (message: { action?: string }) => {
      if (message.action === 'controlSessionsChanged') void refresh();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [refresh]);
  const update = useCallback(
    async (sessionId: string, operation: ControlOperation) => {
      setBusy(previous => new Set(previous).add(sessionId));
      try {
        await requestBrowserSessions({ sessionId, operation });
        await refresh();
      } catch (failure) {
        setError(String(failure));
      } finally {
        setBusy(previous => {
          const next = new Set(previous);
          next.delete(sessionId);
          return next;
        });
      }
    },
    [refresh],
  );
  const view = useCallback(async (tabId: number) => {
    try {
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (typeof tab.windowId === 'number')
        await chrome.windows.update(tab.windowId, { focused: true });
    } catch (failure) {
      setError(String(failure));
    }
  }, []);
  return { sessions, error, busy, refresh, update, view };
}

interface ControlSessionsProps {
  sessions: ControlSessionInfo[];
  busy: ReadonlySet<string>;
  onUpdate: (sessionId: string, operation: ControlOperation) => Promise<void>;
  onView: (tabId: number) => Promise<void>;
}

export function ControlSessions({ sessions, busy, onUpdate, onView }: ControlSessionsProps) {
  if (!sessions.length) return null;
  return (
    <div className="divide-y divide-border border-t border-border bg-bg-secondary">
      {sessions.map(session => {
        const user = session.status === 'user';
        const disabled = busy.has(session.sessionId) || session.status === 'releasing';
        const tab = session.tabs[0];
        const title = tab?.title || tab?.url || t('controlSessionTask');
        return (
          <div key={session.sessionId} className="px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="flex shrink-0 items-center gap-1 rounded-sm bg-bg-hover px-1.5 py-0.5 text-3xs text-text-secondary">
                  {user ? <Hand className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
                  {user ? t('controlSessionUser') : t('controlSessionAgent')}
                </span>
                {tab && session.transport === 'extension' ? (
                  <button
                    type="button"
                    onClick={() => void onView(tab.tabId)}
                    title={`${t('controlSessionView')}: ${title}`}
                    aria-label={`${t('controlSessionView')}: ${title}`}
                    className="group flex min-w-0 cursor-pointer items-center gap-1 text-2xs text-text-primary transition-colors hover:text-blue-600 dark:hover:text-blue-400"
                  >
                    <span className="truncate">{title}</span>
                    <ExternalLink className="h-3 w-3 shrink-0 text-text-secondary group-hover:text-current" />
                  </button>
                ) : (
                  <span className="truncate text-2xs text-text-primary" title={title}>
                    {title}
                  </span>
                )}
              </div>
              {session.tabs.length > 1 && (
                <span className="shrink-0 text-3xs text-text-secondary">
                  {t('controlSessionPages', String(session.tabs.length))}
                </span>
              )}
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void onUpdate(session.sessionId, user ? 'resume' : 'handoff')}
                  className={clsx(
                    'flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-2xs transition-colors disabled:cursor-wait disabled:opacity-50',
                    user
                      ? 'bg-blue-600 font-medium text-white hover:bg-blue-700'
                      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                  )}
                >
                  {busy.has(session.sessionId) ? (
                    <LoaderCircle className="h-3 w-3 animate-spin" />
                  ) : user ? (
                    <Play className="h-3 w-3" />
                  ) : (
                    <Hand className="h-3 w-3" />
                  )}
                  {user ? t('controlSessionReturn') : t('controlSessionTakeOver')}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  title={t('controlSessionFinish')}
                  aria-label={t('controlSessionFinish')}
                  onClick={() => void onUpdate(session.sessionId, 'release')}
                  className="cursor-pointer rounded p-1 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-wait disabled:opacity-50"
                >
                  <LogOut className="h-3 w-3" />
                </button>
              </div>
            </div>
            {session.reason && (
              <p className="mt-0.5 break-words text-3xs leading-4 text-text-secondary">
                {session.reason}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
