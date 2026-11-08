import { useEffect, useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceCapture } from '../DeviceCapture';

const storage = vi.hoisted(() => ({ ready: true,
  message: undefined as undefined | ((request: any) => void),
  select: undefined as undefined | ((id: string) => void),
}));
vi.mock('../../panel/utils/i18n', () => ({ t: (key: string) => key, initI18n: async () => {} }));
vi.mock('../../../shared/pageTitle', () => ({ setExtensionPageTitle: vi.fn() }));
vi.mock('../../panel/hooks/useExtensionConfig', () => ({
  useExtensionConfig: () => [{ language: 'en', requestCasesEnabled: true }, true],
}));
vi.mock('../../panel/components/browser-view/viewState', () => ({
  useBrowserView: () => ({ loaded: true }),
}));
vi.mock('../../panel/hooks/useLocalStorage', () => ({
  useLocalStorage: (_key: string, initial: unknown) => [...useState(initial), storage.ready],
}));
vi.mock('../../panel/utils/browserUiSettings', () => ({ useBrowserUiSettings: () => ({}) }));
vi.mock('../../panel/hooks/useCaptureIdentity', () => ({ useCaptureIdentity: () => ({}) }));
vi.mock('../hooks/useCaptureProxyLogin', () => ({ useCaptureProxyLogin: () => ({ loginModalOpen: false }) }));
vi.mock('../hooks/useDeviceCaptureMockImport', () => ({ useDeviceCaptureMockImport: () => ({}) }));
vi.mock('../CaptureRuntimeHost', () => ({
  CaptureRuntimeProvider: ({ children, onPlatformChange }: { children: ReactNode; onPlatformChange(id: string): void }) => { storage.select = onPlatformChange; useEffect(() => onPlatformChange('device'), []); return children; },
  useCaptureRuntime: (message: (request: any) => void) => { storage.message = message; return {}; },
  useCaptureRuntimeState: () => ({ channels: { device: { label: 'Device source', supportsModify: false, modify: null, connection: null }, other: { label: 'Other source', supportsModify: false, modify: null, connection: null } } }),
}));
vi.mock('../../panel/components/RequestList', () => ({
  RequestList: ({ requests, onSelectRequest }: { requests: Array<{ id: number; apiName: string }>; onSelectRequest(id: number): void }) => <div data-testid="capture-list">{requests.map(request => <button key={request.id} onClick={() => onSelectRequest(request.id)}>{request.apiName}</button>)}</div>,
}));
vi.mock('../../panel/components/RequestDetail', () => ({ RequestDetail: ({ request }: { request: { apiName: string } | null }) => <span data-testid="selected-request">{request?.apiName}</span> }));
vi.mock('../../panel/components/BottomStatusBar', () => ({ BottomStatusBar: () => null }));
vi.mock('../../panel/components/StatusPanel', () => ({ StatusPanel: () => null }));
vi.mock('../../panel/components/ResizablePanels', () => ({
  ResizablePanels: ({ leftPanel, rightPanel }: { leftPanel: ReactNode; rightPanel: ReactNode }) => <>{leftPanel}{rightPanel}</>,
}));
vi.mock('../../panel/components/request-cases/RequestCasesModal', () => ({
  RequestCasesModal: () => null,
}));
vi.mock('../../panel/components/ToastContainer', () => ({ ToastContainer: () => null }));
vi.mock('../../panel/components/SettingsModal', () => ({ SettingsModal: () => null }));
vi.mock('../../panel/components/header', () => ({ QuickSettingsMenu: () => null }));
vi.mock('../../panel/components/LoginModal', () => ({ LoginModal: () => null }));
vi.mock('../../panel/components/request-import/RequestImportModal', () => ({
  RequestImportModal: () => null,
}));
vi.mock('../LauncherModal', () => ({
  LauncherModal: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? (
      <div role="dialog">
        <button onClick={onClose}>Close scanner</button>
      </div>
    ) : null,
}));

afterEach(() => { storage.ready = true; window.history.replaceState(null, '', '/'); });

describe('device capture scanner entry', () => {
  it('shows the capture page in the popup and opens the scanner only on click', async () => {
    window.history.replaceState(null, '', '/?embedded=1&autoLaunch=0');
    render(<DeviceCapture />);
    expect(await screen.findByTestId('capture-list')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('scanQrCodeCapture'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Close scanner'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('scanQrCodeCapture'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it.each(['/', '/?embedded=1'])(
    'opens the scanner automatically for the standalone page %s',
    async path => {
      window.history.replaceState(null, '', path);
      render(<DeviceCapture />);
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
    },
  );
});

it('waits for the saved channel before accepting a controller default', async () => {
  storage.ready = false;
  const page = render(<DeviceCapture />);
  await act(async () => {});
  expect(screen.queryByTestId('capture-list')).not.toBeInTheDocument();
  storage.ready = true;
  page.rerender(<DeviceCapture />);
  expect(await screen.findByTestId('capture-list')).toBeInTheDocument();
});

it('clears requests and selection when the controller resolves another channel', async () => {
  render(<DeviceCapture />);
  await screen.findByText('Device source');
  act(() => storage.message!({ id: 1, apiName: 'previous.api', source: 'protocol', responseBody: {} }));
  fireEvent.click(screen.getByText('previous.api'));
  expect(screen.getByTestId('selected-request')).toHaveTextContent('previous.api');
  act(() => storage.select!('other'));
  expect(screen.getByTestId('capture-list')).toBeEmptyDOMElement();
  expect(screen.getByTestId('selected-request')).toBeEmptyDOMElement();
});
