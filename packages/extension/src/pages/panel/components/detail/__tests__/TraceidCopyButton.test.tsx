import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceidCopyButton } from '../TraceidCopyButton';
import * as clipboard from '../../../utils/clipboard';

vi.mock('../../../utils/clipboard', () => ({
  copyToClipboard: vi.fn(),
}));

vi.mock('../../../utils/i18n', () => ({
  t: (key: string) => (key === 'copyFullTraceid' ? '复制完整 Trace ID' : key),
}));

describe('TraceidCopyButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('仅展示 traceid 的前 8 位', () => {
    render(<TraceidCopyButton traceid="2150422717879013221581253e13e7" />);

    expect(screen.getByText('#21504227')).toBeInTheDocument();
    expect(screen.queryByText('2150422717879013221581253e13e7')).not.toBeInTheDocument();
  });

  it('点击后复制完整 traceid', async () => {
    const copyToClipboardMock = vi.mocked(clipboard.copyToClipboard);
    copyToClipboardMock.mockResolvedValue(true);
    const traceid = '2150422717879013221581253e13e7';

    render(<TraceidCopyButton traceid={traceid} />);
    fireEvent.click(screen.getByRole('button', { name: '复制完整 Trace ID' }));

    await waitFor(() => {
      expect(copyToClipboardMock).toHaveBeenCalledWith(traceid);
    });
  });
});
