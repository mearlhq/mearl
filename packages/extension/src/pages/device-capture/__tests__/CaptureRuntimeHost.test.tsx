import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  CaptureRuntimeProvider,
  useCaptureRuntimeState,
} from '../CaptureRuntimeHost';
const selection = vi.hoisted(() => ({ revision: 'accepted' }));
vi.mock('../../panel/components/browser-view/viewState', () => ({
  refreshBrowserView: vi.fn(async () => {}),
  useBrowserView: () => ({
    loaded: true,
    selected: {
      bundleId: 'example',
      revision: selection.revision,
      slot: 'captureController',
      definition: { schemaVersion: 1, entry: 'controller.html', actions: {} },
      html: '<div/>',
    },
  }),
}));
vi.mock('../../panel/hooks/useCaptureIdentity', () => ({
  useCaptureIdentity: () => ({ userInfo: null, loading: false, loginRequired: false }),
}));
vi.mock('../../panel/utils/i18n', () => ({
  t: (key: string) => key,
  getCurrentLanguage: () => 'en',
}));
vi.mock('../../panel/utils/toast', () => ({ showToast: vi.fn() }));
let finish: Array<(value: unknown) => void>;
let runtime: ReturnType<typeof useCaptureRuntimeState>;
const sent = (): any[] =>
  (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(([message]) => message);
function Child() {
  runtime = useCaptureRuntimeState();
  return <div>capture</div>;
}
function stateEvent(channels = {
  first: { label: 'First source', supportsModify: true },
  second: { label: 'Second source', supportsModify: true },
}) {
  const start = sent().filter(message => message.data.operation === 'controllerStart').at(-1)!;
  const handler = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)![0];
  handler({ target: 'mearl-browser-controller-event', id: start.data.instanceId, event: { type: 'state', state: {
    proxy: { activeProxy: null, loading: false, synced: true, storageReady: true, sseUrl: '' },
    channels: Object.fromEntries(Object.entries(channels).map(([id, channel]) => [id, { ...channel, connection: { status: 'idle', upstream: 'idle', statusText: { connecting: 'Connecting', active: 'Online', idle: 'Offline' } }, overrides: [] }])),
  } } }, { id: chrome.runtime.id, url: chrome.runtime.getURL('src/pages/offscreen/index.html') }, vi.fn());
}
function renderCapture(element: Parameters<typeof render>[0]) {
  const page = render(element);
  act(() => stateEvent());
  return page;
}
beforeEach(() => {
  finish = [];
  selection.revision = 'accepted';
  chrome.runtime.id = 'owned';
  chrome.runtime.getURL = file => 'chrome-extension://owned/' + file;
  chrome.runtime.connect = vi.fn(() => ({
    onDisconnect: { addListener: vi.fn() },
    disconnect: vi.fn(),
  })) as any;
  chrome.runtime.sendMessage = vi.fn(message =>
    message.data.operation === 'controllerStart'
      ? new Promise(resolve => {
          finish.push(resolve);
        })
      : Promise.resolve({ success: true }),
  ) as any;
});
it('releases an unmounted component after its accepted startup settles', async () => {
  const page = renderCapture(
    <CaptureRuntimeProvider enabled platformId="first">
      <Child />
    </CaptureRuntimeProvider>,
  );
  page.unmount();
  expect(sent().filter(m => m.data.operation === 'controllerClose')).toHaveLength(0);
  await act(async () => {
    finish[0]({ success: true });
  });
  await waitFor(() =>
    expect(sent().filter(m => m.data.operation === 'controllerClose')).toHaveLength(1),
  );
  expect(chrome.runtime.connect).not.toHaveBeenCalled();
});
it('retains the session during StrictMode replay and releases it once on actual unmount', async () => {
  const page = renderCapture(
    <StrictMode>
      <CaptureRuntimeProvider enabled platformId="first">
        <Child />
      </CaptureRuntimeProvider>
    </StrictMode>,
  );
  await act(async () => {
    for (const resolve of finish) resolve({ success: true });
  });
  expect(sent().filter(m => m.data.operation === 'controllerClose')).toHaveLength(0);
  expect(chrome.runtime.connect).toHaveBeenCalledOnce();
  page.unmount();
  await waitFor(() =>
    expect(sent().filter(m => m.data.operation === 'controllerClose')).toHaveLength(1),
  );
});
it('lets an existing interaction retry failed startup without requiring a new UI entry', async () => {
  const page = renderCapture(
    <CaptureRuntimeProvider enabled platformId="second">
      <Child />
    </CaptureRuntimeProvider>,
  );
  await act(async () => {
    finish[0]({ success: false, error: 'startup failed' });
  });
  let operation!: Promise<void>;
  await act(async () => {
    operation = runtime.channels.second.modify!.removeAllOverrides();
    await Promise.resolve();
  });
  await waitFor(() => expect(finish).toHaveLength(2));
  await act(async () => {
    finish[1]({ success: true });
    await operation;
  });
  expect(sent().some(m => m.data.operation === 'controllerCommand')).toBe(true);
  page.unmount();
});

it('refreshes an unaccepted stale candidate and pins only the successful version', async () => {
  const content = (
    <CaptureRuntimeProvider enabled platformId="first">
      <Child />
    </CaptureRuntimeProvider>
  );
  const page = renderCapture(content);
  await act(async () => {
    finish[0]({ success: false, error: 'candidate changed' });
  });
  expect(screen.getByRole('alert')).toBeInTheDocument();
  selection.revision = 'newer';
  await act(async () => {
    fireEvent.click(screen.getByText('retry'));
  });
  await waitFor(() => expect(finish).toHaveLength(2));
  expect(
    sent()
      .filter(m => m.data.operation === 'controllerStart')
      .at(-1)!.data.revision,
  ).toBe('newer');
  await act(async () => {
    finish[1]({ success: true });
  });
  selection.revision = 'future';
  page.rerender(
    <CaptureRuntimeProvider enabled platformId="second">
      <Child />
    </CaptureRuntimeProvider>,
  );
  await act(async () => {});
  expect(finish).toHaveLength(2);
  page.unmount();
});

it('waits for a delayed interaction retry on unmount and ignores its late acceptance', async () => {
  const page = renderCapture(
    <CaptureRuntimeProvider enabled platformId="second">
      <Child />
    </CaptureRuntimeProvider>,
  );
  await act(async () => {
    finish[0]({ success: false, error: 'startup failed' });
  });
  let result!: Promise<void>;
  await act(async () => {
    result = runtime.channels.second.modify!.removeAllOverrides();
    await Promise.resolve();
  });
  const rejected = expect(result).rejects.toThrow('Capture page closed');
  await waitFor(() => expect(finish).toHaveLength(2));
  page.unmount();
  await act(async () => {});
  expect(sent().filter(m => m.data.operation === 'controllerClose')).toHaveLength(0);
  await act(async () => {
    finish[1]({ success: true });
    await rejected;
  });
  await waitFor(() =>
    expect(sent().filter(m => m.data.operation === 'controllerClose')).toHaveLength(1),
  );
  expect(chrome.runtime.connect).not.toHaveBeenCalled();
  expect(sent().some(m => m.data.operation === 'controllerCommand')).toBe(false);
});

it('resolves a missing selection from the accepted controller channels', async () => {
  const changed = vi.fn();
  const page = renderCapture(<CaptureRuntimeProvider enabled platformId="missing" onPlatformChange={changed}><Child /></CaptureRuntimeProvider>);
  expect(changed).toHaveBeenCalledWith('first');
  expect(Object.keys(runtime.channels)).toEqual(['first', 'second']);
  expect(runtime.channels.first.label).toBe('First source');
  page.unmount();
  await act(async () => { finish[0]({ success: true }); });
});
