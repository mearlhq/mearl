import { beforeEach, expect, it, vi } from 'vitest';
import { requestUiFixture as legacyBrowserRequestUi } from '../../../../test/fixtures/requestUi';
import { SERVICE_DEFAULTS_CACHE_KEY } from '../../../../shared/externalServices';
import { getConfig, updateConfig, onConfigChange } from '../config';
const mocks = vi.hoisted(() => ({
  state: null as any,
  ensure: vi.fn(),
  preference: vi.fn(),
  subscribe: vi.fn(() => () => {}),
}));
vi.mock('../browserRequestUiState', () => ({
  getBrowserRequestUiState: () => mocks.state,
  ensureBrowserRequestUiState: mocks.ensure,
  updateBrowserRequestUiPreference: mocks.preference,
  subscribeBrowserRequestUi: mocks.subscribe,
}));
let preferences: Record<string, unknown>, cache: unknown;
let changed: (changes: Record<string, any>, area: string) => void;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensure.mockReset().mockImplementation(async () => mocks.state);
  preferences = {};
  cache = { services: { customMetadataEnabled: true } };
  mocks.state = {
    selected: { revision: 'custom' },
    definition: {
      ...legacyBrowserRequestUi,
      setting: { ...legacyBrowserRequestUi.setting, key: 'customMetadataEnabled' },
    },
  };
  chrome.storage.sync = {
    get: vi.fn((defaults, cb) => cb({ ...defaults, ...preferences })),
    set: vi.fn((_value, cb) => cb()),
  } as any;
  chrome.storage.session = { get: vi.fn(async () => ({ [SERVICE_DEFAULTS_CACHE_KEY]: cache })) } as any;
  vi.mocked(chrome.storage.onChanged.addListener).mockImplementation(listener => {
    changed = listener as any;
  });
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ success: true });
});
it('maps the selected service preference into the original UI slot without inheriting the former provider preference', async () => {
  preferences = { requestMetadataEnabled: false };
  expect((await getConfig()).requestMetadataEnabled).toBe(true);
  preferences.customMetadataEnabled = false;
  expect((await getConfig()).requestMetadataEnabled).toBe(false);
  cache = { };
  preferences.customMetadataEnabled = true;
  expect((await getConfig()).requestMetadataEnabled).toBe(true);
});
it('saves the current provider preference while ordinary settings use the existing path', async () => {
  await updateConfig({ requestMetadataEnabled: false, language: 'en' });
  expect(mocks.preference).toHaveBeenCalledWith(false);
  expect(chrome.storage.sync.set).toHaveBeenCalledWith({ language: 'en' }, expect.any(Function));
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});
it('recomputes the original UI slot when the selected provider setting changes', async () => {
  const listener = vi.fn();
  const unsubscribe = onConfigChange(listener);
  try {
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    preferences.customMetadataEnabled = false;
    changed({ customMetadataEnabled: { newValue: false } }, 'sync');
    await vi.waitFor(() =>
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({ requestMetadataEnabled: false }),
      ),
    );
  } finally {
    unsubscribe();
  }
});

it('renders no metadata service before installation even when an old preference is enabled', async () => {
  mocks.state = { selected: null, definition: null }; preferences = { requestMetadataEnabled: true };
  expect((await getConfig()).requestMetadataEnabled).toBe(false);
});

it('reads preview preferences without waiting for request UI bundle initialization', async () => {
  mocks.state = { selected: null, definition: null };
  mocks.ensure.mockImplementation(() => new Promise(() => {}));
  preferences = { language: 'en', agentEnabled: false };
  expect(await getConfig({ localOnly: true })).toMatchObject({
    language: 'en', agentEnabled: false, requestMetadataEnabled: false,
  });
  expect(mocks.ensure).not.toHaveBeenCalled();
});
