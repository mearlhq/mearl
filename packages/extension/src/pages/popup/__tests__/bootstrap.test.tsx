import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  view: vi.fn(),
  input: vi.fn(),
}));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: mocks.render }) }));
vi.mock('../Popup', () => ({ Popup: () => null, initialPopupView: mocks.view }));
vi.mock('../hooks/useJsonInput', () => ({ loadJsonInput: mocks.input }));
vi.mock('../../panel/utils/config', () => ({ getConfig: async () => ({ language: 'en' }) }));
vi.mock('../../panel/utils/i18n', () => ({ initI18n: async () => {} }));
vi.mock('../../../shared/analytics', () => ({ initAnalytics: () => {} }));
vi.mock('../../../shared/fontSize', () => ({}));
import { mountPopup } from '../bootstrap';

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="root"></div>';
});

it('mounts a toolbox popup without starting formatter initialization', async () => {
  mocks.view.mockReturnValue('toolbox');
  await mountPopup();
  expect(mocks.input).not.toHaveBeenCalled();
  expect(mocks.render).toHaveBeenCalledOnce();
  expect(mocks.render.mock.calls[0][0].props.bootstrapInput).toBeUndefined();
});

it('keeps transferred formatter data in the initial render', async () => {
  mocks.view.mockReturnValue('formatter');
  const input = { inputText: '{"saved":1}', isStandalonePage: true };
  mocks.input.mockResolvedValue(input);
  await mountPopup();
  expect(mocks.input).toHaveBeenCalledOnce();
  expect(mocks.render.mock.calls[0][0].props.bootstrapInput).toBe(input);
});
