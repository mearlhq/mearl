import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeAccountSsoTicket } from '../accountSsoFrame';

describe('Accounts offscreen SSO frame', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('consumes the ticket in a hidden sandboxed iframe', async () => {
    const pageDocument = document.implementation.createHTMLDocument('offscreen');
    const result = consumeAccountSsoTicket('about:blank#ticket=one', pageDocument);
    const iframe = pageDocument.querySelector('iframe');

    expect(iframe).not.toBeNull();
    expect(iframe?.src).toBe('about:blank#ticket=one');
    expect(iframe?.sandbox.contains('allow-scripts')).toBe(true);
    expect(iframe?.sandbox.contains('allow-same-origin')).toBe(true);
    iframe?.dispatchEvent(new Event('load'));

    await expect(result).resolves.toBe(true);
    expect(pageDocument.querySelector('iframe')).toBeNull();
  });

  it('removes the iframe when ticket loading times out', async () => {
    const pageDocument = document.implementation.createHTMLDocument('offscreen');
    const appendChild = vi.spyOn(pageDocument.body, 'appendChild').mockImplementation(node => node);
    const result = consumeAccountSsoTicket('about:blank#ticket=one', pageDocument, 1000);

    await vi.advanceTimersByTimeAsync(1000);

    await expect(result).resolves.toBe(false);
    expect(appendChild).toHaveBeenCalledOnce();
    expect(pageDocument.querySelector('iframe')).toBeNull();
  });
});
