import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceCaptureEntry } from '../DeviceCaptureEntry';

vi.mock('../../../panel/utils/i18n', () => ({
  t: (key: string) => key,
}));

describe('DeviceCaptureEntry', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      runtime: {
        getURL: vi.fn((path: string) => `about:blank#${path}`),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hosts device capture in the toolbox and relays its back action', () => {
    const onBack = vi.fn();
    render(<DeviceCaptureEntry onBack={onBack} />);

    const frame = screen.getByTitle('realDeviceCapture') as HTMLIFrameElement;
    expect(frame).toHaveAttribute(
      'src',
      'about:blank#src/pages/device-capture/index.html?embedded=1&toolbox=1&autoLaunch=0',
    );

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'mearl-toolbox-back' },
          origin: window.location.origin,
          source: frame.contentWindow,
        }),
      );
    });
    expect(onBack).toHaveBeenCalledExactlyOnceWith();
  });

  it('keeps automatic launch available in a standalone toolbox tab', () => {
    render(<DeviceCaptureEntry surface="tab" />);
    expect(screen.getByTitle('realDeviceCapture')).toHaveAttribute(
      'src',
      'about:blank#src/pages/device-capture/index.html?embedded=1',
    );
  });

  it('places shared actions into the device capture header after the frame loads', async () => {
    render(<DeviceCaptureEntry onBack={() => {}} headerActions={<button>Switch tool</button>} />);
    const frame = screen.getByTitle('realDeviceCapture') as HTMLIFrameElement;
    const frameDocument = document.implementation.createHTMLDocument();
    Object.defineProperty(frame, 'contentDocument', { value: frameDocument });
    const slot = frameDocument.createElement('div');
    slot.id = 'mearl-toolbox-header-actions';
    frameDocument.body.appendChild(slot);
    await act(async () => {
      fireEvent.load(frame);
    });
    expect(within(slot).getByText('Switch tool').tagName).toBe('BUTTON');
  });
});
