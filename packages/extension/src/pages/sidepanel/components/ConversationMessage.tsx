import { Bot, Info, Wrench } from 'lucide-react';
import { t } from '../../panel/utils/i18n';
import type { CompactChatCard } from '../compactMessages';
import { MarkdownContent } from './MarkdownContent';

interface ConversationMessageProps {
  message: CompactChatCard;
  providerName: string;
}

function messageTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ConversationMessage({ message, providerName }: ConversationMessageProps) {
  const date = new Date(message.timestamp);

  if (message.role === 'user') {
    return (
      <article data-role="user" className="group flex items-end justify-end gap-1.5">
        <time
          dateTime={date.toISOString()}
          title={date.toLocaleString()}
          className="translate-y-0.5 shrink-0 text-3xs leading-4 text-text-secondary opacity-0 transition-opacity group-hover:opacity-100"
        >
          {messageTime(message.timestamp)}
        </time>
        <div className="max-w-[88%]">
          <div className="rounded-2xl rounded-br-md bg-blue-600 px-3 py-2 text-xs leading-5 text-white shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
            <MarkdownContent inverse>{message.message}</MarkdownContent>
          </div>
        </div>
      </article>
    );
  }

  if (message.role === 'assistant') {
    return (
      <article data-role="assistant" className="group flex items-start gap-2">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
          <Bot className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 max-w-[88%] flex-1 has-[[data-chat-visualization]]:max-w-full">
          <div className="mb-1 flex items-center justify-between gap-2 text-3xs leading-4 text-text-secondary">
            <span className="font-medium">{providerName}</span>
            <time
              dateTime={date.toISOString()}
              title={date.toLocaleString()}
              className="translate-y-0.5 opacity-0 transition-opacity group-hover:opacity-100"
            >
              {messageTime(message.timestamp)}
            </time>
          </div>
          <div className="rounded-2xl rounded-tl-md border border-border/70 bg-bg-secondary px-3 py-2 text-xs leading-5 text-text-primary shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
            <MarkdownContent visualizations>{message.message}</MarkdownContent>
          </div>
        </div>
      </article>
    );
  }

  if (message.role === 'preparing') {
    return (
      <article
        data-role="preparing"
        aria-live="polite"
        role="status"
        className="flex items-start gap-2"
      >
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
          <Bot className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 max-w-[88%] flex-1">
          <div className="mb-1 px-px text-3xs font-medium leading-4 text-text-secondary">
            {providerName}
          </div>
          <div className="flex min-h-10 items-center gap-3 rounded-2xl rounded-tl-md border border-blue-500/25 bg-blue-500/[0.04] px-3 py-2">
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-xxs font-semibold leading-4 text-text-primary">
                {message.message}
              </strong>
              <small className="mt-0.5 block truncate text-3xs leading-4 text-text-secondary">
                {t('agentChatStartingProviderDetail')}
              </small>
            </span>
            <span aria-hidden="true" className="flex shrink-0 items-center gap-1 px-0.5">
              <i className="h-1 w-1 animate-agent-chat-dot rounded-full bg-blue-500" />
              <i className="h-1 w-1 animate-agent-chat-dot rounded-full bg-blue-500 [animation-delay:160ms]" />
              <i className="h-1 w-1 animate-agent-chat-dot rounded-full bg-blue-500 [animation-delay:320ms]" />
            </span>
          </div>
        </div>
      </article>
    );
  }

  const presentation =
    message.role === 'thinking'
      ? {
          icon: null,
          className: 'border-blue-500/15 bg-blue-500/[0.04] text-text-secondary',
        }
      : message.role === 'tool'
        ? {
            icon: Wrench,
            className: 'border-border/70 bg-bg-secondary/70 text-text-secondary font-mono',
          }
        : {
            icon: Info,
            className: 'border-amber-500/20 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300',
          };
  const Icon = presentation.icon;
  const thinkingMarker = message.message.startsWith('📋') ? '📋' : '💭';
  const thinkingMessage = message.message.replace(/^(?:💭|📋)\s*/u, '');

  return (
    <article
      data-role={message.role}
      className={`group mx-8 flex items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xxs leading-5 ${presentation.className}`}
    >
      {Icon ? <Icon className="mt-1 h-3 w-3 shrink-0" aria-hidden="true" /> : null}
      {message.role === 'thinking' ? (
        <>
          <span aria-hidden="true" className="shrink-0 leading-5">
            {thinkingMarker}
          </span>
          <div className="min-w-0 flex-1">
            <MarkdownContent>{thinkingMessage}</MarkdownContent>
          </div>
        </>
      ) : (
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {message.message}
        </div>
      )}
      <time
        dateTime={date.toISOString()}
        title={date.toLocaleString()}
        className="shrink-0 text-3xs leading-5 opacity-0 transition-opacity group-hover:opacity-100"
      >
        {messageTime(message.timestamp)}
      </time>
    </article>
  );
}
