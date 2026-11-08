import { expect, it, vi } from 'vitest';
import { parseProfileSource, resolveProfileSource } from '../profileSource.js';

it('pins a GitHub repository default branch or named ref to its commit', async () => {
  const sha = 'a'.repeat(40);
  const fetcher = vi.fn(async (_input: RequestInfo | URL) => Response.json({ sha }));
  const url = `https://raw.githubusercontent.com/example/profiles/${sha}/bundle.json`;
  await expect(resolveProfileSource('example/profiles', fetcher)).resolves.toBe(url);
  await expect(resolveProfileSource('example/profiles@release/3', fetcher)).resolves.toBe(url);
  await expect(resolveProfileSource(`example/profiles@${sha}`, fetcher)).resolves.toBe(url);
  expect(fetcher.mock.calls.map(([input]) => input)).toEqual([
    'https://api.github.com/repos/example/profiles/commits/HEAD',
    'https://api.github.com/repos/example/profiles/commits/release%2F3',
  ]);
});

it('accepts full HTTPS sources without resolving them via GitHub', async () => {
  const fetcher = vi.fn();
  const source = 'https://example.test/bundles/bundle.json';
  await expect(resolveProfileSource(source, fetcher)).resolves.toBe(source);
  expect(fetcher).not.toHaveBeenCalled();
  expect(() => parseProfileSource('http://example.test/bundle.json')).toThrow('HTTPS');
  expect(() => parseProfileSource('@example/profiles')).toThrow('GitHub');
});
