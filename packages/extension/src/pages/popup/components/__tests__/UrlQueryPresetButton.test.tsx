import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { UrlQueryPresetButton } from '../UrlQueryPresetButton';

const state = vi.hoisted(() => ({
  language: 'zh_CN',
  config: {} as Record<string, unknown>,
  update: vi.fn(),
  ui: { queryPresets: { overlay: { label: { en: 'Overlay', zh_CN: '浮层' }, params: [{ key: 'mode', value: 'overlay' }] } } },
}));
vi.mock('../../../panel/utils/i18n', () => ({ t: (key: string) => key, getCurrentLanguage: () => state.language }));
vi.mock('../../../panel/utils/browserUiSettings', () => ({ useBrowserUiSettings: () => state.ui }));
vi.mock('../../../panel/utils/config', () => ({ getConfig: async () => state.config, updateConfig: state.update, onConfigChange: () => () => {} }));
vi.mock('../../../panel/hooks/useLocalStorage', () => ({ useLocalStorage: () => [true, vi.fn()] }));

beforeEach(() => {
  state.language = 'zh_CN';
  state.config = { queryPresets: [{ id: 'overlay', params: [{ key: 'mode', value: 'overlay' }] }], seenBuiltinPresetIds: ['overlay'] };
  state.update.mockClear();
});

it('resolves already-seen unlabeled presets from the current catalog and locale', async () => {
  const view = render(<UrlQueryPresetButton query="" onToggle={vi.fn()} />);
  await screen.findByText('浮层');
  state.language = 'en';
  view.rerender(<UrlQueryPresetButton query="" onToggle={vi.fn()} />);
  expect(screen.getByText('Overlay')).toBeTruthy();
  expect(state.update).not.toHaveBeenCalled();
});

it('seeds catalog entries without persisting a localized label', async () => {
  state.config = {};
  render(<UrlQueryPresetButton query="" onToggle={vi.fn()} />);
  await waitFor(() => expect(state.update).toHaveBeenCalledWith({
    queryPresets: [{ id: 'overlay', params: [{ key: 'mode', value: 'overlay' }] }], seenBuiltinPresetIds: ['overlay'],
  }));
});
