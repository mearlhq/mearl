import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ControlSessionRegistry } from '../control-session.js';
import { ControlSessionManager } from '../control-session-manager.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

describe('control sessions', () => {
  it('returns state on ordinary calls and the owned page inventory on handoff', async () => {
    const business = { refs: { record: 'value' }, session: { tabs: [99] } };
    const manager = new ControlSessionManager({
      browserId: () => 'browser',
      transport: () => 'extension',
      invoke: vi.fn(async () => ({ tabId: 1, tabs: [{ tabId: 1 }], result: business })),
      cleanup: vi.fn(async () => {}),
      download: vi.fn(),
      notify: vi.fn(),
    });
    try {
      const opened = await manager.invoke('tab_open', {}, 'new');
      const id = opened.session.sessionId;
      expect(opened.session).toEqual(manager.registry.state(id));
      expect(opened.session).not.toHaveProperty('tabs');
      for (const action of [
        'page_snapshot',
        'page_screenshot',
        'page_eval',
        'get_requests',
        'get_logs',
        'get_events',
        'tab_list',
      ]) {
        const result = await manager.invoke(action, { tabId: 1 }, id);
        expect(result.session).toEqual(manager.registry.state(id));
        expect(result.session).not.toHaveProperty('tabs');
        expect(result.result).toBe(business);
        expect(result.tabs).toEqual([{ tabId: 1 }]);
      }
      const handoff = await manager.invoke('browser_control', { operation: 'handoff' }, id);
      expect(handoff.session).toMatchObject({
        status: 'user',
        tabs: [{ tabId: 1, source: 'attached' }],
      });
      expect(opened.session.status).toBe('active');
      const released = await manager.invoke('browser_release', {}, id);
      expect(released.session).toEqual(manager.registry.state(id));
      expect(released.session.status).toBe('released');
      expect(released.session).not.toHaveProperty('tabs');
      expect(released.affectedTabIds).toEqual([1]);
    } finally {
      await manager.artifacts.dispose();
    }
  });

  it('allows runtime acknowledgement and cancellation while another operation holds the tab or browser queue', async () => {
    const registry = new ControlSessionRegistry(() => 'browser');
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    let started!: () => void;
    const running = new Promise<void>(resolve => {
      started = resolve;
    });
    const gesture = registry.run(undefined, 'page_click', { tabId: 1 }, async () => {
      started();
      await blocked;
    });
    await running;
    const opening = registry.run(undefined, 'tab_open', {}, async () => {});
    let acknowledged = false;
    const acknowledgement = registry.run(
      undefined,
      'page_runtime',
      { tabId: 1, operation: 'get' },
      async () => {
        acknowledged = true;
      },
    );
    try {
      await vi.waitFor(() => expect(acknowledged).toBe(true));
    } finally {
      release();
      await Promise.all([gesture, opening, acknowledgement]);
    }
    expect(
      await registry.run(undefined, 'page_runtime', { tabId: 1, operation: 'send' }, async () =>
        registry.run(
          undefined,
          'page_runtime',
          { tabId: 1, operation: 'cancel' },
          async () => 'cancelled',
        ),
      ),
    ).toBe('cancelled');
  });

  it('preserves session ownership and handoff checks for concurrent runtime transport', async () => {
    const registry = new ControlSessionRegistry(() => 'browser');
    const owner = registry.create('extension');
    registry.claim(owner.sessionId, 1, 'attached');
    const operation = vi.fn(async () => null);
    await expect(
      registry.run(undefined, 'page_runtime', { tabId: 1, operation: 'get' }, operation),
    ).rejects.toThrow('TAB_CONTROLLED_BY_SESSION');
    registry.handoff(owner.sessionId);
    await expect(
      registry.run(owner.sessionId, 'page_runtime', { tabId: 1, operation: 'cancel' }, operation),
    ).rejects.toThrow('CONTROL_SESSION_PAUSED');
    expect(operation).not.toHaveBeenCalled();
  });
  it('retries generated ids without replacing an existing session', () => {
    vi.mocked(randomBytes)
      .mockImplementationOnce(() => Buffer.alloc(6, 1))
      .mockImplementationOnce(() => Buffer.alloc(6, 1))
      .mockImplementationOnce(() => Buffer.alloc(6, 2));
    const registry = new ControlSessionRegistry(() => 'browser');
    const first = registry.create('extension');
    const second = registry.create('cdp');
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(registry.info(first.sessionId)).toEqual(first);
    expect(registry.info(second.sessionId)).toEqual(second);
  });

  it('resolves short ids only while the owning host and browser identity exist', async () => {
    let browserId = 'browser-a';
    const registry = new ControlSessionRegistry(() => browserId);
    const session = registry.create('cdp');
    expect(session.sessionId).toMatch(/^s_[A-Za-z0-9_-]{8}$/);
    expect(registry.find(session.sessionId)).toEqual(session);
    expect(registry.find('s_00000000')).toBeUndefined();
    registry.handoff(session.sessionId);
    expect(registry.find(session.sessionId)?.status).toBe('user');
    await registry.release(session.sessionId, {}, async () => {});
    expect(registry.find(session.sessionId)?.status).toBe('released');
    browserId = 'browser-b';
    expect(registry.find(session.sessionId)).toBeUndefined();
    expect(new ControlSessionRegistry(() => 'browser-a').find(session.sessionId)).toBeUndefined();
  });

  it('rejects extension session actions after disconnection while preserving the session', async () => {
    let transport: 'extension' | 'cdp' = 'extension';
    const invoke = vi.fn(async () => ({ tabId: 1, opened: true }));
    const download = vi.fn();
    const manager = new ControlSessionManager({
      browserId: () => 'browser',
      transport: () => transport,
      invoke,
      cleanup: vi.fn(async () => {}),
      download,
      notify: vi.fn(),
    });
    try {
      const opened = await manager.invoke('tab_open', {}, 'new');
      transport = 'cdp';
      await expect(
        manager.invoke('page_snapshot', { tabId: 1 }, opened.session.sessionId),
      ).rejects.toThrow('CONTROL_SESSION_TRANSPORT_UNAVAILABLE');
      await expect(
        manager.invoke(
          'page_download',
          { tabId: 1, trigger: { selector: '#download' } },
          opened.session.sessionId,
        ),
      ).rejects.toThrow('CONTROL_SESSION_TRANSPORT_UNAVAILABLE');
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(download).not.toHaveBeenCalled();
      expect(manager.registry.info(opened.session.sessionId).transport).toBe('extension');
      transport = 'extension';
      await manager.invoke('page_snapshot', { tabId: 1 }, opened.session.sessionId);
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally {
      await manager.artifacts.dispose();
    }
  });

  it('owns pages opened by download clicks and includes them in scoped release', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mearl-control-download-'));
    const filePath = path.join(directory, 'result.csv');
    await writeFile(filePath, 'result');
    const cleanup = vi.fn(async () => {});
    const invoke = vi.fn(async () => ({ tabId: 1, opened: true }));
    const manager = new ControlSessionManager({
      browserId: () => 'browser',
      transport: () => 'extension',
      invoke,
      cleanup,
      download: vi.fn(async () => ({
        filename: 'result.csv',
        filePath,
        action: { observation: { openedTabs: [{ tabId: 2 }] } },
      })),
      notify: vi.fn(),
    });
    try {
      const opened = await manager.invoke('tab_open', {}, 'new');
      const result = await manager.invoke(
        'page_download',
        { tabId: 1, trigger: { selector: '#download' } },
        opened.session.sessionId,
      );
      expect(result.session).not.toHaveProperty('tabs');
      expect(manager.registry.info(result.session.sessionId).tabs).toContainEqual({
        tabId: 2,
        source: 'created',
      });
      await expect(manager.invoke('page_snapshot', { tabId: 2 })).rejects.toThrow(
        'TAB_CONTROLLED_BY_SESSION',
      );
      await manager.invoke('browser_release', { closeCreatedTabs: true }, opened.session.sessionId);
      expect(cleanup).toHaveBeenCalledWith([1, 2], 'extension', true);
      expect(invoke).toHaveBeenCalledWith('tab_close', { tabId: 2 }, 'extension');
    } finally {
      await manager.artifacts.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('queues new session pages behind in-flight shared resource changes', async () => {
    const registry = new ControlSessionRegistry(() => 'browser');
    let finish!: () => void;
    const cookie = registry.run(
      undefined,
      'set_cookie',
      { url: 'https://example.com' },
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    const session = registry.create('cdp');
    const snapshot = vi.fn(async () => {});
    const page = registry.run(session.sessionId, 'page_snapshot', { tabId: 1 }, snapshot);
    await Promise.resolve();
    expect(snapshot).not.toHaveBeenCalled();
    finish();
    await cookie;
    await page;
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it.each(['send_request'])(
    'allows %s with concurrent sessions, including unscoped calls and batches',
    async action => {
      for (const transport of ['extension', 'cdp', 'provider'] as const) {
        const registry = new ControlSessionRegistry(() => 'browser');
        const first = registry.create(transport);
        const second = registry.create(transport);
        const data = { url: 'https://example.com/api', method: 'POST', api: 'mtop.example' };
        const operation = vi.fn(async () => ({ success: true }));
        for (const id of [first.sessionId, second.sessionId, undefined]) {
          await expect(registry.run(id, action, data, operation, transport)).resolves.toEqual({
            success: true,
          });
          await expect(
            registry.run(id, 'run_actions', { actions: [{ action, data }] }, operation, transport),
          ).resolves.toEqual({ success: true });
        }
        expect(operation).toHaveBeenCalledTimes(6);
      }
    },
  );

  it.each(['send_request'])(
    'runs %s independently of other requests and page operations',
    async action => {
      const registry = new ControlSessionRegistry(() => 'browser');
      const first = registry.create('extension');
      const second = registry.create('extension');
      let finish!: () => void;
      const operation = vi.fn(
        () =>
          new Promise<void>(resolve => {
            finish = resolve;
          }),
      );
      const pending = registry.run(first.sessionId, action, {}, operation);
      void pending.catch(() => {});
      try {
        await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
        await registry.run(second.sessionId, action, {}, async () => {});
        await registry.run(second.sessionId, 'page_snapshot', { tabId: 2 }, async () => {});
      } finally {
        finish?.();
        await pending;
      }
    },
  );

  it.each(['set_rule', 'set_cookie'])(
    'keeps %s protected across sessions and batches',
    async action => {
      const registry = new ControlSessionRegistry(() => 'browser');
      const first = registry.create('extension');
      registry.create('extension');
      const operation = vi.fn(async () => {});
      for (const id of [first.sessionId, undefined]) {
        await expect(registry.run(id, action, {}, operation)).rejects.toThrow(
          'BROWSER_RESOURCE_CONFLICT',
        );
        await expect(
          registry.run(id, 'run_actions', { actions: [{ action, data: {} }] }, operation),
        ).rejects.toThrow('BROWSER_RESOURCE_CONFLICT');
      }
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it.each(['send_request'])(
    'waits for unscoped %s before releasing the browser',
    async action => {
      const registry = new ControlSessionRegistry(() => 'browser');
      let finish!: () => void;
      const request = registry.run(
        undefined,
        action,
        {},
        () =>
          new Promise<void>(resolve => {
            finish = resolve;
          }),
      );
      await Promise.resolve();
      const cleanup = vi.fn(async () => {});
      const release = registry.releaseBrowser(cleanup);
      try {
        await Promise.resolve();
        expect(cleanup).not.toHaveBeenCalled();
      } finally {
        finish();
        await request;
        await release;
      }
      expect(cleanup).toHaveBeenCalledOnce();
    },
  );

  it('waits for browser-wide changes before releasing and permits independent app profiles', async () => {
    const registry = new ControlSessionRegistry(() => 'browser');
    let finish!: () => void;
    const rule = registry.run(
      undefined,
      'set_rule',
      {},
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    const cleanup = vi.fn(async () => {});
    const release = registry.releaseBrowser(cleanup);
    await Promise.resolve();
    expect(cleanup).not.toHaveBeenCalled();
    finish();
    await rule;
    await release;
    const first = registry.create('extension');
    registry.create('extension');
    await registry.run(
      first.sessionId,
      'set_app_profile',
      { tabId: 1, enabled: true },
      async () => {},
    );
    await expect(
      registry.run(
        first.sessionId,
        'set_app_profile',
        { tabId: 1, enabled: true, networkControl: { id: 'environment', value: 'pre' } },
        async () => {},
      ),
    ).rejects.toThrow('BROWSER_RESOURCE_CONFLICT');
    await registry.run(
      first.sessionId,
      'set_app_profile',
      { tabId: 1, enabled: true, networkControl: { id: 'environment', value: 'pre' } },
      async () => {},
      'cdp',
    );
  });

  it('validates resume before cleanup and prevents concurrent lifecycle transitions', async () => {
    const cleanup = vi.fn(async () => {});
    const manager = new ControlSessionManager({
      browserId: () => 'browser',
      transport: () => 'cdp',
      invoke: vi.fn(async () => ({ tabId: 1, opened: true })),
      cleanup,
      download: vi.fn(),
      notify: vi.fn(),
    });
    const opened = await manager.invoke('tab_open', {}, 'new');
    const id = opened.session.sessionId;
    await expect(manager.invoke('browser_control', { operation: 'resume' }, id)).rejects.toThrow(
      'not waiting',
    );
    expect(cleanup).not.toHaveBeenCalled();
    manager.registry.handoff(id);
    let finish!: () => void;
    cleanup.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    const resume = manager.userControl(id, 'resume');
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
    await expect(manager.userControl(id, 'resume')).rejects.toThrow('CONTROL_SESSION_RESUMING');
    await expect(manager.invoke('browser_release', {}, id)).rejects.toThrow(
      'CONTROL_SESSION_RESUMING',
    );
    expect(manager.registry.info(id).status).toBe('user');
    finish();
    await resume;
    expect(manager.registry.info(id).status).toBe('active');
    await manager.artifacts.dispose();
  });

  it('keeps scoped batch boundaries, failure evidence and ownership for newly opened pages', async () => {
    const invoke = vi.fn(async (action: string, data: any) => {
      if (action === 'tab_open') return { tabId: 1, opened: true };
      const step = data.actions[0];
      if (step.action === 'tab_open') {
        expect(step.data.__mearlBlockedTabIds).toEqual([9]);
        return {
          results: [
            { step: 0, action: 'tab_open', success: true, data: { tabId: 2, opened: true } },
          ],
        };
      }
      return {
        results: [
          {
            step: 0,
            action: step.action,
            success: false,
            error: 'uncertain',
            stage: 'dispatch-uncertain',
            attempt: { sent: true },
          },
        ],
      };
    });
    const manager = new ControlSessionManager({
      browserId: () => 'browser',
      transport: () => 'extension',
      invoke,
      cleanup: vi.fn(async () => {}),
      download: vi.fn(),
      notify: vi.fn(),
    });
    const opened = await manager.invoke('tab_open', {}, 'new');
    const id = opened.session.sessionId;
    const other = manager.registry.create('extension');
    manager.registry.claim(other.sessionId, 9, 'attached');
    const unsupported = await manager.invoke(
      'run_actions',
      { tabId: 1, actions: [{ action: 'agent_chat_run' }] },
      id,
    );
    expect(unsupported).toMatchObject({
      completedSteps: 0,
      failedStep: 0,
      error: expect.stringContaining('unsupported'),
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    const batch = await manager.invoke(
      'run_actions',
      {
        tabId: 1,
        actions: [
          { action: 'tab_open', data: { url: 'https://example.com' } },
          { action: 'page_click' },
        ],
      },
      id,
    );
    expect(batch).toMatchObject({
      completedSteps: 1,
      failedStep: 1,
      stage: 'dispatch-uncertain',
      attempt: { sent: true },
      results: [
        { step: 0, success: true },
        { step: 1, success: false, error: 'uncertain' },
      ],
    });
    expect(batch.session).not.toHaveProperty('tabs');
    expect(manager.registry.info(batch.session.sessionId).tabs).toContainEqual({
      tabId: 2,
      source: 'created',
    });
    expect(invoke.mock.calls.slice(1).map(call => call[0])).toEqual(['run_actions', 'run_actions']);
    await manager.artifacts.dispose();
  });

  it('preserves legacy batches that open pages without a session', async () => {
    const invoke = vi.fn(async () => ({ completedSteps: 2 }));
    const manager = new ControlSessionManager({
      browserId: () => 'browser',
      transport: () => 'cdp',
      invoke,
      cleanup: vi.fn(async () => {}),
      download: vi.fn(),
      notify: vi.fn(),
    });
    const actions = [
      { action: 'tab_open', data: { url: 'https://example.com' } },
      { action: 'page_snapshot', data: { tabId: 1 } },
    ];
    await expect(manager.invoke('run_actions', { tabId: 1, actions })).resolves.toEqual({
      completedSteps: 2,
    });
    expect(invoke).toHaveBeenCalledWith('run_actions', expect.objectContaining({ actions }), 'cdp');
    await manager.artifacts.dispose();
  });

  it('protects sessions against browser-wide operations nested in legacy batches', async () => {
    const registry = new ControlSessionRegistry(() => 'browser');
    registry.create('cdp');
    const operation = vi.fn(async () => {});
    for (const action of ['tab_open', 'browser_close']) {
      await expect(
        registry.run(undefined, 'run_actions', { actions: [{ action, data: {} }] }, operation),
      ).rejects.toThrow('ACTIVE_CONTROL_SESSIONS');
    }
    await expect(
      registry.run(
        undefined,
        'run_actions',
        { actions: [{ action: 'set_rule', data: {} }] },
        operation,
      ),
    ).rejects.toThrow('BROWSER_RESOURCE_CONFLICT');
    expect(operation).not.toHaveBeenCalled();
  });

  it('protects attached pages and records reused tab_open results accurately', async () => {
    const registry = new ControlSessionRegistry(() => 'browser');
    const first = registry.create('extension');
    const second = registry.create('extension');
    registry.recordResult(first.sessionId, 'tab_open', { tabId: 10, opened: false, reused: true });
    registry.recordResult(first.sessionId, 'tab_open', { tabId: 11, opened: true });
    await expect(
      registry.run(second.sessionId, 'page_click', { tabId: 10 }, async () => {}),
    ).rejects.toThrow('TAB_CONTROLLED');
    await expect(
      registry.run(undefined, 'page_snapshot', { tabId: 10 }, async () => {}),
    ).rejects.toThrow('TAB_CONTROLLED');
    const cleanup = vi.fn(async () => {});
    await registry.release(first.sessionId, { closeCreatedTabs: true }, cleanup);
    expect(cleanup).toHaveBeenCalledWith([10, 11], [11]);
    registry.claim(second.sessionId, 10, 'attached');
    await registry.release(first.sessionId, {}, cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects queued actions from an older generation after handoff and resume', async () => {
    const registry = new ControlSessionRegistry(() => 'browser');
    const session = registry.create('cdp');
    let finish!: () => void;
    const first = registry.run(
      session.sessionId,
      'page_click',
      { tabId: 1 },
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    const dispatched = vi.fn(async () => {});
    const queued = registry.run(session.sessionId, 'page_click', { tabId: 1 }, dispatched);
    const rejected = expect(queued).rejects.toThrow('CONTROL_SESSION_PAUSED');
    registry.handoff(session.sessionId);
    finish();
    await first;
    await rejected;
    await registry.resume(session.sessionId);
    expect(dispatched).not.toHaveBeenCalled();
    await registry.run(session.sessionId, 'page_click', { tabId: 1 }, dispatched);
    expect(dispatched).toHaveBeenCalledTimes(1);
  });

  it('rechecks legacy calls after queueing and allows independent pages in parallel', async () => {
    const registry = new ControlSessionRegistry(() => 'browser');
    let finish!: () => void;
    const first = registry.run(
      undefined,
      'page_click',
      { tabId: 1 },
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    const old = registry.run(undefined, 'page_click', { tabId: 1 }, async () => {});
    const rejected = expect(old).rejects.toThrow('TAB_CONTROLLED');
    const session = registry.create('cdp');
    registry.claim(session.sessionId, 1, 'attached');
    await registry.run(undefined, 'page_click', { tabId: 2 }, async () => {});
    finish();
    await first;
    await rejected;
  });

  it('reserves an opening page before a competing snapshot can adopt it', async () => {
    const registry = new ControlSessionRegistry(() => 'browser');
    const first = registry.create('cdp');
    const second = registry.create('cdp');
    let finish!: () => void;
    const opening = registry.run(first.sessionId, 'tab_open', {}, async () => {
      await new Promise<void>(resolve => {
        finish = resolve;
      });
      registry.recordResult(first.sessionId, 'tab_open', { tabId: 12, opened: true });
    });
    await Promise.resolve();
    const snapshot = vi.fn(async () => {});
    const competing = registry.run(second.sessionId, 'page_snapshot', { tabId: 12 }, snapshot);
    const rejected = expect(competing).rejects.toThrow('TAB_CONTROLLED_BY_SESSION');
    finish();
    await opening;
    await rejected;
    expect(snapshot).not.toHaveBeenCalled();
    expect(registry.info(first.sessionId).tabs).toEqual([{ tabId: 12, source: 'created' }]);
  });

  it('retains ownership when cleanup fails and prevents creation during browser-wide release', async () => {
    const registry = new ControlSessionRegistry(() => 'browser');
    const session = registry.create('cdp');
    registry.claim(session.sessionId, 1, 'attached');
    await expect(
      registry.release(session.sessionId, {}, async () => {
        throw new Error('busy');
      }),
    ).rejects.toThrow('busy');
    expect(registry.blockedTabs()).toEqual([1]);
    await registry.release(session.sessionId, {}, async () => {});
    let finish!: () => void;
    const release = registry.releaseBrowser(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    expect(() => registry.create('cdp')).toThrow('BROWSER_CONTROL_RELEASING');
    finish();
    await release;
  });

  it('stops a batch between steps when the user takes control', async () => {
    const invoke = vi.fn(async (action: string, data: any) => {
      if (action === 'tab_open') return { tabId: 1, opened: true };
      if (data.actions?.[0]?.action === 'page_click')
        manager.registry.handoff(manager.registry.list()[0]!.sessionId);
      return { results: [{ success: true, data: { clicked: true } }] };
    });
    const manager = new ControlSessionManager({
      browserId: () => 'browser',
      transport: () => 'cdp',
      invoke,
      cleanup: vi.fn(async () => {}),
      download: vi.fn(),
      notify: vi.fn(),
    });
    const opened = await manager.invoke('tab_open', { url: 'https://example.com' }, 'new');
    const result = await manager.invoke(
      'run_actions',
      { tabId: 1, actions: [{ action: 'page_click' }, { action: 'page_type' }] },
      opened.session.sessionId,
    );
    expect(result).toMatchObject({ completedSteps: 1, failedStep: 1, session: { status: 'user' } });
    expect(invoke.mock.calls.map(call => call[0])).toEqual(['tab_open', 'run_actions']);
    await manager.artifacts.dispose();
  });

  it('scoped release clears only owned resources and keeps requested result pages', async () => {
    const cleanup = vi.fn(async () => {});
    const invoke = vi.fn(async () => ({ tabId: 1, opened: true }));
    const manager = new ControlSessionManager({
      browserId: () => 'browser',
      transport: () => 'extension',
      invoke,
      cleanup,
      download: vi.fn(),
      notify: vi.fn(),
    });
    const opened = await manager.invoke('tab_open', { url: 'https://example.com' }, 'new');
    manager.registry.claim(opened.session.sessionId, 2, 'attached');
    await manager.invoke(
      'browser_release',
      { closeCreatedTabs: true, keepTabIds: [1] },
      opened.session.sessionId,
    );
    expect(cleanup).toHaveBeenCalledWith([1, 2], 'extension', true);
    expect(invoke).toHaveBeenCalledTimes(1);
    await manager.artifacts.dispose();
  });
});

describe('background page activity lifetime', () => {
  it('does not implicitly activate session pages and disables before returning a handoff', async () => {
    const deactivate = vi.fn(async () => {});
    const cleanup = vi.fn(async () => {});
    const invoke = vi.fn(async (action: string) =>
      action === 'tab_open' ? { tabId: 71, opened: true } : {},
    );
    const manager = new ControlSessionManager({
      browserId: () => 'background-browser',
      transport: () => 'extension',
      invoke,
      deactivate,
      cleanup,
      download: vi.fn(),
      notify: vi.fn(),
    });
    try {
      const { session } = await manager.invoke('tab_open', { active: false }, 'new');
      await manager.invoke('page_snapshot', { tabId: 71 }, session.sessionId);
      expect(deactivate).not.toHaveBeenCalled();
      await manager.invoke('browser_control', { operation: 'handoff' }, session.sessionId);
      expect(deactivate).toHaveBeenCalledWith([71], 'extension');
      await manager.invoke('browser_control', { operation: 'resume' }, session.sessionId);
      expect(cleanup).toHaveBeenCalledWith([71], 'extension', true, true);
      await manager.invoke('page_snapshot', { tabId: 71 }, session.sessionId);
      expect(deactivate).toHaveBeenCalledTimes(1);
    } finally {
      await manager.artifacts.dispose();
    }
  });

  it('waits for pending tab activation before restoring a handoff, including late ownership', async () => {
    let finish!: () => void;
    let began!: () => void;
    let enabled = false;
    const started = new Promise<void>(resolve => {
      began = resolve;
    });
    const pending = new Promise<void>(resolve => {
      finish = resolve;
    });
    const deactivate = vi.fn(async () => {
      enabled = false;
    });
    const manager = new ControlSessionManager({
      browserId: () => 'background-browser',
      transport: () => 'extension',
      invoke: vi.fn(async () => {
        began();
        await pending;
        enabled = true;
        return { tabId: 72, opened: true };
      }),
      deactivate,
      cleanup: vi.fn(async () => {}),
      download: vi.fn(),
      notify: vi.fn(),
    });
    const id = manager.registry.create('extension').sessionId;
    try {
      const work = manager.invoke('tab_open', { active: true }, id);
      await started;
      const handoff = manager.userControl(id, 'handoff');
      expect(manager.registry.info(id).status).toBe('user');
      expect(deactivate).not.toHaveBeenCalled();
      finish();
      await work;
      const result = await handoff;
      expect(deactivate).toHaveBeenCalledWith([72], 'extension');
      expect(result.tabs).toEqual([{ tabId: 72, source: 'created' }]);
      expect(enabled).toBe(false);
    } finally {
      finish?.();
      await manager.artifacts.dispose();
    }
  });

  it('allows retrying a failed handoff restoration', async () => {
    const deactivate = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection busy'))
      .mockResolvedValue(undefined);
    const manager = new ControlSessionManager({
      browserId: () => 'background-browser',
      transport: () => 'extension',
      invoke: vi.fn(async () => ({ tabId: 73, opened: true })),
      deactivate,
      cleanup: vi.fn(async () => {}),
      download: vi.fn(),
      notify: vi.fn(),
    });
    try {
      const { session } = await manager.invoke('tab_open', { active: true }, 'new');
      await expect(manager.userControl(session.sessionId, 'handoff')).rejects.toThrow(
        'connection busy',
      );
      expect(manager.registry.info(session.sessionId).status).toBe('user');
      await expect(manager.userControl(session.sessionId, 'handoff')).resolves.toMatchObject({
        status: 'user',
      });
      expect(deactivate).toHaveBeenCalledTimes(2);
    } finally {
      await manager.artifacts.dispose();
    }
  });

  it('hands off during ordinary page work without activating its late opened page', async () => {
    let finish!: () => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => {
      began = resolve;
    });
    const pending = new Promise<void>(resolve => {
      finish = resolve;
    });
    const deactivate = vi.fn(async () => {});
    const manager = new ControlSessionManager({
      browserId: () => 'handoff-background',
      transport: () => 'extension',
      invoke: vi.fn(async (action: string) => {
        if (action === 'tab_open') return { tabId: 81, opened: true };
        began();
        await pending;
        return { observation: { openedTabs: [{ tabId: 82, ready: true }] } };
      }),
      deactivate,
      cleanup: vi.fn(async () => {}),
      download: vi.fn(),
      notify: vi.fn(),
    });
    try {
      const { session } = await manager.invoke('tab_open', {}, 'new');
      const work = manager.invoke('page_click', { tabId: 81, text: 'Open' }, session.sessionId);
      await started;
      await manager.invoke('browser_control', { operation: 'handoff' }, session.sessionId);
      await expect(
        manager.invoke('page_click', { tabId: 81, text: 'Again' }, session.sessionId),
      ).rejects.toThrow('CONTROL_SESSION_PAUSED');
      expect(deactivate).toHaveBeenLastCalledWith([81], 'extension');
      finish();
      await work;
      expect(deactivate).toHaveBeenCalledTimes(1);
    } finally {
      finish?.();
      await manager.artifacts.dispose();
    }
  });
});

describe('read-only capability targets', () => {
  it.each(['tabId', 'tabIds', 'openerTabId'])('rejects %s before claiming a page', async field => {
    const invoke = vi.fn(async () => ({ apps: { status: 'available', entries: [] } }));
    const manager = new ControlSessionManager({ browserId: () => 'browser', transport: () => 'extension', invoke, cleanup: vi.fn(), download: vi.fn(), notify: vi.fn() });
    const session = manager.registry.create('extension');
    try {
      await expect(manager.invoke('get_capabilities', { [field]: field === 'tabIds' ? [7] : 7 }, session.sessionId)).rejects.toThrow('does not accept page targets');
      expect(manager.registry.info(session.sessionId).tabs).toEqual([]);
      expect(invoke).not.toHaveBeenCalled();
    } finally { await manager.artifacts.dispose(); }
  });
});
