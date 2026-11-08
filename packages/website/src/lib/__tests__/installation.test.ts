import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadInstallationConfig, parseInstallationConfig } from '../installation.mjs';

const origin = 'https://mearlhq.github.io';
const guide = { url: 'https://guide.example.test/installed.html' };
afterEach(() => vi.unstubAllGlobals());
describe('installation deployment configuration', () => {
  it('defaults to a public page without probing a configured service', () => {
    expect(parseInstallationConfig({ schemaVersion: 1 }, origin)).toEqual({ schemaVersion: 1 });
  });
  it('accepts a single cross-origin guide URL', () => {
    expect(parseInstallationConfig({ schemaVersion: 1, guide }, origin)).toEqual({
      schemaVersion: 1,
      guide,
    });
  });
  it.each([
    null,
    {},
    { schemaVersion: 2 },
    { schemaVersion: 1, script: 'ignored?' },
    ...[
      { ...guide, url: 'http://guide.example.test/' },
      { ...guide, url: 'https://user:password@guide.example.test/' },
      { ...guide, url: 'https://guide.example.test/#code' },
      { ...guide, registry: 'https://registry.example.test/' },
      { url: `${origin}/guide` },
      { ...guide, command: 'execute' },
    ].map(guide => ({ schemaVersion: 1, guide })),
  ])('rejects invalid or executable deployment input %j', config => {
    expect(() => parseInstallationConfig(config, origin)).toThrow();
  });
  it('loads without credentials, redirects or cache', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ schemaVersion: 1, guide }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    expect(
      await loadInstallationConfig('https://site.example.test/installation.json', origin, signal),
    ).toEqual({ schemaVersion: 1, guide });
    expect(fetch).toHaveBeenCalledWith('https://site.example.test/installation.json', {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal,
    });
  });
  it.each([
    () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }),
    () => new Response('x'.repeat(65_537), { headers: { 'content-type': 'application/json' } }),
  ])('rejects fallback pages and oversized response bodies', async response => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
    await expect(
      loadInstallationConfig(
        'https://site.example.test/installation.json',
        origin,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
});
