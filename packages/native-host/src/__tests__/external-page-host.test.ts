import { expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  session: undefined as any,
  handler: vi.fn(async () => ({ ok: true })),
  close: vi.fn(),
}));
vi.mock('../cdp-backend/handlers.js', () => ({}));
vi.mock('../cdp-backend/client.js', () => ({
  CdpClient: {
    fromTransport: () => ({
      identity: 'fixture',
      createChildSession: () => ({ sendCommand: async () => ({}) }),
      close: fixture.close,
    }),
  },
}));
vi.mock('../cdp-backend/buffers.js', () => ({
  createBuffers: () => ({}),
  setupBufferListeners: async () => {},
}));
vi.mock('../cdp-backend/page-dialogs.js', () => ({
  monitorCdpPageDialogs: () => () => {},
  getCdpPageDialogs: () => ({ execute: (callback: () => unknown) => callback() }),
}));
vi.mock('../cdp-backend/page-session-initializers.js', () => ({
  initializePageSession: async (session: unknown) => {
    fixture.session = session;
  },
}));
vi.mock('../native-capability-services.js', () => ({
  nativeCapabilities: { refresh: async () => {} },
}));
vi.mock('../cdp-backend/action-registry.js', () => ({
  getAction: () => ({ session: 'page', handler: fixture.handler }),
}));
vi.mock('../cdp-backend/app-profile-handlers.js', () => ({ clearCdpAppProfile: async () => {} }));
vi.mock('../cdp-backend/device-shell.js', () => ({ clearCdpDeviceShell: async () => {} }));
import { createExternalPageHost } from '../external-page-host.js';

it('checks ownership before handlers and renews the host lease only after explicit control is available', async () => {
  let controlled = true;
  const host = await createExternalPageHost({
    tabId: 1,
    targetId: 'page',
    url: 'about:blank',
    sessionId: 'session',
    transport: {} as any,
    assertControl: async () => {
      if (!controlled) throw new Error('user control');
    },
  });
  const firstLease = fixture.session.hostSignal;
  host.suspend();
  expect(firstLease.aborted).toBe(true);
  controlled = false;
  await expect(host.invoke('page_eval')).rejects.toThrow('user control');
  expect(fixture.handler).not.toHaveBeenCalled();
  expect(fixture.session.hostSignal).toBe(firstLease);
  controlled = true;
  await expect(host.invoke('page_eval')).resolves.toEqual({ ok: true });
  expect(fixture.session.hostSignal.aborted).toBe(false);
  expect(firstLease.aborted).toBe(true);
  await expect(host.invoke('page_eval', { tabId: 2 })).rejects.toThrow('target mismatch');
  await expect(host.invoke('browser_close')).rejects.toThrow('Unsupported');
  await host.dispose();
  expect(fixture.session.hostSignal.aborted).toBe(true);
  expect(fixture.close).toHaveBeenCalledOnce();
});
