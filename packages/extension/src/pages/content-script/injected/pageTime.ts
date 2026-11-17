import { createPageTimezone } from './pageTimezone';

const PAGE_TIME_STATE_KEY = '__mearlPageTimeOverride__';
const PAGE_TIME_CHANGE_EVENT = 'mearl:page-time-change';

declare global {
  interface Window {
    __mearlApplyPageTimezone__?: (timezone: string, revision: number) => boolean;
  }
}

interface PageTimeState {
  NativeDate: DateConstructor;
  nativeNow: () => number;
  MockDate: DateConstructor | null;
  timezone: ReturnType<typeof createPageTimezone>;
  offsetMs: number | null;
  revision: number;
}

const getPageGlobal = () =>
  globalThis as typeof globalThis & Partial<Record<typeof PAGE_TIME_STATE_KEY, PageTimeState>>;

const notifyPageTimeChange = () => window.dispatchEvent(new Event(PAGE_TIME_CHANGE_EVENT));

const getOrCreatePageTimeState = (): PageTimeState => {
  const pageGlobal = getPageGlobal();
  const current = pageGlobal[PAGE_TIME_STATE_KEY];
  if (current) {
    if (!current.timezone) {
      // A live document may still hold a clock installed before the extension was updated.
      current.timezone = createPageTimezone(current.NativeDate);
      current.MockDate = null;
    }
    return current;
  }

  const NativeDate = pageGlobal.Date;
  const nativeNow = NativeDate.now.bind(NativeDate);
  const state: PageTimeState = {
    NativeDate,
    nativeNow,
    MockDate: null,
    timezone: createPageTimezone(NativeDate),
    offsetMs: null,
    revision: -1,
  };
  Object.defineProperty(pageGlobal, PAGE_TIME_STATE_KEY, {
    value: state,
    configurable: true,
  });
  return state;
};

const refreshDate = (state: PageTimeState) => {
  const pageGlobal = getPageGlobal();
  if (state.offsetMs === null && !state.timezone.active) {
    if (pageGlobal.Date === state.MockDate) pageGlobal.Date = state.NativeDate;
    return;
  }
  let MockDate = state.MockDate;
  if (!MockDate) {
    MockDate = new Proxy(state.NativeDate, {
      apply() {
        return new state.NativeDate(state.nativeNow() + (state.offsetMs ?? 0)).toString();
      },
      construct(target, args, newTarget) {
        let dateArgs = args;
        if (args.length === 0) {
          dateArgs = [state.nativeNow() + (state.offsetMs ?? 0)];
        } else if (state.timezone.active && args.length > 1) {
          dateArgs = [state.timezone.fromWallTime(Reflect.apply(target.UTC, target, args))];
        } else if (state.timezone.active && typeof args[0] === 'string') {
          dateArgs = [state.timezone.parse(args[0])];
        }
        return Reflect.construct(target, dateArgs, newTarget);
      },
      get(target, property, receiver) {
        if (property === 'now') return () => state.nativeNow() + (state.offsetMs ?? 0);
        if (property === 'parse' && state.timezone.active) return state.timezone.parse;
        return Reflect.get(target, property, receiver);
      },
    });
    state.MockDate = MockDate;
  }
  pageGlobal.Date = MockDate;
};

export const applyPageTimeOverride = (offsetMs: number | null, revision = 0): void => {
  if (!Number.isSafeInteger(revision) || revision < 0) return;
  if (offsetMs !== null && !Number.isFinite(offsetMs)) return;
  const state = getOrCreatePageTimeState();
  if (revision < state.revision) return;
  state.offsetMs = offsetMs;
  state.revision = revision;
  refreshDate(state);
  notifyPageTimeChange();
};

/** 接收 ISOLATED content script 转发的时间偏移，并在页面 MAIN world 覆盖 Date。 */
export const listenForPageTimeOverride = () => {
  if (window.__mearlApplyPageTimezone__) return;
  // document_start 时固定原始时钟，页面后续改写 Date.now 也不会形成代理自调用。
  const state = getOrCreatePageTimeState();
  window.__mearlApplyPageTimezone__ = (timezone, revision) => {
    if (!state.timezone.update(timezone, revision)) return false;
    refreshDate(state);
    notifyPageTimeChange();
    return true;
  };
  window.addEventListener('message', event => {
    if (
      event.source !== window ||
      event.data?.source !== 'mearl-content' ||
      !['PAGE_TIME_OVERRIDE', 'PAGE_TIMEZONE_OVERRIDE'].includes(event.data?.type)
    ) {
      return;
    }
    if (event.data.type === 'PAGE_TIME_OVERRIDE') {
      applyPageTimeOverride(event.data.offsetMs ?? null, event.data.revision ?? 0);
    } else if (typeof event.data.timezone === 'string') {
      window.__mearlApplyPageTimezone__?.(event.data.timezone, event.data.revision);
    }
  });
};
