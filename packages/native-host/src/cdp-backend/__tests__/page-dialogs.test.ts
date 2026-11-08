import { describe, expect, it, vi } from 'vitest';
import { CdpSession, type PageSession } from '../cdp-session.js';
import { getCdpPageDialogs, monitorCdpPageDialogs, pressCdpPageDialog, sendCdpPageCommand, snapshotCdpPageDialog } from '../page-dialogs.js';

function fixture() {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const emit = (method: string, event?: any) => { for (const fn of listeners.get(method) ?? []) fn(event); };
  const client = {
    closed: false,
    on: (method: string, fn: (event: any) => void) => {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method)!.add(fn);
      return () => listeners.get(method)!.delete(fn);
    },
    close: vi.fn(), sendCommand: vi.fn(async (_method: string, _params?: any): Promise<any> => ({})),
  };
  const cdp = new CdpSession();
  vi.spyOn(cdp, 'getBrowserClient').mockResolvedValue({
    identity: 'fixture', sendCommand: vi.fn(async () => ({ sessionId: 'fixture' })), createChildSession: () => client,
  } as any);
  return { client, emit, cdp };
}

describe('native CDP dialog monitor', () => {
  it('interrupts initialization at dispatch and retries only on the next ordinary request', async () => {
    const { client, emit, cdp } = fixture();
    let first = true;
    client.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate' && first) {
        first = false;
        emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'During init' });
        return new Promise(() => {});
      }
      if (method === 'Page.handleJavaScriptDialog') emit('Page.javascriptDialogClosed');
      return {};
    });
    const continued = vi.fn();
    cdp.addPageSessionInitializer(async session => {
      await sendCdpPageCommand(session, client as any, 'Runtime.evaluate', { expression: 'probe' });
      continued();
    });
    const page: PageSession = await (cdp as any).createPageSession({ id: 'page', url: 'https://fixture.test' });
    const snapshot = snapshotCdpPageDialog(page, {});
    expect(snapshot.dialog.message).toBe('During init');
    await pressCdpPageDialog(page, { dialogId: snapshot.dialog.id, key: 'Escape' });
    expect(continued).not.toHaveBeenCalled();
    expect(getCdpPageDialogs(page).busy).toBe(false);
    await expect((cdp as any).preparePageSession(page)).resolves.toBe(page);
    expect(continued).toHaveBeenCalledOnce();
    expect(client.sendCommand.mock.calls.filter(([method]) => method === 'Network.enable')).toHaveLength(1);
  });

  it('shares Page.enable readiness with a concurrent request before starting any Runtime initialization', async () => {
    const { client, cdp } = fixture();
    let enable!: () => void;
    client.sendCommand.mockImplementation(async method => method === 'Page.enable' ? new Promise<void>(resolve => { enable = resolve; }) : {});
    const first = (cdp as any).createPageSession({ id: 'page', url: 'https://fixture.test' });
    await vi.waitFor(() => expect(enable).toBeTypeOf('function'));
    const second = cdp.getPageSession(1000);
    await Promise.resolve();
    expect(client.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Page.enable']);
    enable();
    expect(await first).toBe(await second);
    expect(client.sendCommand.mock.calls.filter(([method]) => method === 'Page.enable')).toHaveLength(1);
    expect(client.sendCommand.mock.calls.filter(([method]) => method === 'Runtime.enable')).toHaveLength(1);
  });

  it('keeps child ownership when an unrelated root session reports a close', async () => {
    const root = fixture(), child = fixture();
    const page = { client: root.client, url: 'https://fixture.test' } as any;
    monitorCdpPageDialogs(page);
    monitorCdpPageDialogs(page, child.client as any);
    child.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'Child' });
    root.emit('Page.javascriptDialogClosed');
    const dialogId = getCdpPageDialogs(page).info()!.id;
    await pressCdpPageDialog(page, { dialogId, key: 'Enter' });
    expect(child.client.sendCommand).toHaveBeenCalledWith('Page.handleJavaScriptDialog', { accept: true }, 5000);
    expect(root.client.sendCommand).not.toHaveBeenCalled();
  });
});
