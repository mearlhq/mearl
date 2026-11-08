const PAGE_TIME_STATE_KEY = '__mearlPageTimeOverride__';
const PAGE_TIME_CHANGE_EVENT = 'mearl:page-time-change';

interface PageTimeState {
  NativeDate: DateConstructor;
  nativeNow: () => number;
  MockDate: DateConstructor | null;
  offsetMs: number | null;
  revision: number;
}

const getPageGlobal = () =>
  globalThis as typeof globalThis & Partial<Record<typeof PAGE_TIME_STATE_KEY, PageTimeState>>;

const notifyPageTimeChange = () => window.dispatchEvent(new Event(PAGE_TIME_CHANGE_EVENT));

const getOrCreatePageTimeState = (): PageTimeState => {
  const pageGlobal = getPageGlobal();
  const current = pageGlobal[PAGE_TIME_STATE_KEY];
  if (current) return current;

  const NativeDate = pageGlobal.Date;
  const nativeNow = NativeDate.now.bind(NativeDate);
  const state: PageTimeState = {
    NativeDate,
    nativeNow,
    MockDate: null,
    offsetMs: null,
    revision: -1,
  };
  Object.defineProperty(pageGlobal, PAGE_TIME_STATE_KEY, {
    value: state,
    configurable: true,
  });
  return state;
};

const installPageTime = (offsetMs: number, revision: number) => {
  const pageGlobal = getPageGlobal();
  const state = getOrCreatePageTimeState();
  if (revision < state.revision) return;
  state.offsetMs = offsetMs;
  state.revision = revision;
  let MockDate = state.MockDate;
  if (!MockDate) {
    MockDate = new Proxy(state.NativeDate, {
      apply() {
        return new state.NativeDate(state.nativeNow() + (state.offsetMs ?? 0)).toString();
      },
      construct(target, args, newTarget) {
        return Reflect.construct(
          target,
          args.length === 0 ? [state.nativeNow() + (state.offsetMs ?? 0)] : args,
          newTarget,
        );
      },
      get(target, property, receiver) {
        if (property === 'now') return () => state.nativeNow() + (state.offsetMs ?? 0);
        return Reflect.get(target, property, receiver);
      },
    });
    state.MockDate = MockDate;
  }
  pageGlobal.Date = MockDate;
  notifyPageTimeChange();
};

const restorePageTime = (revision: number) => {
  const pageGlobal = getPageGlobal();
  const state = getOrCreatePageTimeState();
  if (revision < state.revision) return;
  if (state.MockDate && pageGlobal.Date === state.MockDate) pageGlobal.Date = state.NativeDate;
  state.offsetMs = null;
  state.revision = revision;
  notifyPageTimeChange();
};

export const applyPageTimeOverride = (offsetMs: number | null, revision = 0): void => {
  if (!Number.isSafeInteger(revision) || revision < 0) return;
  if (typeof offsetMs === 'number' && Number.isFinite(offsetMs)) {
    installPageTime(offsetMs, revision);
  } else if (offsetMs === null) {
    restorePageTime(revision);
  }
};

/** 接收 ISOLATED content script 转发的时间偏移，并在页面 MAIN world 覆盖 Date。 */
export const listenForPageTimeOverride = () => {
  // document_start 时固定原始时钟，页面后续改写 Date.now 也不会形成代理自调用。
  getOrCreatePageTimeState();
  window.addEventListener('message', event => {
    if (
      event.source !== window ||
      event.data?.source !== 'mearl-content' ||
      event.data?.type !== 'PAGE_TIME_OVERRIDE'
    ) {
      return;
    }
    applyPageTimeOverride(event.data.offsetMs ?? null, event.data.revision ?? 0);
  });
};
