import { BundleError } from './bundle.js';
import { createBundleFetchLoader } from './bundleFetch.js';

const githubReference = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)(?:@([A-Za-z0-9._/-]+))?$/;

export function parseProfileSource(input: string): { origin: string; url: string; github?: { repository: string; ref: string } } {
  if (typeof input !== 'string' || input.length > 2048) throw new BundleError('BUNDLE_INVALID', 'Invalid App profile source');
  const match = githubReference.exec(input.trim());
  if (match && match[2] !== '.' && match[2] !== '..') {
    return {
      origin: 'https://raw.githubusercontent.com',
      url: input.trim(),
      github: { repository: `${match[1]}/${match[2]}`, ref: match[3] ?? 'HEAD' },
    };
  }
  let url: URL;
  try { url = new URL(input); }
  catch { throw new BundleError('BUNDLE_INVALID', 'Use a GitHub owner/repo or an HTTPS bundle manifest URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new BundleError('BUNDLE_INVALID', 'App profile bundle URLs require HTTPS without credentials or a fragment');
  }
  return { origin: url.origin, url: url.href };
}

export async function resolveProfileSource(input: string, fetcher = fetch): Promise<string> {
  const { url, github } = parseProfileSource(input);
  if (!github) return url;
  const { repository, ref } = github;
  let sha = ref;
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    const load = createBundleFetchLoader({ fetch: fetcher });
    const bytes = await load(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}`, {
      maxBytes: 2 * 1024 * 1024,
      signal: AbortSignal.timeout(10000),
    });
    sha = JSON.parse(new TextDecoder().decode(bytes)).sha;
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) throw new BundleError('BUNDLE_INVALID', 'GitHub did not return a commit ID');
  }
  return `https://raw.githubusercontent.com/${repository}/${sha}/bundle.json`;
}
