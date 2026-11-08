import type {
  AgentChatListSessionsResult,
  AgentChatProviderDescriptor,
  AgentChatSessionSummary,
} from '@mearl/browser-core';
import { Loader2, MessagesSquare } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../../panel/utils/i18n';

interface ConversationPickerProps {
  provider: AgentChatProviderDescriptor;
  currentSessionId?: string;
  disabled: boolean;
  listSessions: (providerId: string, cursor?: string) => Promise<AgentChatListSessionsResult>;
  resumeSession: (session: AgentChatSessionSummary) => Promise<void>;
}

export function ConversationPicker({
  provider,
  currentSessionId,
  disabled,
  listSessions,
  resumeSession,
}: ConversationPickerProps) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<AgentChatSessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setPickerError(null);
      try {
        const result = await listSessions(provider.id, cursor);
        setSessions(current => (cursor ? [...current, ...result.sessions] : result.sessions));
        setNextCursor(result.nextCursor);
      } catch (cause) {
        setPickerError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    },
    [listSessions, provider.id],
  );

  useEffect(() => {
    if (!open) return;
    setSessions([]);
    setNextCursor(undefined);
    setQuery('');
    void load();
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [load, open]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleSessions = normalizedQuery
    ? sessions.filter(session =>
        [session.title, session.cwd, session.providerSessionId].some(value =>
          value?.toLowerCase().includes(normalizedQuery),
        ),
      )
    : sessions;

  const handleSelect = async (selected: AgentChatSessionSummary) => {
    await resumeSession(selected);
    setOpen(false);
  };

  return (
    <div ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        disabled={disabled}
        className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-md text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-secondary cursor-pointer"
        title={t('agentChatConversationHistory')}
        aria-label={t('agentChatConversationHistory')}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <MessagesSquare className="h-[15px] w-[15px] stroke-[1.4]" />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t('agentChatConversationHistory')}
          className="absolute right-2 top-full z-50 mt-1 flex max-h-96 w-[calc(100vw-1rem)] max-w-[22rem] flex-col overflow-hidden rounded-md border border-border bg-bg-primary shadow-lg"
        >
          <div className="border-b border-border p-2">
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={t('agentChatSearchConversations')}
              className="w-full rounded border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-secondary focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {loading && sessions.length === 0 ? (
              <div className="flex items-center justify-center gap-1.5 px-3 py-6 text-xs text-text-secondary">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('agentChatLoadingConversations')}
              </div>
            ) : pickerError ? (
              <div className="px-3 py-4 text-xs text-red-600 dark:text-red-400">
                <div>{pickerError}</div>
                <button
                  type="button"
                  onClick={() => void load()}
                  className="mt-2 text-blue-600 hover:underline cursor-pointer"
                >
                  {t('retry')}
                </button>
              </div>
            ) : visibleSessions.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-text-secondary">
                {t('agentChatNoConversations')}
              </div>
            ) : (
              visibleSessions.map(storedSession => {
                const selected = storedSession.providerSessionId === currentSessionId;
                return (
                  <button
                    key={storedSession.providerSessionId}
                    type="button"
                    onClick={() => void handleSelect(storedSession)}
                    disabled={selected || loading}
                    title={storedSession.providerSessionId}
                    className={`block w-full px-3 py-2 text-left transition-colors disabled:cursor-default ${
                      selected ? 'bg-blue-500/10' : 'hover:bg-bg-hover cursor-pointer'
                    }`}
                  >
                    <div className="truncate text-xs font-medium text-text-primary">
                      {storedSession.title || t('agentChatUntitledConversation')}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-3xs text-text-secondary">
                      {storedSession.cwd ? (
                        <span className="min-w-0 flex-1 truncate">{storedSession.cwd}</span>
                      ) : null}
                      {storedSession.updatedAt ? (
                        <time
                          className="shrink-0"
                          dateTime={new Date(storedSession.updatedAt).toISOString()}
                        >
                          {new Date(storedSession.updatedAt).toLocaleDateString()}
                        </time>
                      ) : null}
                    </div>
                  </button>
                );
              })
            )}
          </div>
          {nextCursor && !pickerError ? (
            <button
              type="button"
              onClick={() => void load(nextCursor)}
              disabled={loading}
              className="border-t border-border px-3 py-2 text-xs text-blue-600 hover:bg-bg-hover cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? t('agentChatLoadingConversations') : t('agentChatLoadMoreConversations')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
