import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  operation: vi.fn(), copy: vi.fn(), userId: vi.fn(), toast: vi.fn(),
  settings: { operations: { 'logs.share': { hook: 'logs.share' } } } as any,
}));
vi.mock('../../../utils/browserUiSettings', () => ({ callBrowserUiOperation: mocks.operation, useBrowserUiSettings: () => mocks.settings }));
vi.mock('../../../utils/clipboard', () => ({ copyToClipboard: mocks.copy }));
vi.mock('../../../utils/accounts', () => ({ fetchAccountIdentity: mocks.userId }));
vi.mock('../../../utils/toast', () => ({ showToast: mocks.toast }));
vi.mock('../../../utils/i18n', () => ({ t: (key: string) => key }));
import { ShareLogLinkButton } from '../ShareLogLinkButton';
const request = { apiName: 'mtop.fixture.query', timestampMs: 100000, headers: [{ name: 'X-UID', value: 'device-user' }, { name: 'X-UTDID', value: 'device' }], responseHeaders: [{ name: 'EagleEye-TraceId', value: 'fixture-trace' }] } as any;
beforeEach(() => {
  mocks.operation.mockReset().mockResolvedValue('https://logs.example.test/#/log?uid=device-user');
  mocks.copy.mockReset().mockResolvedValue(true);
  mocks.userId.mockReset().mockResolvedValue({ value: 'browser-user', watch: [] });
  mocks.toast.mockReset(); mocks.settings = { operations: { 'logs.share': { hook: 'logs.share' } } };
});
it('keeps the original control and prefers request identity without reading the browser account', async () => {
  render(<ShareLogLinkButton request={request} />);
  const button = screen.getByTitle('shareLogLink');
  expect(button).toHaveClass('h-5', 'w-5');
  fireEvent.click(button);
  await waitFor(() => expect(mocks.copy).toHaveBeenCalledWith('https://logs.example.test/#/log?uid=device-user'));
  expect(mocks.operation).toHaveBeenCalledExactlyOnceWith('logs.share', { apiName: request.apiName, timestampMs: 100000, traceId: 'fixture-trace', uid: 'device-user', utdid: 'device' });
  expect(mocks.userId).not.toHaveBeenCalled();
  expect(button.querySelector('.text-green-500')).not.toBeNull();
});
it('keeps the browser identity fallback and shares trace-only requests', async () => {
  render(<ShareLogLinkButton request={{ ...request, apiName: '', headers: [] }} />);
  fireEvent.click(screen.getByTitle('shareLogLink'));
  await waitFor(() => expect(mocks.copy).toHaveBeenCalled());
  expect(mocks.userId).toHaveBeenCalledOnce();
  expect(mocks.operation).toHaveBeenCalledWith('logs.share', expect.objectContaining({ apiName: '', uid: 'browser-user', traceId: 'fixture-trace' }));
});
it('hides the control without a provider or sufficient request fields', () => {
  const { rerender } = render(<ShareLogLinkButton request={{ ...request, apiName: '', responseHeaders: [] }} />);
  expect(screen.queryByRole('button')).toBeNull();
  mocks.settings = {};
  rerender(<ShareLogLinkButton request={request} />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(mocks.operation).not.toHaveBeenCalled();
});
it.each(['provider failure', 'invalid URL'])('retains the control after %s without copying an invalid link', async failure => {
  if (failure === 'provider failure') mocks.operation.mockRejectedValue(new Error('failed'));
  else mocks.operation.mockResolvedValue('javascript:fixture');
  render(<ShareLogLinkButton request={request} />);
  fireEvent.click(screen.getByTitle('shareLogLink'));
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('copyFailed', 'error'));
  expect(mocks.copy).not.toHaveBeenCalled();
  expect(screen.getByTitle('shareLogLink')).toBeInTheDocument();
});
