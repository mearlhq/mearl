import { validatePageElementSelector } from './domSelectors.js';

export type PageWaitMode = 'time' | 'selector' | 'text' | 'condition';
export type PageWaitSelectorState = 'attached' | 'detached' | 'visible' | 'hidden';

export interface PageWaitInput {
  time?: number;
  selector?: string;
  state?: PageWaitSelectorState;
  text?: string;
  exact?: boolean;
  condition?: string;
  timeout?: number;
  interval?: number;
}

export interface ResolvedPageWait {
  mode: PageWaitMode;
  time?: number;
  selector?: string;
  state?: PageWaitSelectorState;
  text?: string;
  exact?: boolean;
  condition?: string;
  timeout: number;
  interval: number;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, minimum), maximum);
}

export function resolvePageWaitInput(input: PageWaitInput): ResolvedPageWait {
  const hasTime = input.time !== undefined;
  const selector = typeof input.selector === 'string' ? input.selector.trim() : '';
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  const condition = typeof input.condition === 'string' ? input.condition.trim() : '';
  const modes = [
    hasTime && 'time',
    selector && 'selector',
    text && 'text',
    condition && 'condition',
  ].filter(Boolean);

  if (modes.length !== 1) {
    throw new Error(
      'page_wait requires exactly one of "time", "selector", "text", or "condition".',
    );
  }

  const timeout = boundedNumber(input.timeout, 10000, 1, 300000);
  const interval = boundedNumber(input.interval, 200, 50, 5000);

  if (input.state !== undefined && !selector) {
    throw new Error('page_wait "state" is only supported with "selector".');
  }
  if (input.exact !== undefined && !text) {
    throw new Error('page_wait "exact" is only supported with "text".');
  }
  if (
    input.state !== undefined &&
    !(['attached', 'detached', 'visible', 'hidden'] as string[]).includes(input.state)
  ) {
    throw new Error('page_wait state must be one of attached, detached, visible, hidden.');
  }

  if (hasTime) {
    const rawTime = input.time;
    if (!Number.isFinite(Number(rawTime)) || Number(rawTime) < 0) {
      throw new Error('page_wait time must be a non-negative number.');
    }
    return {
      mode: 'time',
      time: boundedNumber(rawTime, 0, 0, 60000),
      timeout,
      interval,
    };
  }

  if (selector) {
    validatePageElementSelector(selector, 'page_wait');
    if (selector.startsWith('@') || selector === '$0') {
      throw new Error(
        'page_wait selector must be native CSS because snapshot refs and $0 are point-in-time targets.',
      );
    }
    return {
      mode: 'selector',
      selector,
      state: input.state ?? 'attached',
      timeout,
      interval,
    };
  }
  if (text) {
    return { mode: 'text', text, exact: input.exact ?? false, timeout, interval };
  }
  return { mode: 'condition', condition, timeout, interval };
}

/** Build the bounded page predicate used by both browser backends. */
export function buildPageWaitExpression(options: ResolvedPageWait): string {
  if (options.mode === 'condition') return options.condition!;
  if (options.mode === 'selector') {
    return `(() => {
      const selector = ${JSON.stringify(options.selector)};
      const state = ${JSON.stringify(options.state)};
      let element;
      try { element = document.querySelector(selector); }
      catch (error) { return { __mearlWaitError: 'Invalid CSS selector "' + selector + '": ' + error.message }; }
      if (state === 'attached') return Boolean(element);
      if (state === 'detached') return !element;
      if (!element) return state === 'hidden';
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
        style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
        (!Number.isFinite(Number(style.opacity)) || Number(style.opacity) > 0);
      return state === 'visible' ? visible : !visible;
    })()`;
  }
  return `(() => {
    const expected = ${JSON.stringify(options.text)};
    const exact = ${JSON.stringify(options.exact)};
    const root = document.body || document.documentElement;
    if (!root) return false;
    const normalize = value => String(value == null ? '' : value).trim().replace(/\\s+/g, ' ');
    if (!exact) return normalize(root.innerText != null ? root.innerText : root.textContent).includes(expected);
    const candidates = [root, ...Array.from(root.querySelectorAll('*')).slice(0, 10000)];
    return candidates.some(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' ||
          style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      return normalize(element.innerText != null ? element.innerText : element.textContent) === expected;
    });
  })()`;
}

export function readPageWaitEvaluationError(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const message = (value as { __mearlWaitError?: unknown }).__mearlWaitError;
  return typeof message === 'string' && message ? message : null;
}
