import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEARL_PROVIDER_PROTOCOL_VERSION } from '@mearl/provider';
import { ProviderControlService } from '../provider-control.js';
import { requestBrowserSocket } from '../browser-socket-request.js';
import type { BrowserRecord } from '../browser-registry.js';

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

const services: ProviderControlService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()));
});

function fixture() {
  const browser: BrowserRecord = {
    pid: process.pid,
    browserId: 'provider:fixture:a',
    providerBrowserId: 'a',
    browserName: 'Device A',
    socketPath: '/tmp/provider-fixture.sock',
    transport: 'provider',
    provider: {
      id: 'fixture',
      name: 'Fixture',
      builtin: false,
      version: '1.0.0',
      protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
    },
    status: 'connected',
    startedAt: '2026-01-01',
    updatedAt: 0,
    operations: ['close', 'detach', 'syncCookies', 'access'],
    capabilities: {
      actions: [
        'page_screenshot',
        'page_snapshot',
        'page_click',
        'page_type',
        'tab_open',
        'tab_list',
        'tab_close',
        'page_upload',
        'get_mocks',
        'set_mock',
        'set_timezone',
      ],
      screenshot: 'native',
    },
  };
  const browsers = [browser];
  const request = vi.fn(async (_browser: BrowserRecord, action: string, data: any) => {
    if (action === 'tab_open') return { tabId: 8, opened: true };
    if (action === 'tab_list')
      return { tabs: [{ tabId: 7, url: 'https://example.com' }], count: 1 };
    if (action === 'get_mocks') return { mocks: [{ apiName: 'api.example' }] };
    return { tabId: data.tabId };
  });
  const service = new ProviderControlService({
    browsers: () => browsers,
    request,
    notify: vi.fn(),
  });
  services.push(service);
  return { service, browser, browsers, request };
}

describe('external Provider control', () => {
  it('rejects every explicit session before creating control state or dispatching', async () => {
    const { service, browser, request } = fixture();
    browser.capabilities!.controlSessionMode = 'external';
    for (const session of ['new', 's_existing', '']) {
      for (const action of ['page_snapshot', 'tab_open', 'get_versions', 'browser_instances']) {
        await expect(
          service.invoke(browser.browserId, action, { tabId: 7 }, session),
        ).rejects.toThrow('CONTROL_SESSION_UNSUPPORTED');
      }
    }
    expect(service.list()).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it('forwards declared external control without creating a Mearl session', async () => {
    const { service, browser, request } = fixture();
    browser.capabilities!.controlSessionMode = 'external';
    browser.operations = ['handoff', 'resume', 'finish'];
    for (const operation of ['handoff', 'resume', 'end']) {
      await expect(
        service.invoke(browser.browserId, 'session_manage', { operation }),
      ).resolves.toMatchObject({ operation });
      expect(request).toHaveBeenLastCalledWith(
        browser,
        'browser_control',
        { operation: operation === 'end' ? 'finish' : operation },
        'local',
        undefined,
      );
    }
    expect(service.list()).toEqual([]);
    const calls = request.mock.calls.length;
    await expect(
      service.invoke(browser.browserId, 'session_manage', {
        operation: 'end',
        keepTabIds: [-1],
      }),
    ).rejects.toThrow('keepTabIds');
    await expect(
      service.invoke(browser.browserId, 'session_manage', { operation: 'resume' }, 'new'),
    ).rejects.toThrow('CONTROL_SESSION_UNSUPPORTED');
    browser.operations = [];
    await expect(
      service.invoke(browser.browserId, 'session_manage', { operation: 'handoff' }),
    ).rejects.toThrow('does not support');
    expect(request).toHaveBeenCalledTimes(calls);
  });

  it('releases Provider control without detaching the instance', async () => {
    const { service, browser, request } = fixture();
    browser.capabilities!.actions.push('browser_release');
    await service.invoke(browser.browserId, 'browser_manage', { operation: 'release' });
    expect(request.mock.calls.map(call => call[1])).toEqual(['browser_release']);
    await expect(service.invoke(browser.browserId, 'browser_release', {})).rejects.toThrow(
      'browser_manage',
    );
  });

  it('keeps ordinary validation and artifact handling without creating a task session or clearing the page', async () => {
    const { service, browser, request } = fixture();
    browser.capabilities!.controlSessionMode = 'external';
    const observed = await service.invoke(browser.browserId, 'page_snapshot', { tabId: 7 });
    expect(observed).toEqual({ tabId: 7 });
    await expect(service.invoke(browser.browserId, 'page_snapshot', {})).rejects.toThrow('tabId');
    await expect(
      service.invoke(browser.browserId, 'page_snapshot', {
        tabId: 7,
        __mearlControlSource: 'local',
      }),
    ).rejects.toThrow('reserved');
    const artifact = await service.invoke(browser.browserId, '__artifact_init', {
      filename: 'data.txt',
    });
    expect(artifact.artifact.artifactId).toBeTruthy();
    await service.invoke(browser.browserId, 'browser_manage', { operation: 'detach' });
    expect(request.mock.calls.map(call => call[1])).toEqual(['page_snapshot', 'browser_instances']);
    expect(request.mock.calls[1]![2]).toEqual({ operation: 'detach' });
    expect(service.list()).toEqual([]);
  });

  it('invalidates old session identities when a Provider changes its control mode', async () => {
    const { service, browser, request } = fixture();
    const first = await service.invoke(browser.browserId, 'page_snapshot', { tabId: 7 }, 'new');
    expect(service.find(first.session.sessionId)).toBeDefined();
    browser.capabilities!.controlSessionMode = 'external';
    expect(service.find(first.session.sessionId)).toBeUndefined();
    await expect(
      service.invoke(browser.browserId, 'page_click', { tabId: 7 }, first.session.sessionId),
    ).rejects.toThrow('CONTROL_SESSION_UNSUPPORTED');
    expect(request).toHaveBeenCalledOnce();
  });
});

describe('Mearl control over ordinary Provider actions', () => {
  it('rejects native dialog parameters before an older Provider can turn them into ordinary Enter', async () => {
    const { service, browser, request } = fixture();
    browser.capabilities!.actions.push('page_press', 'run_actions');
    await expect(
      service.invoke(browser.browserId, 'page_press', {
        tabId: 7,
        key: 'Enter',
        dialogId: 'dialog',
      }),
    ).rejects.toThrow('not negotiated');
    await expect(
      service.invoke(browser.browserId, 'run_actions', {
        tabId: 7,
        actions: [{ action: 'page_press', data: { key: 'Enter', dialogId: 'dialog' } }],
      }),
    ).rejects.toThrow('not negotiated');
    expect(request).not.toHaveBeenCalled();
  });
  it('describes a Provider from its advertised actions without inventing App support or dispatching a page action', async () => {
    const { service, browser, request } = fixture();
    const result = await service.invoke(browser.browserId, 'get_capabilities');
    expect(result.actions).toEqual(['get_capabilities', ...browser.capabilities!.actions]);
    expect(result.apps).toMatchObject({ status: 'unsupported', entries: [] });
    expect(result.devicePresets).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
  it('delegates discovery to Providers that explicitly advertise it', async () => {
    const { service, browser, request } = fixture();
    browser.capabilities!.actions.push('get_capabilities');
    request.mockResolvedValueOnce({ apps: { status: 'available', entries: [] } } as any);
    await expect(
      service.invoke(browser.browserId, 'get_capabilities', { app: 'example/app' }),
    ).resolves.toMatchObject({ apps: { status: 'available' } });
    expect(request).toHaveBeenCalledWith(
      browser,
      'get_capabilities',
      expect.objectContaining({ app: 'example/app' }),
      'local',
      undefined,
    );
  });
  it('rejects an incompatible running browser before dispatch', async () => {
    const { service, browser, request } = fixture();
    browser.provider!.protocolVersion = MEARL_PROVIDER_PROTOCOL_VERSION - 1;
    await expect(service.invoke(browser.browserId, 'page_snapshot', { tabId: 7 })).rejects.toThrow(
      'PROVIDER_PROTOCOL_MISMATCH',
    );
    expect(request).not.toHaveBeenCalled();
  });
  it('keeps concurrent caller deadlines isolated and outside business payloads', async () => {
    const { service, browser, request } = fixture();
    const first = Date.now() + 180_000,
      second = Date.now() + 300_000;
    await Promise.all([
      service.invoke(
        browser.browserId,
        'page_snapshot',
        { tabId: 7 },
        undefined,
        'local',
        undefined,
        first,
      ),
      service.invoke(
        browser.browserId,
        'page_snapshot',
        { tabId: 8 },
        undefined,
        'cloud',
        undefined,
        second,
      ),
    ]);
    expect(request).toHaveBeenCalledWith(
      browser,
      'page_snapshot',
      { tabId: 7 },
      'local',
      undefined,
      first,
    );
    expect(request).toHaveBeenCalledWith(
      browser,
      'page_snapshot',
      { tabId: 8 },
      'cloud',
      undefined,
      second,
    );
    await expect(
      service.invoke(
        browser.browserId,
        'page_click',
        { tabId: 7 },
        undefined,
        'local',
        undefined,
        Date.now() - 1,
      ),
    ).rejects.toThrow('deadline exceeded');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('does not dispatch a queued action after its caller deadline expires', async () => {
    const { service, browser, request } = fixture();
    const opened = await service.invoke(browser.browserId, 'page_snapshot', { tabId: 7 }, 'new');
    let now = 1000,
      finish!: () => void,
      started!: () => void;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const running = new Promise<void>(resolve => {
      started = resolve;
    });
    request.mockImplementationOnce(async () => {
      started();
      await new Promise<void>(resolve => {
        finish = resolve;
      });
      return {};
    });
    try {
      const first = service.invoke(
        browser.browserId,
        'page_click',
        { tabId: 7 },
        opened.session.sessionId,
        'local',
        undefined,
        2000,
      );
      await running;
      const second = service.invoke(
        browser.browserId,
        'page_click',
        { tabId: 7 },
        opened.session.sessionId,
        'local',
        undefined,
        1200,
      );
      const rejected = expect(second).rejects.toThrow('deadline exceeded');
      now = 1300;
      finish();
      await first;
      await rejected;
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
  it('does not restart a batch deadline for later steps', async () => {
    const { service, browser, request } = fixture();
    const opened = await service.invoke(browser.browserId, 'page_snapshot', { tabId: 7 }, 'new');
    let now = 1000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    request.mockImplementationOnce(async () => {
      now = 1300;
      return {};
    });
    try {
      const result = await service.invoke(
        browser.browserId,
        'run_actions',
        {
          tabId: 7,
          actions: [
            { action: 'page_click', data: { tabId: 7, text: 'first' } },
            { action: 'page_click', data: { tabId: 7, text: 'second' } },
          ],
        },
        opened.session.sessionId,
        'local',
        undefined,
        1200,
      );
      expect(result.results[1]).toMatchObject({
        success: false,
        error: expect.stringContaining('deadline exceeded'),
      });
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
  it('rejects identical session ids owned by different Provider browsers', async () => {
    vi.mocked(randomBytes)
      .mockImplementationOnce(() => Buffer.alloc(6, 1))
      .mockImplementationOnce(() => Buffer.alloc(6, 1));
    const { service, browser, browsers } = fixture();
    const second = { ...browser, browserId: 'provider:fixture:b', providerBrowserId: 'b' };
    browsers.push(second);
    const firstSession = await service.invoke(
      browser.browserId,
      'page_snapshot',
      { tabId: 7 },
      'new',
    );
    const secondSession = await service.invoke(
      second.browserId,
      'page_snapshot',
      { tabId: 7 },
      'new',
    );
    expect(firstSession.session.sessionId).toBe(secondSession.session.sessionId);
    expect(() => service.find(firstSession.session.sessionId)).toThrow('CONTROL_SESSION_AMBIGUOUS');
  });

  it('uses the existing Provider wire protocol over a real socket', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mearl-provider-wire-'));
    const socketPath = join(directory, 'provider.sock');
    const received: any[] = [];
    const server = net.createServer(socket =>
      socket.on('data', chunk => {
        const message = JSON.parse(chunk.toString());
        received.push(message);
        socket.end(
          JSON.stringify({ id: message.id, success: true, data: { tabId: message.data.tabId } }) +
            '\n',
        );
      }),
    );
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    const { browser } = fixture();
    browser.socketPath = socketPath;
    const service = new ProviderControlService({
      browsers: () => [browser],
      notify: vi.fn(),
      request: (target, action, data, origin) =>
        requestBrowserSocket(
          target.socketPath,
          action,
          data,
          'test',
          5000,
          target.providerBrowserId,
          undefined,
          { controlSource: origin },
        ),
    });
    services.push(service);
    try {
      const opened = await service.invoke(
        browser.browserId,
        'page_screenshot',
        { tabId: 7 },
        'new',
      );
      await service.invoke(
        browser.browserId,
        'page_click',
        { tabId: 7, text: 'Next' },
        opened.session.sessionId,
      );
      await service.userControl(opened.session.sessionId, 'release');
      expect(received.map(({ id: _id, ...request }) => request)).toEqual([
        {
          action: 'page_screenshot',
          deadline: expect.any(Number),
          browserId: 'a',
          data: { tabId: 7 },
          version: 'test',
          protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
          controlSource: 'local',
        },
        {
          action: 'page_click',
          deadline: expect.any(Number),
          browserId: 'a',
          data: { tabId: 7, text: 'Next' },
          version: 'test',
          protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
          controlSource: 'local',
        },
      ]);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('creates from screenshots and protects ownership without passing session fields to the adapter', async () => {
    const { service, browser, request } = fixture();
    const first = await service.invoke(browser.browserId, 'page_screenshot', { tabId: 7 }, 'new');
    expect(first.session.transport).toBe('provider');
    expect(service.find(first.session.sessionId)).toMatchObject(first.session);
    expect(first.session).not.toHaveProperty('tabs');
    expect(service.find(first.session.sessionId)?.tabs).toContainEqual({
      tabId: 7,
      source: 'attached',
    });
    expect(service.find('s_00000000')).toBeUndefined();
    await expect(service.invoke(browser.browserId, 'page_click', { tabId: 7 })).rejects.toThrow(
      'TAB_CONTROLLED_BY_SESSION',
    );
    await expect(
      service.invoke(browser.browserId, 'page_screenshot', { tabId: 7 }, 'new'),
    ).rejects.toThrow('TAB_CONTROLLED_BY_SESSION');
    await service.invoke(
      browser.browserId,
      'page_click',
      { tabId: 7, text: 'Next' },
      first.session.sessionId,
      'cloud',
    );
    expect(request).toHaveBeenLastCalledWith(
      browser,
      'page_click',
      { tabId: 7, text: 'Next' },
      'cloud',
      undefined,
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(service.list()).toHaveLength(1);
  });

  it('keeps identical tab ids in different browsers independent', async () => {
    const { service, browser, browsers, request } = fixture();
    const second = { ...browser, browserId: 'provider:fixture:b', providerBrowserId: 'b' };
    browsers.push(second);
    await service.invoke(browser.browserId, 'page_snapshot', { tabId: 7 }, 'new');
    await service.invoke(second.browserId, 'page_click', { tabId: 7, text: 'Next' });
    expect(request).toHaveBeenLastCalledWith(
      second,
      'page_click',
      { tabId: 7, text: 'Next' },
      'local',
      undefined,
    );
  });

  it('stops a batch at handoff and allows only fresh calls after the user returns control', async () => {
    const { service, browser, request } = fixture();
    const opened = await service.invoke(browser.browserId, 'page_snapshot', { tabId: 7 }, 'new');
    const id = opened.session.sessionId;
    let finish!: () => void;
    let dispatched!: () => void;
    const started = new Promise<void>(resolve => {
      dispatched = resolve;
    });
    request.mockImplementationOnce(async () => {
      dispatched();
      await new Promise<void>(resolve => {
        finish = resolve;
      });
      return {};
    });
    const batch = service.invoke(
      browser.browserId,
      'run_actions',
      {
        tabId: 7,
        actions: [
          { action: 'page_click', data: { text: 'First' } },
          { action: 'page_type', data: { selector: ':focus', text: 'Second' } },
        ],
      },
      id,
    );
    await started;
    await service.invoke(browser.browserId, 'session_manage', { operation: 'handoff' }, id);
    finish();
    expect(await batch).toMatchObject({
      completedSteps: 1,
      failedStep: 1,
      error: expect.stringContaining('CONTROL_SESSION_PAUSED'),
    });
    await expect(service.invoke(browser.browserId, 'page_click', { tabId: 7 }, id)).rejects.toThrow(
      'CONTROL_SESSION_PAUSED',
    );
    await service.userControl(id, 'resume');
    await service.invoke(browser.browserId, 'page_snapshot', { tabId: 7 }, id);
    expect(request.mock.calls.map(call => call[1])).toEqual([
      'page_snapshot',
      'page_click',
      'page_snapshot',
    ]);
  });

  it('reports failed Provider actions instead of continuing the batch', async () => {
    const { service, browser, request } = fixture();
    const opened = await service.invoke(browser.browserId, 'page_snapshot', { tabId: 7 }, 'new');
    request.mockResolvedValueOnce({
      action: { success: false, error: 'Button is covered', stage: 'precondition' },
    } as any);
    const result = await service.invoke(
      browser.browserId,
      'run_actions',
      {
        tabId: 7,
        actions: [
          { action: 'page_click', data: { text: 'Submit' } },
          { action: 'page_click', data: { text: 'Next' } },
        ],
      },
      opened.session.sessionId,
    );
    expect(result).toMatchObject({ completedSteps: 0, failedStep: 0, error: 'Button is covered' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('releases ownership while retaining attached and result pages, without detaching the instance', async () => {
    const { service, browser, request } = fixture();
    const opened = await service.invoke(browser.browserId, 'page_snapshot', { tabId: 7 }, 'new');
    const id = opened.session.sessionId;
    await service.invoke(
      browser.browserId,
      'tab_open',
      { url: 'https://result.example', reuse: 'never' },
      id,
    );
    await expect(
      service.invoke(browser.browserId, 'browser_manage', { operation: 'close' }),
    ).rejects.toThrow('ACTIVE_CONTROL_SESSIONS');
    await expect(
      service.invoke(browser.browserId, 'browser_manage', { operation: 'detach' }),
    ).rejects.toThrow('ACTIVE_CONTROL_SESSIONS');
    await service.invoke(
      browser.browserId,
      'session_manage',
      { operation: 'end', closeCreatedTabs: true, keepTabIds: [8] },
      id,
    );
    expect(request.mock.calls.map(call => call[1])).toEqual(['page_snapshot', 'tab_open']);
    await service.invoke(browser.browserId, 'page_click', { tabId: 7 });
    await service.invoke(browser.browserId, 'browser_manage', { operation: 'detach' });
    expect(request).toHaveBeenLastCalledWith(
      browser,
      'browser_instances',
      { operation: 'detach' },
      'local',
      undefined,
    );
  });

  it('closes only created process pages and clears environment only when requested', async () => {
    const { service, browser, request } = fixture();
    const opened = await service.invoke(browser.browserId, 'page_snapshot', { tabId: 7 }, 'new');
    const id = opened.session.sessionId;
    await service.invoke(
      browser.browserId,
      'tab_open',
      { url: 'https://process.example', reuse: 'never' },
      id,
    );
    await service.invoke(
      browser.browserId,
      'session_manage',
      { operation: 'end', closeCreatedTabs: true, preserveEnvironment: false },
      id,
    );
    const closed = request.mock.calls.filter(call => call[1] === 'tab_close');
    expect(closed.map(call => call[2].tabId)).toEqual([8]);
    expect(request.mock.calls.filter(call => call[1] === 'set_mock').map(call => call[2])).toEqual([
      { tabId: 7, apiName: 'api.example', enabled: false },
      { tabId: 8, apiName: 'api.example', enabled: false },
    ]);
    expect(request.mock.calls.some(call => call[1] === 'browser_instances')).toBe(false);
  });

  it('checks reuse before dispatch so opening cannot mutate another task page', async () => {
    const { service, browser, request } = fixture();
    await service.invoke(browser.browserId, 'page_snapshot', { tabId: 7 }, 'new');
    await expect(
      service.invoke(
        browser.browserId,
        'tab_open',
        { url: 'https://example.com', reuse: 'prefer' },
        'new',
      ),
    ).rejects.toThrow('TAB_CONTROLLED_BY_SESSION');
    expect(request.mock.calls.some(call => call[1] === 'tab_open')).toBe(false);
  });

  it('retains ownership when explicit environment cleanup fails', async () => {
    const { service, browser, request } = fixture();
    const opened = await service.invoke(browser.browserId, 'page_snapshot', { tabId: 7 }, 'new');
    request.mockResolvedValueOnce({ mocks: [] } as any);
    request.mockResolvedValueOnce({ success: false, error: 'Timezone reset failed' } as any);
    await expect(
      service.invoke(
        browser.browserId,
        'session_manage',
        { operation: 'end', preserveEnvironment: false },
        opened.session.sessionId,
      ),
    ).rejects.toThrow('Timezone reset failed');
    await expect(service.invoke(browser.browserId, 'page_click', { tabId: 7 })).rejects.toThrow(
      'TAB_CONTROLLED_BY_SESSION',
    );
  });

  it('invalidates sessions when the Provider process changes', async () => {
    const { service, browser, request } = fixture();
    const opened = await service.invoke(browser.browserId, 'page_snapshot', { tabId: 7 }, 'new');
    browser.pid += 1;
    expect(service.find(opened.session.sessionId)).toBeUndefined();
    await expect(
      service.invoke(browser.browserId, 'page_click', { tabId: 7 }, opened.session.sessionId),
    ).rejects.toThrow('CONTROL_SESSION_NOT_FOUND');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('stages caller files for an existing upload adapter and retains selected artifacts on release', async () => {
    const { service, browser, request } = fixture();
    const opened = await service.invoke(browser.browserId, 'page_snapshot', { tabId: 7 }, 'new');
    const id = opened.session.sessionId;
    const created = await service.invoke(
      browser.browserId,
      '__artifact_init',
      { filename: 'report.txt' },
      id,
    );
    const artifactId = created.artifact.artifactId;
    await service.invoke(
      browser.browserId,
      '__artifact_write',
      { artifactId, offset: 0, base64: Buffer.from('report').toString('base64') },
      id,
    );
    await service.invoke(browser.browserId, '__artifact_complete', { artifactId, bytes: 6 }, id);
    await service.invoke(
      browser.browserId,
      'page_upload',
      { tabId: 7, selector: '#file', files: [{ artifactId }] },
      id,
    );
    const upload = request.mock.calls.at(-1)![2];
    expect(upload.files).toBeUndefined();
    expect(await readFile(upload.filePaths[0], 'utf8')).toBe('report');
    await service.invoke(
      browser.browserId,
      'session_manage',
      { operation: 'end', keepArtifactIds: [artifactId] },
      id,
    );
    expect(
      await service.invoke(browser.browserId, '__artifact_read', { artifactId, offset: 0 }),
    ).toMatchObject({ bytes: 6 });
  });

  it('rejects unsupported downloads without clicking or inventing Provider capabilities', async () => {
    const { service, browser, request } = fixture();
    await expect(
      service.invoke(browser.browserId, 'page_download', {
        tabId: 7,
        trigger: { text: 'Download' },
      }),
    ).rejects.toThrow('does not support page_download');
    expect(request).not.toHaveBeenCalled();
  });

  it('imports a declared download for transfer and upload, then cleans its session artifact', async () => {
    const { service, browser, request } = fixture();
    browser.capabilities!.actions.push('page_download');
    const directory = await mkdtemp(join(tmpdir(), 'mearl-provider-download-'));
    const filePath = join(directory, 'report.txt');
    try {
      await writeFile(filePath, 'downloaded report');
      const opened = await service.invoke(browser.browserId, 'page_snapshot', { tabId: 7 }, 'new');
      const id = opened.session.sessionId;
      const action = { success: true, tabId: 7 };
      request.mockResolvedValueOnce({
        filename: 'report.txt',
        filePath,
        action,
        owned: true,
      } as any);
      const params = { tabId: 7, trigger: { text: 'Download' }, timeout: 5000 };
      const result = await service.invoke(browser.browserId, 'page_download', params, id, 'cloud');
      expect(request).toHaveBeenLastCalledWith(
        browser,
        'page_download',
        params,
        'cloud',
        undefined,
      );
      expect(result).toMatchObject({
        download: { filename: 'report.txt', bytes: 17, browserId: browser.browserId },
        action,
      });
      await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
      const artifactId = result.download.artifactId;
      const read = await service.invoke(
        browser.browserId,
        '__artifact_read',
        { artifactId, offset: 0 },
        id,
      );
      expect(Buffer.from(read.base64, 'base64').toString()).toBe('downloaded report');
      await service.invoke(
        browser.browserId,
        'page_upload',
        { tabId: 7, selector: '#file', files: [{ artifactId }] },
        id,
      );
      const uploadPath = request.mock.calls.at(-1)![2].filePaths[0];
      expect(await readFile(uploadPath, 'utf8')).toBe('downloaded report');
      await service.invoke(browser.browserId, 'session_manage', { operation: 'end' }, id);
      await expect(access(uploadPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves Provider-owned downloads and rejects incomplete results without retry', async () => {
    const { service, browser, request } = fixture();
    browser.capabilities!.actions.push('page_download');
    const directory = await mkdtemp(join(tmpdir(), 'mearl-provider-download-'));
    const filePath = join(directory, 'report.txt');
    const params = { tabId: 7, trigger: { text: 'Download' } };
    try {
      await writeFile(filePath, 'report');
      request.mockResolvedValueOnce({ filename: 'report.txt', filePath, action: {} } as any);
      await service.invoke(browser.browserId, 'page_download', params);
      expect(await readFile(filePath, 'utf8')).toBe('report');
      request.mockResolvedValueOnce({
        filename: 'report.txt',
        filePath: 'relative.txt',
        action: {},
      } as any);
      await expect(service.invoke(browser.browserId, 'page_download', params)).rejects.toThrow(
        'absolute filePath',
      );
      request.mockRejectedValueOnce(new Error('Download timed out'));
      await expect(service.invoke(browser.browserId, 'page_download', params)).rejects.toThrow(
        'Download timed out',
      );
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reclaims session files after their Provider instance disappears', async () => {
    const { service, browser, browsers, request } = fixture();
    const opened = await service.invoke(browser.browserId, 'page_snapshot', { tabId: 7 }, 'new');
    const id = opened.session.sessionId;
    const created = await service.invoke(
      browser.browserId,
      '__artifact_init',
      { filename: 'empty.txt' },
      id,
    );
    const artifactId = created.artifact.artifactId;
    await service.invoke(browser.browserId, '__artifact_complete', { artifactId, bytes: 0 }, id);
    await service.invoke(
      browser.browserId,
      'page_upload',
      { tabId: 7, selector: '#file', files: [{ artifactId }] },
      id,
    );
    const filePath = request.mock.calls.at(-1)![2].filePaths[0];
    await access(filePath);
    browsers.length = 0;
    expect(service.list()).toEqual([]);
    await service.dispose();
    await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('protects cookie synchronization and forwards host context once ownership is released', async () => {
    const { service, browser, request } = fixture();
    const opened = await service.invoke(browser.browserId, 'page_snapshot', { tabId: 7 }, 'new');
    const host = { cookies: [{ name: 'test' }] };
    await expect(
      service.invoke(
        browser.browserId,
        'browser_instances',
        { operation: 'sync_cookies', scope: {} },
        undefined,
        'local',
        host,
      ),
    ).rejects.toThrow('ACTIVE_CONTROL_SESSIONS');
    await service.userControl(opened.session.sessionId, 'release');
    await service.invoke(
      browser.browserId,
      'browser_instances',
      { operation: 'sync_cookies', scope: {} },
      undefined,
      'local',
      host,
    );
    expect(request).toHaveBeenLastCalledWith(
      browser,
      'browser_instances',
      { operation: 'sync_cookies', scope: {} },
      'local',
      host,
    );
  });
});
