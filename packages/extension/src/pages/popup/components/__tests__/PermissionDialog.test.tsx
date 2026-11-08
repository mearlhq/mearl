import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionDialog } from '../PermissionDialog';
import {
  POPUP_PERMISSION_REQUEST,
  POPUP_PERMISSION_CANCEL,
  POPUP_PERMISSION_ALLOW,
} from '../../../../shared/permissionRequest';
import { grantAgentOriginPermission } from '../../../../shared/proxyPermissions';

vi.mock('../../../../shared/proxyPermissions', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../shared/proxyPermissions')>()),
  grantAgentOriginPermission: vi.fn(),
}));
vi.mock('../../../panel/utils/i18n', () => ({ t: (key: string) => key }));

describe('popup permission dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chrome.runtime.id = 'test-extension';
    chrome.extension = { getViews: vi.fn(() => [window]) } as never;
    vi.mocked(chrome.runtime.sendMessage).mockReset().mockResolvedValue({ granted: true });
  });

  function send(
    requestId = 'request-1',
    domain = 'example.com',
    type = POPUP_PERMISSION_REQUEST,
    sender: chrome.runtime.MessageSender = { id: chrome.runtime.id },
  ) {
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)![0];
    const respond = vi.fn();
    let result;
    act(() => {
      result = listener({ type, requestId, domain }, sender, respond);
    });
    return { respond, result };
  }

  it('shows a compact confirmation and requests Chrome permission only on Allow', async () => {
    render(<PermissionDialog />);
    const { respond, result } = send();
    expect(result).toBe(true);
    expect(await screen.findByRole('dialog')).toHaveStyle({ maxWidth: '380px' });
    expect(grantAgentOriginPermission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('agentPermRequestAllow'));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith({ granted: true, origin: '*://*.example.com/*' }),
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: POPUP_PERMISSION_ALLOW,
      requestId: 'request-1',
    });
    expect(grantAgentOriginPermission).not.toHaveBeenCalled();
  });

  it('waits for the browser decision before allowing Escape to dismiss the confirmation', async () => {
    let finish!: (decision: { granted: boolean }) => void;
    vi.mocked(chrome.runtime.sendMessage).mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    render(<PermissionDialog />);
    const { respond } = send();
    fireEvent.click(await screen.findByText('agentPermRequestAllow'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(respond).not.toHaveBeenCalled();
    await act(async () => finish({ granted: true }));
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ granted: true }));
  });

  it('denies without requesting browser permissions', async () => {
    render(<PermissionDialog />);
    const { respond } = send();
    fireEvent.click(await screen.findByText('agentPermRequestDeny'));
    expect(respond).toHaveBeenCalledWith({ granted: false, origin: undefined });
    expect(grantAgentOriginPermission).not.toHaveBeenCalled();
  });

  it('queues domains and removes cancelled requests', async () => {
    render(<PermissionDialog />);
    const first = send();
    const second = send('request-2', 'second.test');
    expect(await screen.findByText('example.com')).toBeInTheDocument();
    expect(screen.queryByText('second.test')).not.toBeInTheDocument();
    send('request-1', '', POPUP_PERMISSION_CANCEL);
    expect(await screen.findByText('second.test')).toBeInTheDocument();
    expect(first.respond).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('agentPermRequestDeny'));
    expect(second.respond).toHaveBeenCalledWith(expect.objectContaining({ granted: false }));
  });

  it('keeps a browser-denied request available for retry', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({ granted: false });
    render(<PermissionDialog />);
    const { respond } = send();
    fireEvent.click(await screen.findByText('agentPermRequestAllow'));
    expect(await screen.findByText('agentPermRequestBrowserDenied')).toBeInTheDocument();
    expect(respond).not.toHaveBeenCalled();
    expect(grantAgentOriginPermission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('agentPermRequestAllow'));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({ granted: true })),
    );
  });

  it('keeps storage failures visible without reporting approval', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({
      granted: false,
      error: 'Storage unavailable',
    });
    render(<PermissionDialog />);
    const { respond } = send();
    fireEvent.click(await screen.findByText('agentPermRequestAllow'));
    expect(await screen.findByRole('alert')).toHaveTextContent('agentPermRequestFailed');
    expect(respond).not.toHaveBeenCalled();
  });

  it('does not handle permissions in a tab or side panel', () => {
    vi.mocked(chrome.extension.getViews).mockReturnValue([]);
    render(<PermissionDialog />);
    expect(chrome.runtime.onMessage.addListener).not.toHaveBeenCalled();
  });

  it('ignores messages from page content scripts', () => {
    render(<PermissionDialog />);
    const { respond, result } = send('forged', 'example.com', POPUP_PERMISSION_REQUEST, {
      id: chrome.runtime.id,
      tab: { id: 42 } as chrome.tabs.Tab,
    });
    expect(result).toBeUndefined();
    expect(respond).not.toHaveBeenCalled();
    expect(screen.queryByText('example.com')).not.toBeInTheDocument();
  });
});
