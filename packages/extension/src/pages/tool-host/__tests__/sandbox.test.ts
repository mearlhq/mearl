import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('plugin sandbox host', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.replaceChildren();
  });

  it('allows forms in the nested plugin frame', async () => {
    await import('../sandbox');

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: location.origin,
        data: {
          type: 'mearl-plugin-load',
          html: '<!doctype html><html><body><form></form></body></html>',
        },
      }),
    );

    const frame = document.body.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame).toHaveAttribute('sandbox', 'allow-downloads allow-forms allow-scripts');
  });

  it('rejects plugin markup sent by a web parent', async () => {
    await import('../sandbox');
    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      origin: 'https://example.test',
      data: { type: 'mearl-plugin-load', html: '<p>External markup</p>' },
    }));
    expect(document.body.querySelector('iframe')).toBeNull();
  });
});
