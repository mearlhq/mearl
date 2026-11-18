import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { copyToClipboard } from '../../../utils/clipboard';
import { showToast } from '../../../utils/toast';
import { HeatmapButton, type HeatmapButtonProps } from '../HeatmapButton';

vi.mock('../../../utils/browserUiSettings', () => ({
  useBrowserUiSettings: () => ({
    heatmap: {
      measures: [
        { id: 'views', label: { en: 'Views' }, format: 'number' },
        { id: 'ratio', label: { en: 'Rate' }, format: 'percent' },
      ],
    },
  }),
}));
vi.mock('../../../utils/i18n', () => ({
  getCurrentLanguage: () => 'en',
  t: (key: string) => key,
}));
vi.mock('../../../utils/clipboard', () => ({ copyToClipboard: vi.fn() }));
vi.mock('../../../utils/toast', () => ({ showToast: vi.fn() }));

const props: HeatmapButtonProps = {
  pageSpmAB: '123.example',
  heatmapMeasures: [],
  heatmapDs: '20261117',
  heatmapStatus: 'idle',
  heatmapError: null,
  heatmapErrorCode: null,
  onSelectMeasure: () => {},
  onSelectDs: () => {},
};

it('opens the selector without choosing a metric and closes it without changing the metric', () => {
  const onSelectMeasure = vi.fn();
  render(<HeatmapButton {...props} onSelectMeasure={onSelectMeasure} />);
  const trigger = screen.getByRole('button', { name: 'heatmap' });

  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(onSelectMeasure).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Views' }));
  expect(onSelectMeasure).toHaveBeenCalledExactlyOnceWith('views');

  fireEvent.click(trigger);
  expect(screen.queryByRole('button', { name: 'Views' })).toBeNull();
  expect(onSelectMeasure).toHaveBeenCalledOnce();
});

it('keeps selected metrics individually available while data loads', () => {
  const onSelectMeasure = vi.fn();
  render(
    <HeatmapButton
      {...props}
      heatmapMeasures={['views', 'ratio']}
      heatmapStatus="loading"
      onSelectMeasure={onSelectMeasure}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'heatmap' }));
  const views = screen.getByRole('button', { name: 'Views', pressed: true });
  expect(screen.getByRole('button', { name: 'Rate', pressed: true })).toBeEnabled();
  fireEvent.click(views);
  expect(onSelectMeasure).toHaveBeenCalledExactlyOnceWith('views');
});

it('copies only the AB value when the value is clicked', async () => {
  vi.mocked(copyToClipboard).mockResolvedValueOnce(true);
  render(<HeatmapButton {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'heatmap' }));
  fireEvent.click(screen.getByRole('button', { name: 'copy 123.example' }));

  expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith('123.example');
  await waitFor(() => expect(showToast).toHaveBeenCalledWith('heatmapSpmABCopied', 'success'));
});
