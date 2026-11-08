import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatVisualization } from '../components/ChatVisualization';

describe('ChatVisualization', () => {
  it('reveals the preview at its first valid height', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        getURL: () => 'about:blank',
        sendMessage: vi.fn().mockResolvedValue({ success: true, data: { html: '<svg></svg>' } }),
      },
    });
    try {
      const { container } = render(<ChatVisualization path="/output/chart.html" title="Example" />);
      const chart = container.querySelector<HTMLElement>('[data-chat-visualization]')!;
      const frame = (await screen.findByTitle('Example')) as HTMLIFrameElement;
      expect(frame).toHaveAttribute('aria-hidden', 'true');
      expect(screen.getByRole('status')).toBeInTheDocument();

      const reportHeight = (height: number) =>
        fireEvent(
          window,
          new MessageEvent('message', {
            source: frame.contentWindow,
            data: { type: 'mearl-chat-visualization-size', height },
          }),
        );

      reportHeight(0);
      expect(frame).toHaveAttribute('aria-hidden', 'true');
      expect(screen.getByRole('status')).toBeInTheDocument();

      reportHeight(330);
      expect(chart.style.height).toBe('330px');
      expect(frame).toHaveAttribute('aria-hidden', 'false');
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
