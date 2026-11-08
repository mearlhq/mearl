import type { PageNavigateParams } from './browserActionProtocol.js';

export type PageHistoryDirection = 'back' | 'forward';

export type ResolvedPageNavigateInput =
  | { mode: 'url'; url: string }
  | { mode: 'refresh' }
  | { mode: 'history'; history: PageHistoryDirection };

/**
 * Normalizes page_navigate consistently across extension and native CDP
 * transports. URL navigation, reload, and history traversal are mutually
 * exclusive so a caller cannot accidentally trigger a different operation.
 */
export function resolvePageNavigateInput(data: PageNavigateParams): ResolvedPageNavigateInput {
  const url = typeof data.url === 'string' ? data.url.trim() : '';
  const refresh = data.refresh === true;
  const history = data.history;

  if (history !== undefined && history !== 'back' && history !== 'forward') {
    throw new Error('page_navigate: "history" must be one of back, forward');
  }

  const modes = [
    url.length > 0 ? 'url' : undefined,
    refresh ? 'refresh' : undefined,
    history !== undefined ? 'history' : undefined,
  ].filter(Boolean);

  if (modes.length === 0) {
    throw new Error(
      'page_navigate: provide exactly one of a non-empty "url", refresh:true, or history:"back"|"forward"',
    );
  }
  if (modes.length > 1) {
    throw new Error(`page_navigate: provide exactly one navigation mode — got ${modes.join(', ')}`);
  }

  if (url.length > 0) return { mode: 'url', url };
  if (refresh) return { mode: 'refresh' };
  return { mode: 'history', history: history as PageHistoryDirection };
}
