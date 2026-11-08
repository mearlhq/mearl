import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResizablePanels } from '../ResizablePanels';

vi.mock('../../hooks/useLocalStorage', async () => {
  const { useState } = await import('react');

  return {
    useLocalStorage: <T,>(_key: string, initialValue: T) => {
      const [value, setValue] = useState(initialValue);
      return [value, setValue, true];
    },
  };
});

describe('ResizablePanels', () => {
  let matchesNarrowViewport = false;
  let mediaListeners: Set<(event: MediaQueryListEvent) => void>;

  beforeEach(() => {
    matchesNarrowViewport = false;
    mediaListeners = new Set();

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((media: string) => ({
        get matches() {
          return matchesNarrowViewport;
        },
        media,
        onchange: null,
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          mediaListeners.add(listener);
        },
        removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          mediaListeners.delete(listener);
        },
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  const renderPanels = () =>
    render(
      <ResizablePanels
        leftPanel={<div>list</div>}
        rightPanel={<div>detail</div>}
        storageKey="test-panel-size"
      />,
    );

  const setNarrowViewport = (matches: boolean) => {
    matchesNarrowViewport = matches;
    act(() => {
      mediaListeners.forEach(listener =>
        listener({ matches, media: '(max-width: 719px)' } as MediaQueryListEvent),
      );
    });
  };

  it('switches from side-by-side panels to stacked panels on narrow viewports', () => {
    renderPanels();

    const separator = screen.getByRole('separator');
    const listPanel = screen.getByText('list').parentElement!;
    const container = listPanel.parentElement!;

    expect(container).toHaveClass('flex-row');
    expect(separator).toHaveAttribute('aria-orientation', 'vertical');
    expect(listPanel).toHaveStyle({ width: '30%', height: '100%' });

    setNarrowViewport(true);

    expect(container).toHaveClass('flex-col');
    expect(separator).toHaveAttribute('aria-orientation', 'horizontal');
    expect(listPanel).toHaveStyle({ width: '100%', height: '40%' });
  });

  it('resizes the top panel vertically without changing the desktop width', () => {
    matchesNarrowViewport = true;
    renderPanels();

    const separator = screen.getByRole('separator');
    const listPanel = screen.getByText('list').parentElement!;
    const container = listPanel.parentElement!;
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      width: 600,
      height: 1000,
      top: 50,
      left: 0,
      right: 600,
      bottom: 1050,
      x: 0,
      y: 50,
      toJSON: () => ({}),
    });

    fireEvent.mouseDown(separator);
    fireEvent.mouseMove(document, { clientY: 550 });
    fireEvent.mouseUp(document);

    expect(listPanel).toHaveStyle({ height: '50%' });

    setNarrowViewport(false);
    expect(listPanel).toHaveStyle({ width: '30%', height: '100%' });
  });
});
