import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QRCodePopup } from '../QRCodePopup';

vi.mock('../../utils/qrCode', () => ({
  generateQrCodeSvgMarkup: (url: string) => `<svg viewBox="0 0 21 21" data-url="${url}"></svg>`,
}));

vi.mock('../../utils/i18n', () => ({
  t: (key: string) => key,
}));

describe('QRCodePopup', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes after the pointer leaves its trigger', () => {
    vi.useFakeTimers();
    const targetRef = createRef<HTMLButtonElement>();
    const onClose = vi.fn();
    render(
      <>
        <button ref={targetRef}>QR</button>
        <QRCodePopup url="https://example.com" targetRef={targetRef} onClose={onClose} />
      </>,
    );

    screen.getByRole('img', { name: 'QR Code' });
    fireEvent.mouseLeave(targetRef.current!);
    vi.advanceTimersByTime(150);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the popup open while moving from its trigger into the popup', () => {
    vi.useFakeTimers();
    const targetRef = createRef<HTMLButtonElement>();
    const onClose = vi.fn();
    render(
      <>
        <button ref={targetRef}>QR</button>
        <QRCodePopup url="https://example.com" targetRef={targetRef} onClose={onClose} />
      </>,
    );

    const qrImage = screen.getByRole('img', { name: 'QR Code' });
    const popup = qrImage.closest('.qr-code-popup')!;
    fireEvent.mouseLeave(targetRef.current!);
    vi.advanceTimersByTime(75);
    fireEvent.mouseEnter(popup);
    vi.advanceTimersByTime(150);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseLeave(popup);
    vi.advanceTimersByTime(150);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('switches between Android/iOS and Harmony QR code URLs', () => {
    const targetRef = createRef<HTMLButtonElement>();
    render(
      <>
        <button ref={targetRef}>QR</button>
        <QRCodePopup
          url="https://account.example/mobile"
          harmonyUrl="https://harmony.example/mobile"
          targetRef={targetRef}
          onClose={vi.fn()}
        />
      </>,
    );

    expect(screen.getByRole('img', { name: 'QR Code' }).querySelector('svg')).toHaveAttribute(
      'data-url',
      'https://account.example/mobile',
    );

    fireEvent.click(screen.getByRole('button', { name: 'accountSwitchToHarmony' }));
    expect(screen.getByRole('img', { name: 'QR Code' }).querySelector('svg')).toHaveAttribute(
      'data-url',
      'https://harmony.example/mobile',
    );
    expect(screen.getByRole('button', { name: 'accountSwitchToAndroidIos' })).toBeInTheDocument();
  });
});
