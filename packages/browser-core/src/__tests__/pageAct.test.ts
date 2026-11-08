import { describe, expect, it, vi } from 'vitest';
import { PageDialogState } from '../pageDialog.js';
import {
  PageActionDispatchUncertainError,
  PageActionPreconditionError,
  dispatchPairedPageInputCommands,
  runPageAct,
  shouldObservePageAction,
  splitObservedActionPayload,
  type PageActDependencies,
} from '../pageAct.js';

describe('dispatchPairedPageInputCommands', () => {
  it('starts release on the next task without waiting for the press acknowledgement', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      let acknowledgePress!: () => void;
      const result = dispatchPairedPageInputCommands(
        () =>
          new Promise<void>(resolve => {
            calls.push('press');
            acknowledgePress = resolve;
          }),
        async () => {
          calls.push('release');
        },
      );

      expect(calls).toEqual(['press']);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(['press', 'release']);
      acknowledgePress();
      await result;
    } finally {
      vi.useRealTimers();
    }
  });
});

const checkpoint = {
  version: 2,
  url: 'https://example.test/form',
  title: 'Form',
};
const delta = {
  mode: 'delta' as const,
  scope: 'main-document' as const,
  checkpoint: 2,
  version: 3,
  elapsed: 100,
  settledBy: 'quiet' as const,
  url: checkpoint.url,
  title: checkpoint.title,
  changed: true,
  effects: {
    notifications: [],
    interactives: [
      {
        change: 'appeared' as const,
        node: { selector: '#next', tag: 'button', role: 'button', name: 'Next' },
      },
    ],
  },
  mutationCount: 1,
  overflow: false,
  fullSnapshotRecommended: false,
  snapshotReasons: [],
};

function dependencies(overrides: Partial<PageActDependencies> = {}): PageActDependencies {
  const navigationObserver = {
    hasStarted: vi.fn(() => false),
    hasNetworkActivity: vi.fn(() => false),
    waitForStart: vi.fn(async () => false),
    waitForNetworkIdle: vi.fn(),
    waitForResult: vi.fn(),
    getOpenedTabs: vi.fn(async () => []),
    dispose: vi.fn(),
  };
  return {
    startObservation: vi.fn(async () => checkpoint),
    finishObservation: vi.fn(async () => delta),
    startNavigationObserver: vi.fn(async () => navigationObserver as any),
    executeAction: vi.fn(async () => ({ clicked: true })),
    ...overrides,
  };
}

describe('native dialog observation boundaries', () => {
  it('keeps an acknowledged action successful when only observation opens a dialog', async () => {
    const dialogs = new PageDialogState();
    const deps = dependencies({ dialogs, finishObservation: async () => {
      dialogs.opened({ type: 'confirm', message: 'Continue?' });
      return new Promise(() => {});
    } });
    const result = await runPageAct({ action: 'page_click' }, deps);
    expect(result).toMatchObject({ action: { success: true, data: { clicked: true } }, dialog: { type: 'confirm' } });
    expect(result).not.toHaveProperty('observation');
  });

  it('never executes an action behind an already open modal', async () => {
    const dialogs = new PageDialogState();
    dialogs.opened({ type: 'alert', message: 'Read this' });
    const deps = dependencies({ dialogs });
    const result = await runPageAct({ action: 'page_click' }, deps);
    expect(result).toMatchObject({ action: { success: false, stage: 'precondition' }, dialog: { type: 'alert' } });
    expect(deps.startObservation).not.toHaveBeenCalled();
    expect(deps.executeAction).not.toHaveBeenCalled();
  });

  it('does not claim an unacknowledged eval succeeded or replay its continuation', async () => {
    const dialogs = new PageDialogState();
    const continued = vi.fn();
    const deps = dependencies({ dialogs, executeAction: () => dialogs.execute(async () => {
      await dialogs.command(() => {
        dialogs.opened({ type: 'prompt', message: 'Name?' });
        return new Promise(() => {});
      });
      continued();
    }) });
    const result = await runPageAct({ action: 'page_eval' }, deps);
    expect(result).toMatchObject({ action: { success: false, stage: 'dispatch-uncertain' }, dialog: { type: 'prompt' } });
    dialogs.closed();
    expect(continued).not.toHaveBeenCalled();
    await expect(dialogs.execute(async () => 2)).resolves.toBe(2);
  });
});

describe('page_act orchestration', () => {
  it('combines an action with compact same-page effects', async () => {
    const deps = dependencies();
    const result = await runPageAct(
      { action: 'page_click', actionData: { selector: '#submit' } },
      deps,
    );

    expect(result.action).toEqual({
      name: 'page_click',
      success: true,
      data: { clicked: true },
    });
    expect(result.observation).toEqual(
      expect.objectContaining({
        mode: 'delta',
        effects: delta.effects,
      }),
    );
    expect(result.observation).not.toHaveProperty('url');
    expect(result.observation).not.toHaveProperty('title');
    expect(deps.executeAction).toHaveBeenCalledWith('page_click', { selector: '#submit' });
  });

  it.each([
    'page_click',
    'page_drag',
    'page_type',
    'page_hover',
    'page_scroll',
    'page_press',
    'page_upload',
  ])('tracks action-triggered requests for %s', async action => {
    const deps = dependencies();
    await runPageAct({ action }, deps);

    expect(deps.startNavigationObserver).toHaveBeenCalledWith(
      expect.objectContaining({ trackNetwork: true }),
    );
  });

  it('replaces the old-document effects when navigation starts', async () => {
    const navigation = {
      mode: 'navigation' as const,
      urlBefore: checkpoint.url,
      urlAfter: 'https://example.test/results',
      title: 'Results',
      elapsed: 500,
      loaded: true,
      ready: true,
      settledBy: 'network-idle' as const,
      pendingRequests: 0,
      fullSnapshotRecommended: true as const,
      snapshotReasons: ['navigation'] as ['navigation'],
    };
    const dispose = vi.fn();
    const deps = dependencies({
      startNavigationObserver: vi.fn(async () => ({
        hasStarted: () => true,
        hasNetworkActivity: () => true,
        waitForStart: vi.fn(async () => true),
        waitForNetworkIdle: vi.fn(),
        waitForResult: vi.fn(async () => navigation),
        getOpenedTabs: vi.fn(async () => []),
        dispose,
      })),
    });

    const result = await runPageAct(
      { action: 'page_click', actionData: { selector: '#submit' } },
      deps,
    );
    expect(result.observation).toBe(navigation);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('adds directly opened tabs without replacing same-page effects', async () => {
    const openedTabs = [
      {
        tabId: 12,
        openerTabId: 7,
        url: 'https://example.test/results',
        title: 'Results',
        active: false,
        ready: true,
        settledBy: 'load' as const,
      },
    ];
    const deps = dependencies({
      startNavigationObserver: vi.fn(async () => ({
        hasStarted: () => false,
        hasNetworkActivity: () => false,
        waitForStart: vi.fn(async () => false),
        waitForNetworkIdle: vi.fn(),
        waitForResult: vi.fn(),
        getOpenedTabs: vi.fn(async () => openedTabs),
        dispose: vi.fn(),
      })),
    });

    const result = await runPageAct(
      { action: 'page_click', actionData: { tabId: 7, selector: '#results' } },
      deps,
    );

    expect(result.observation).toMatchObject({
      mode: 'delta',
      effects: delta.effects,
      openedTabs,
    });
    expect(deps.startNavigationObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTabId: 7,
        trackOpenedTabs: true,
      }),
    );
  });

  it('only enables opened-tab tracking for actions that can create browsing contexts', async () => {
    const click = dependencies();
    const type = dependencies();
    const evaluate = dependencies();

    await runPageAct({ action: 'page_click' }, click);
    await runPageAct({ action: 'page_type' }, type);
    await runPageAct({ action: 'page_eval' }, evaluate);

    expect(click.startNavigationObserver).toHaveBeenCalledWith(
      expect.objectContaining({ trackOpenedTabs: true }),
    );
    expect(type.startNavigationObserver).toHaveBeenCalledWith(
      expect.objectContaining({ trackOpenedTabs: false }),
    );
    expect(evaluate.startNavigationObserver).toHaveBeenCalledWith(
      expect.objectContaining({ trackOpenedTabs: true }),
    );
  });

  it('returns action failures without losing the observation result', async () => {
    const deps = dependencies({
      executeAction: vi.fn(async () => {
        throw new Error('target detached');
      }),
    });
    const result = await runPageAct(
      { action: 'page_click', actionData: { selector: '#submit' } },
      deps,
    );

    expect(result.action).toEqual({
      name: 'page_click',
      success: false,
      error: 'target detached',
    });
    expect(result.observation).toEqual(
      expect.objectContaining({
        mode: 'delta',
        effects: delta.effects,
      }),
    );
  });

  it('classifies uncertain input dispatches and keeps the observation for verification', async () => {
    const deps = dependencies({
      executeAction: vi.fn(async () => {
        throw new PageActionDispatchUncertainError('mouse press acknowledgement timed out', {
          attempt: {
            requestedTarget: { kind: 'selector', selector: '#submit' },
            effectiveMode: 'mouse',
          },
        });
      }),
    });
    const result = await runPageAct(
      { action: 'page_click', actionData: { selector: '#submit' } },
      deps,
    );

    expect(result.action).toEqual({
      name: 'page_click',
      success: false,
      error: 'mouse press acknowledgement timed out',
      stage: 'dispatch-uncertain',
      attempt: {
        requestedTarget: { kind: 'selector', selector: '#submit' },
        effectiveMode: 'mouse',
      },
    });
    expect(result.observation).toEqual(expect.objectContaining({ mode: 'delta' }));
  });

  it('recovers a detached action when navigation independently started', async () => {
    const navigation = {
      mode: 'navigation' as const,
      urlBefore: 'https://example.test/start',
      urlAfter: 'https://example.test/results',
      title: 'Results',
      elapsed: 120,
      loaded: true,
      ready: true,
      settledBy: 'load' as const,
      pendingRequests: 0,
      fullSnapshotRecommended: true as const,
      snapshotReasons: ['navigation'] as ['navigation'],
    };
    const deps = dependencies({
      executeAction: vi.fn(async () => {
        throw new Error('Detached while handling command.');
      }),
      startNavigationObserver: vi.fn(async () => ({
        hasStarted: () => true,
        hasNetworkActivity: () => false,
        waitForStart: vi.fn(async () => true),
        waitForNetworkIdle: vi.fn(),
        waitForResult: vi.fn(async () => navigation),
        getOpenedTabs: vi.fn(async () => []),
        dispose: vi.fn(),
      })),
    });

    await expect(
      runPageAct({ action: 'page_click', actionData: { selector: '#submit' } }, deps),
    ).resolves.toEqual({
      action: { name: 'page_click', success: true },
      observation: navigation,
    });
  });

  it('uses adapter navigation detection before waiting on the generic tracker', async () => {
    const navigation = {
      mode: 'navigation' as const,
      urlBefore: 'https://example.test/start',
      urlAfter: 'https://example.test/container-layer',
      title: 'Layer',
      elapsed: 50,
      loaded: true,
      ready: true,
      settledBy: 'load' as const,
      pendingRequests: 0,
      fullSnapshotRecommended: true as const,
      snapshotReasons: ['navigation'] as ['navigation'],
    };
    const waitForStart = vi.fn(async () => false);
    const detectNavigation = vi.fn(async () => navigation);
    const deps = dependencies({
      finishObservation: vi.fn(async () => ({
        ...delta,
        settledBy: 'no-change' as const,
        changed: false,
        effects: { notifications: [], interactives: [] },
        mutationCount: 0,
      })),
      detectNavigation,
      startNavigationObserver: vi.fn(async () => ({
        hasStarted: () => false,
        hasNetworkActivity: () => false,
        waitForStart,
        waitForNetworkIdle: vi.fn(),
        waitForResult: vi.fn(),
        getOpenedTabs: vi.fn(async () => []),
        dispose: vi.fn(),
      })),
    });

    const result = await runPageAct(
      { action: 'page_click', actionData: { selector: '#open-layer' } },
      deps,
    );

    expect(result.observation).toEqual(navigation);
    expect(detectNavigation).toHaveBeenCalledWith(checkpoint, 1000);
    expect(waitForStart).not.toHaveBeenCalled();
  });

  it('returns execution preconditions without collecting post-action context', async () => {
    const navigationDispose = vi.fn();
    const disposeObservation = vi.fn();
    const finishObservation = vi.fn(async () => delta);
    const finalizeObservation = vi.fn(async observation => observation);
    const getOpenedTabs = vi.fn(async () => []);
    const deps = dependencies({
      finishObservation,
      finalizeObservation,
      disposeObservation,
      executeAction: vi.fn(async () => {
        throw new PageActionPreconditionError(
          'Ref @e9801 not found. Run page_snapshot first to get fresh refs.',
        );
      }),
      startNavigationObserver: vi.fn(async () => ({
        hasStarted: () => false,
        hasNetworkActivity: () => false,
        waitForStart: vi.fn(async () => false),
        waitForNetworkIdle: vi.fn(),
        waitForResult: vi.fn(),
        getOpenedTabs,
        dispose: navigationDispose,
      })),
    });

    await expect(
      runPageAct({ action: 'page_click', actionData: { selector: '@e9801' } }, deps),
    ).resolves.toEqual({
      action: {
        name: 'page_click',
        success: false,
        error: 'Ref @e9801 not found. Run page_snapshot first to get fresh refs.',
        stage: 'precondition',
      },
    });
    expect(finishObservation).not.toHaveBeenCalled();
    expect(finalizeObservation).not.toHaveBeenCalled();
    expect(getOpenedTabs).not.toHaveBeenCalled();
    expect(navigationDispose).toHaveBeenCalledOnce();
    expect(disposeObservation).toHaveBeenCalledOnce();
  });

  it('releases page observers after the action settles', async () => {
    const disposeObservation = vi.fn();
    await runPageAct(
      { action: 'page_click', actionData: { selector: '#submit' } },
      dependencies({ disposeObservation }),
    );

    expect(disposeObservation).toHaveBeenCalledOnce();
  });

  it('best-effort finalizes the last same-document observation before cleanup', async () => {
    const finalized = {
      ...delta,
      effects: {
        ...delta.effects,
        interactives: [
          {
            ...delta.effects.interactives[0],
            node: { ...delta.effects.interactives[0].node, ref: '@e8' },
          },
        ],
      },
    };
    const finalizeObservation = vi.fn(async () => finalized);
    const disposeObservation = vi.fn();
    const result = await runPageAct(
      { action: 'page_click', actionData: { selector: '#submit' } },
      dependencies({ finalizeObservation, disposeObservation }),
    );

    expect(result.observation).toEqual(
      expect.objectContaining({
        mode: 'delta',
        effects: finalized.effects,
      }),
    );
    expect(result.observation).not.toHaveProperty('url');
    expect(result.observation).not.toHaveProperty('title');
    expect(finalizeObservation).toHaveBeenCalledWith(delta);
    expect(finalizeObservation.mock.invocationCallOrder[0]).toBeLessThan(
      disposeObservation.mock.invocationCallOrder[0],
    );
  });

  it('keeps the observation when finalization fails', async () => {
    const result = await runPageAct(
      { action: 'page_click', actionData: { selector: '#submit' } },
      dependencies({
        finalizeObservation: vi.fn(async () => {
          throw new Error('CDP unavailable');
        }),
      }),
    );

    expect(result.observation).toEqual(
      expect.objectContaining({
        mode: 'delta',
        effects: delta.effects,
      }),
    );
  });

  it('keeps changed same-document page identity while omitting repeated values', async () => {
    const result = await runPageAct(
      { action: 'page_click', actionData: { selector: '#filter' } },
      dependencies({
        finishObservation: vi.fn(async () => ({
          ...delta,
          url: 'https://example.test/form?filter=active',
          title: checkpoint.title,
        })),
      }),
    );

    expect(result.observation).toMatchObject({
      mode: 'delta',
      url: 'https://example.test/form?filter=active',
    });
    expect(result.observation).not.toHaveProperty('title');
  });

  it('keeps unclassified structure fallback even when other effects are available', async () => {
    const classified = await runPageAct(
      { action: 'page_click', actionData: { selector: '#open' } },
      dependencies({
        finishObservation: vi.fn(async () => ({
          ...delta,
          fullSnapshotRecommended: true,
          snapshotReasons: ['unclassified-structure'],
        })),
      }),
    );
    const scrolled = await runPageAct(
      { action: 'page_scroll', actionData: { direction: 'down' } },
      dependencies({
        finishObservation: vi.fn(async () => ({
          ...delta,
          effects: { notifications: [], interactives: [] },
          fullSnapshotRecommended: true,
          snapshotReasons: ['unclassified-structure'],
        })),
      }),
    );

    expect(classified.observation).toMatchObject({
      fullSnapshotRecommended: true,
      snapshotReasons: ['unclassified-structure'],
    });
    expect(scrolled.observation).toMatchObject({
      fullSnapshotRecommended: true,
      snapshotReasons: ['unclassified-structure'],
    });
  });

  it('keeps fallback reasons that still indicate incomplete observation', async () => {
    const result = await runPageAct(
      { action: 'page_scroll', actionData: { direction: 'down' } },
      dependencies({
        finishObservation: vi.fn(async () => ({
          ...delta,
          effects: { notifications: [], interactives: [] },
          overflow: true,
          fullSnapshotRecommended: true,
          snapshotReasons: ['observation-overflow', 'unclassified-structure'],
        })),
      }),
    );

    expect(result.observation).toMatchObject({
      fullSnapshotRecommended: true,
      snapshotReasons: ['observation-overflow', 'unclassified-structure'],
    });
  });

  it('validates the supported action surface once in the shared layer', async () => {
    await expect(runPageAct({ action: 'page_screenshot' }, dependencies())).rejects.toThrow(
      'observed page action must be one of',
    );
  });

  it('routes interactions through explicitly enabled observation or diagnostics', () => {
    expect(shouldObservePageAction('page_eval', undefined)).toBe(false);
    expect(shouldObservePageAction('page_eval', {})).toBe(false);
    expect(shouldObservePageAction('page_eval', { observe: false })).toBe(false);
    expect(shouldObservePageAction('page_eval', { observe: {} })).toBe(true);
    expect(shouldObservePageAction('page_eval', { diagnostics: true })).toBe(true);
    expect(shouldObservePageAction('page_eval', { diagnostics: { logs: true } })).toBe(true);
    expect(shouldObservePageAction('page_click', {})).toBe(true);
    expect(shouldObservePageAction('page_click', { observe: false })).toBe(false);
    expect(shouldObservePageAction('page_click', { observe: false, diagnostics: false })).toBe(
      false,
    );
    expect(
      shouldObservePageAction('page_click', {
        observe: false,
        diagnostics: { requests: true },
      }),
    ).toBe(true);
  });

  it('keeps diagnostics opt-in and page_eval diagnostics observation-free', () => {
    expect(splitObservedActionPayload('page_click', { selector: '#submit' })).toEqual({
      actionData: { selector: '#submit' },
      observe: {},
      diagnostics: undefined,
    });
    expect(
      splitObservedActionPayload('page_click', {
        selector: '#submit',
        diagnostics: true,
      }),
    ).toMatchObject({ diagnostics: { logs: true, requests: true } });
    expect(
      splitObservedActionPayload('page_eval', {
        expression: 'console.error("broken")',
        diagnostics: true,
      }),
    ).toMatchObject({
      actionData: { expression: 'console.error("broken")' },
      observe: false,
      diagnostics: { logs: true, requests: true },
    });
  });
});
