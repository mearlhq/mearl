import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PresetPermissionPrompt } from '../PresetPermissionPrompt';
import { BROWSER_REQUEST_UI_CHANGED } from '../../../shared/browserRequestUi';

vi.mock('../../panel/utils/i18n', () => ({ t: (key: string) => key }));

const revision = 'a'.repeat(64);
const pending = ['https://example.com/*', '*://*.example.org/*'];

function mockChrome(sendMessage: ReturnType<typeof vi.fn>, request: ReturnType<typeof vi.fn>) {
  const onMessage = { addListener: vi.fn(), removeListener: vi.fn() };
  vi.stubGlobal('chrome', { runtime: { sendMessage, onMessage }, permissions: { request } });
  return onMessage.addListener;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('requests the pending sites as one batch and closes after the extension saves the grant', async () => {
  const request = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const sendMessage = vi
    .fn()
    .mockResolvedValueOnce({
      success: true,
      data: { presetId: 'test', revision, origins: [...pending, 'https://example.net/*'], pending },
    })
    .mockResolvedValueOnce({
      success: true,
      data: { presetId: 'test', revision, pending: [] },
    });
  mockChrome(sendMessage, request);
  const close = vi.spyOn(window, 'close').mockImplementation(() => {});
  render(<PresetPermissionPrompt revision={revision} />);

  const list = await screen.findByRole('list', { name: 'presetPermissionPromptSites' });
  expect(list).toHaveTextContent(pending[0]);
  expect(list).toHaveTextContent(pending[1]);
  expect(list).not.toHaveTextContent('example.net');
  expect(request).not.toHaveBeenCalled();

  const allow = screen.getByRole('button', { name: 'presetPermissionsGrant' });
  fireEvent.click(allow);
  expect(request).toHaveBeenCalledExactlyOnceWith({ origins: pending });
  await screen.findByRole('alert');
  expect(sendMessage).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();

  fireEvent.click(allow);
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(sendMessage).toHaveBeenLastCalledWith({
    action: 'browserUiService',
    data: { operation: 'authorizePreset', presetId: 'test', revision },
  });
});

it('does not request access if the window belongs to a superseded preset', async () => {
  const request = vi.fn();
  mockChrome(
    vi.fn().mockResolvedValue({
      success: true,
      data: { presetId: 'new', revision: 'b'.repeat(64), pending },
    }),
    request,
  );
  render(<PresetPermissionPrompt revision={revision} />);
  await screen.findByText('presetPermissionPromptChanged');
  expect(screen.getByRole('button', { name: 'presetPermissionsGrant' })).toBeDisabled();
  expect(request).not.toHaveBeenCalled();
});

it('reloads pending sites when a preset sync reuses the window or a grant fails', async () => {
  const anotherSite = 'https://example.net/*';
  const request = vi.fn().mockResolvedValue(true);
  const sendMessage = vi
    .fn()
    .mockRejectedValueOnce(new Error('Status unavailable'))
    .mockResolvedValueOnce({ success: true, data: { presetId: 'test', revision, pending } })
    .mockResolvedValueOnce({ success: false })
    .mockResolvedValueOnce({
      success: true,
      data: { presetId: 'test', revision, pending: [anotherSite] },
    });
  const listen = mockChrome(sendMessage, request);
  render(<PresetPermissionPrompt revision={revision} />);
  await screen.findByText('agentPermRequestFailed');

  act(() => {
    listen.mock.calls[0][0]({ action: BROWSER_REQUEST_UI_CHANGED });
  });
  await screen.findByText(pending[0]);
  fireEvent.click(screen.getByRole('button', { name: 'presetPermissionsGrant' }));
  await screen.findByText(anotherSite);
  expect(screen.queryByText(pending[0])).toBeNull();
});
