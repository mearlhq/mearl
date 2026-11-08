import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { BrowserUiSettings } from '../../../../../shared/browserUiSettings';
const mocks = vi.hoisted(() => ({ settings: {} as BrowserUiSettings, invoke: vi.fn() }));
vi.mock('../../../utils/browserUiSettings', () => ({ useBrowserUiSettings: () => mocks.settings, getBrowserUiSettings: () => mocks.settings, callBrowserUiOperation: mocks.invoke }));
vi.mock('../../../utils/i18n', () => ({ t: (key: string) => key }));
import { SpmQueryParam } from '../SpmQueryParam';
import { TtidQueryParam } from '../TtidQueryParam';
beforeEach(() => {
  mocks.settings = { operations: { 'tracking.spmName': { hook: 'spm' }, 'tracking.ttidName': { hook: 'ttid' } } };
  mocks.invoke.mockReset();
  vi.mocked(chrome.runtime.sendMessage).mockReset().mockResolvedValue({ userId: 'fixture-user' });
});
it('keeps pending state and SPM caching while leaving identity resolution to the provider', async () => {
  let finish!: (value: unknown) => void;
  mocks.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = render(<SpmQueryParam spmValue="1.2.card.button" />);
  fireEvent.click(screen.getByTitle('querySpmName'));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('tracking.spmName', { value: '1.2.card.button' }));
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  expect(screen.getByTitle('querySpmName')).toBeDisabled();
  await act(async () => finish({ status: 'success', name: 'Card button' }));
  expect(screen.getByText('Card button')).toBeInTheDocument();
  expect(screen.getByTitle('querySpmName')).toBeEnabled();
  first.unmount(); render(<SpmQueryParam spmValue="1.2.card.button" />);
  expect(screen.getByText('Card button')).toBeInTheDocument();
  expect(mocks.invoke).toHaveBeenCalledOnce();
});
it('caches an unknown TTID and retains its original display format', async () => {
  mocks.invoke.mockResolvedValue({ status: 'unknown' });
  const first = render(<TtidQueryParam ttidValue="channel & 中文" />);
  fireEvent.click(screen.getByTitle('queryTtidName'));
  await waitFor(() => expect(screen.getByText(/queryResultUnknown/)).toBeInTheDocument());
  expect(mocks.invoke).toHaveBeenCalledWith('tracking.ttidName', { value: 'channel & 中文' });
  first.unmount(); render(<TtidQueryParam ttidValue="channel & 中文" />);
  expect(screen.getByText(/channel & 中文/)).toHaveTextContent('channel & 中文 (queryResultUnknown)');
});
it('keeps failures retryable instead of storing them as unknown data', async () => {
  mocks.invoke.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ status: 'success', name: 'Resolved', type: 'client' });
  const first = render(<TtidQueryParam ttidValue="retry" />); fireEvent.click(screen.getByTitle('queryTtidName'));
  await waitFor(() => expect(screen.getByText(/queryResultError/)).toBeInTheDocument());
  expect(screen.getByTitle('queryTtidName')).toBeEnabled(); first.unmount();
  render(<TtidQueryParam ttidValue="retry" />); expect(screen.queryByText(/queryResultError/)).toBeNull();
  fireEvent.click(screen.getByTitle('queryTtidName'));
  await waitFor(() => expect(screen.getByText(/Resolved/)).toBeInTheDocument());
});
it('discards late results and their cache after a provider selection changes', async () => {
  let finish!: (value: unknown) => void;
  mocks.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ status: 'success', name: 'New provider' });
  const view = render(<TtidQueryParam ttidValue="owned" />); fireEvent.click(screen.getByTitle('queryTtidName'));
  mocks.settings = { operations: { 'tracking.ttidName': { hook: 'replacement' } } };
  view.rerender(<TtidQueryParam ttidValue="owned" />);
  await act(async () => finish({ status: 'success', name: 'Old provider' }));
  expect(screen.queryByText(/Old provider/)).toBeNull();
  fireEvent.click(screen.getByTitle('queryTtidName'));
  await waitFor(() => expect(screen.getByText(/New provider/)).toBeInTheDocument());
  view.unmount(); render(<TtidQueryParam ttidValue="owned" />);
  expect(screen.getByText(/New provider/)).toBeInTheDocument();
});
it('discards a response after another value is selected and hides unavailable query actions', async () => {
  let finish!: (value: unknown) => void;
  mocks.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<TtidQueryParam ttidValue="first" />); fireEvent.click(screen.getByTitle('queryTtidName'));
  view.rerender(<TtidQueryParam ttidValue="second" />);
  await act(async () => finish({ status: 'success', name: 'First value' }));
  expect(screen.queryByText(/First value/)).toBeNull();
  mocks.settings = {}; view.rerender(<TtidQueryParam ttidValue="second" />);
  expect(screen.queryByTitle('queryTtidName')).toBeNull(); expect(screen.getByText('second')).toBeInTheDocument();
});
it('rejects invalid provider results without caching them', async () => {
  mocks.invoke.mockResolvedValue({ status: 'success', name: 123 });
  render(<SpmQueryParam spmValue="invalid" />); fireEvent.click(screen.getByTitle('querySpmName'));
  await waitFor(() => expect(screen.getByText('queryResultError')).toBeInTheDocument());
  expect(screen.getByTitle('querySpmName')).toBeEnabled();
});
