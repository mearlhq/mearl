import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../../panel/utils/browserUiSettings', () => ({
  callBrowserUiOperationResult: mocks.invoke,
}));
import { resolveSkillCatalog } from '../skillCatalog';
import { publicSkillCatalog } from '../publicSkillCatalog';
import releasedSkills from '../../../../../../skills/catalog.json';
const provider = { bundleId: 'custom', revision: 'accepted-config' };
const skill = {
  id: 'sample',
  name: 'sample',
  source: 'example/repo',
  sourceType: 'custom',
  description: 'Example',
  installs: 3,
  tags: [],
  collectionIds: [],
  files: ['skills/sample/SKILL.md'],
  pageUrl: 'https://catalog.example.test/sample',
  installSource: 'https://code.example.test/example/repo',
};
beforeEach(() => {
  mocks.invoke.mockReset();
});
afterEach(() => vi.restoreAllMocks());
it('pins description, search and preview to the accepted provider and propagates cancellation', async () => {
  mocks.invoke
    .mockResolvedValueOnce({
      data: {
        available: true,
        managerId: 'custom',
        title: 'Catalog',
        homeUrl: 'https://catalog.example.test',
      },
      provider,
    })
    .mockResolvedValueOnce({ data: { skills: [skill] }, provider })
    .mockResolvedValueOnce({ data: '# Skill', provider });
  const signal = new AbortController().signal;
  const catalog = await resolveSkillCatalog(signal);
  expect(catalog.managerId).toBe('custom');
  expect(await catalog.search('sample', signal)).toEqual({ skills: [skill] });
  expect(await catalog.markdown(skill, signal)).toBe('# Skill');
  expect(mocks.invoke.mock.calls).toEqual([
    ['skills.catalog', { operation: 'describe' }, { signal }],
    ['skills.catalog', { operation: 'search', query: 'sample', limit: 50 }, { provider, signal }],
    ['skills.catalog', { operation: 'markdown', skill }, { provider, signal }],
  ]);
});
it('uses the standard catalog only when no declaration exists or the provider explicitly opts out', async () => {
  mocks.invoke.mockRejectedValueOnce(new Error('CAPABILITY_NOT_INSTALLED'));
  expect(await resolveSkillCatalog()).toBe(publicSkillCatalog);
  mocks.invoke.mockResolvedValueOnce({ data: { available: false }, provider });
  expect(await resolveSkillCatalog()).toBe(publicSkillCatalog);
});
it.each(['CAPABILITY_UNAVAILABLE', 'auth failed', 'BUNDLE_CONFLICT', 'AbortError'])(
  'retains selected catalog failure: %s',
  async error => {
    mocks.invoke.mockRejectedValueOnce(new Error(error));
    await expect(resolveSkillCatalog()).rejects.toThrow(error);
  },
);
it('rejects malformed metadata instead of installing an incomplete or unsafe entry', async () => {
  mocks.invoke
    .mockResolvedValueOnce({
      data: {
        available: true,
        managerId: 'custom',
        title: 'Catalog',
        homeUrl: 'https://catalog.example.test',
      },
      provider,
    })
    .mockResolvedValueOnce({
      data: { skills: [{ ...skill, pageUrl: 'javascript:alert(1)' }] },
      provider,
    });
  const catalog = await resolveSkillCatalog();
  await expect(catalog.search('')).rejects.toThrow();
});
it('bundles the public Mearl skills for offline browsing and preview', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const result = await publicSkillCatalog.search('');
  expect(result.skills.map(item => item.name).sort()).toEqual([...releasedSkills].sort());
  const mearl = result.skills.find(item => item.name === 'mearl')!;
  expect(await publicSkillCatalog.markdown(mearl)).toContain('name: mearl');
  expect(fetch).not.toHaveBeenCalled();
});
it('uses the official search result source and name for installation, retaining its id only for the page', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          skills: [
            {
              id: 'example/repo/path-name',
              name: 'actual-name',
              source: 'example/repo',
              installs: 12,
            },
          ],
        }),
      ),
    );
  const result = await publicSkillCatalog.search('example');
  expect(fetch).toHaveBeenCalledWith(
    'https://skills.sh/api/search?q=example&limit=50',
    expect.objectContaining({ credentials: 'omit' }),
  );
  expect(result.skills[0]).toMatchObject({
    source: 'example/repo',
    installSource: 'https://github.com/example/repo',
    name: 'actual-name',
    pageUrl: 'https://skills.sh/example/repo/path-name',
  });
});
it('previews an exact blob, matches the frontmatter name and caches only successful results', async () => {
  const sha = 'a'.repeat(40);
  const markdown = '---\nname: actual-name\n---\n# Example';
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ default_branch: 'main' })))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sha: 'b'.repeat(40),
          tree: [{ path: 'skills/different-folder/SKILL.md', type: 'blob', sha, size: 40 }],
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ encoding: 'base64', content: btoa(markdown) })),
    );
  const entry = { ...skill, source: 'preview/repo', name: 'actual-name' };
  expect(await publicSkillCatalog.markdown(entry)).toBe(markdown);
  expect(fetch.mock.calls[2][0]).toBe(`https://api.github.com/repos/preview/repo/git/blobs/${sha}`);
  expect(await publicSkillCatalog.markdown(entry)).toBe(markdown);
  expect(fetch).toHaveBeenCalledTimes(3);
});
it.each(['truncated', 'ambiguous', 'rate-limit'])(
  'does not cache a failed preview: %s',
  async kind => {
    const sha = 'c'.repeat(40),
      entry = { ...skill, source: `fail-${kind}/repo` };
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      if (kind === 'rate-limit') return new Response('{}', { status: 403 });
      if (String(url).includes('/git/blobs/'))
        return new Response(
          JSON.stringify({ encoding: 'base64', content: btoa('---\nname: sample\n---\n') }),
        );
      if (String(url).includes('/git/trees/'))
        return new Response(
          JSON.stringify({
            truncated: kind === 'truncated',
            tree: ['a', 'b'].map(path => ({
              type: 'blob',
              path: `${path}/SKILL.md`,
              sha,
              size: 20,
            })),
          }),
        );
      return new Response(JSON.stringify({ default_branch: 'main' }));
    });
    await expect(publicSkillCatalog.markdown(entry)).rejects.toThrow();
    const count = fetch.mock.calls.length;
    await expect(publicSkillCatalog.markdown(entry)).rejects.toThrow();
    expect(fetch.mock.calls.length).toBeGreaterThan(count);
  },
);
it('previews one exact named directory in a large repository without scanning unrelated blobs', async () => {
  const sha = 'e'.repeat(40),
    entry = { ...skill, source: 'large/repo' };
  const tree = Array.from({ length: 100 }, (_, index) => ({
    type: 'blob',
    path: `skills/${index === 90 ? 'sample' : 'other-' + index}/SKILL.md`,
    sha,
    size: 20,
  }));
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ default_branch: 'main' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ tree })))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ encoding: 'base64', content: btoa('---\nname: sample\n---\n# Example') }),
      ),
    );
  expect(await publicSkillCatalog.markdown(entry)).toContain('# Example');
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('uses the same builtin Skill sources and preview links for beta releases', async () => {
  vi.resetModules();
  vi.spyOn(chrome.runtime, 'getManifest').mockReturnValue({
    manifest_version: 3,
    name: 'Mearl',
    version: '3.0.0.0',
    version_name: '3.0.0-beta.0',
  });
  const { publicSkillCatalog: betaCatalog } = await import('../publicSkillCatalog');
  const result = await betaCatalog.search('');
  expect(result.skills).toHaveLength(releasedSkills.length);
  for (const skill of result.skills) {
    expect(skill.installSource).toBe('https://github.com/mearlhq/mearl');
    expect(skill.pageUrl).toContain('/tree/main/skills/');
  }
});
