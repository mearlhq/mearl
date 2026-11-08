import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SaveTestCaseButton } from '../SaveTestCaseButton';
const mocks = vi.hoisted(() => ({
  props: null as any,
  caseOverride: null as any,
  preferenceArea: undefined as undefined | 'session',
  storage: vi.fn(),
  ui: null as any,
  user: null as any,
  selection: 0,
  fetch: vi.fn(),
  login: vi.fn(),
  autoLogin: vi.fn((operation: any) => operation()),
}));
vi.mock('../RequestSaveButton', () => ({
  RequestSaveButton: (props: any) => {
    mocks.props = props;
    return null;
  },
}));
vi.mock('../../hooks/useBrowserRequestUi', () => ({ useBrowserRequestUi: () => mocks.ui }));
vi.mock('../../utils/safeChrome', () => ({ storageGetSafely: mocks.storage }));
vi.mock('../browser-view/viewState', () => ({ getBrowserViewState: () => ({ loaded: true, selected: { ...mocks.caseOverride ?? mocks.ui.selected, slot: 'requestCases', definition: { preferences: { appKey: mocks.preferenceArea ? { area: mocks.preferenceArea } : {} } } } }), refreshBrowserView: async () => {} }));
vi.mock('../../hooks/useCaptureIdentity', () => ({
  captureIdentitySelection: () => mocks.selection,
  useCaptureIdentity: () => ({
    userInfo: mocks.user,
    fetchUserInfo: mocks.fetch,
    openLoginWindow: mocks.login,
  }),
  withCaptureAutoLogin: mocks.autoLogin,
}));
const state = (revision: string) => ({
  selected: { bundleId: 'browser-internal', revision },
  definition: { save: { hook: 'request.example.save', setting: 'requestCasesEnabled' } },
});
const props = { apiName: 'mtop.demo', mockBody: { ok: true }, onMockConfigChange: vi.fn() };
const choice = { id: 7, label: 'Suite', value: { id: 7, appname: 'demo' } };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.ui = state('A');
  mocks.selection = 0;
  mocks.caseOverride = null;
  mocks.preferenceArea = undefined;
  mocks.storage.mockImplementation(async (keys: string[]) => ({ [keys[0]]: '123' }));
  mocks.user = { subject: 'member-1', displayName: '完整昵称', complete: true };
  chrome.runtime.sendMessage = vi
    .fn()
    .mockResolvedValue({ success: true, data: { success: true, data: [choice] } });
});
afterEach(cleanup);
it('keeps a displayed choice bound to its producing provider after a replacement search fails', async () => {
  const view = render(<SaveTestCaseButton {...props} />);
  const original = (await mocks.props.loadChoices('')).data[0];
  mocks.ui = state('B');
  view.rerender(<SaveTestCaseButton {...props} />);
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({
    success: true,
    data: { success: false, error: 'Owned list failure' },
  });
  expect(await mocks.props.loadChoices('new')).toMatchObject({ success: false });
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({
    success: false,
    error: 'The request UI provider changed',
  });
  await expect(mocks.props.save(original.value, undefined)).rejects.toThrow('provider changed');
  expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      action: 'browserRequestUi',
      data: expect.objectContaining({
        revision: 'A',
        input: expect.objectContaining({ suite: choice.value }),
      }),
    }),
  );
});
it('retains each list response identity when A completes after B', async () => {
  let finish!: (value: any) => void;
  vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const view = render(<SaveTestCaseButton {...props} />);
  const first = mocks.props.loadChoices('slow');
  mocks.ui = state('B');
  view.rerender(<SaveTestCaseButton {...props} />);
  const second = await mocks.props.loadChoices('new');
  finish({ success: true, data: { success: true, data: [choice] } });
  const late = await first;
  expect(late.data[0].value.provider.selected.revision).toBe('A');
  expect(second.data[0].value.provider.selected.revision).toBe('B');
});
it('refreshes partial identity before saving and keeps automatic-login wrapping', async () => {
  mocks.user = { subject: 'member-1', complete: false };
  mocks.fetch.mockResolvedValue({ success: true, data: { subject: 'member-1', displayName: '完整昵称', complete: true } });
  render(<SaveTestCaseButton {...props} />);
  const suite = (await mocks.props.loadChoices('')).data[0].value;
  await mocks.props.save(suite, undefined);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  expect(mocks.autoLogin).toHaveBeenCalledTimes(1);
  expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        input: expect.objectContaining({
          creator: '完整昵称',
          apiName: 'mtop.demo',
          mockBody: { ok: true },
        }),
      }),
    }),
  );
});
it('opens the existing shared login on missing identity without issuing a save', async () => {
  mocks.user = null;
  mocks.fetch.mockResolvedValue({ success: false, error: 'Please login' });
  render(<SaveTestCaseButton {...props} />);
  await expect(
    mocks.props.save(undefined, { id: 'x', appname: 'demo', caseId: 7 }),
  ).rejects.toThrow('captureLoginRequired');
  expect(mocks.login).toHaveBeenCalledTimes(1);
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});

it.each([
  { success: false, error: 'Capture identity provider changed' },
  { success: true, data: { subject: 'member-1', displayName: 'Old provider', complete: true } },
])('does not log in or save through another preset after identity completion: $success', async result => {
  mocks.user = { subject: 'member-1', complete: false };
  let finish!: (value: unknown) => void;
  mocks.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<SaveTestCaseButton {...props} />);
  const pending = mocks.props.save(undefined, undefined);
  mocks.selection++;
  mocks.ui = state('B');
  view.rerender(<SaveTestCaseButton {...props} />);
  finish(result);
  await expect(pending).rejects.toThrow('Capture identity provider changed');
  expect(mocks.login).not.toHaveBeenCalled();
  expect(mocks.autoLogin).not.toHaveBeenCalled();
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});

it('does not read an application selection owned by another case provider', async () => {
  mocks.caseOverride = { bundleId: 'other-provider', revision: 'A' };
  render(<SaveTestCaseButton {...props} />);
  await mocks.props.loadChoices('');
  expect(mocks.storage).not.toHaveBeenCalled();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ input: { operation: 'list', appKey: undefined, search: '' } }) }));
});

it('does not read session-scoped application preferences from Chrome local storage', async () => {
  mocks.preferenceArea = 'session';
  render(<SaveTestCaseButton {...props} />);
  await mocks.props.loadChoices('');
  expect(mocks.storage).not.toHaveBeenCalled();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ input: { operation: 'list', appKey: undefined, search: '' } }) }));
});
