import { describe, expect, it, vi } from 'vitest';
import catalog from '../../test/fixtures/toolboxCatalog';
import { fetchToolboxCatalog, parseToolboxCatalog, toolboxSkillSource, toolboxCatalogSources, TOOLBOX_CATALOG_URL } from '../toolboxCatalog';

describe('website toolbox catalog', () => {
  it('loads website metadata and preserves install arguments and translations', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(catalog)));
    expect(await fetchToolboxCatalog(fetchImpl)).toEqual(catalog.tools);
    expect(fetchImpl).toHaveBeenCalledWith(
      TOOLBOX_CATALOG_URL,
      expect.objectContaining({ cache: 'no-cache', signal: expect.any(AbortSignal) }),
    );
  });

  it('allows an explicitly empty catalog', () => {
    expect(parseToolboxCatalog({ tools: [] })).toEqual([]);
  });

  it.each(['https://example.com/icon.png', '<svg xmlns="http://www.w3.org/2000/svg"/>'])(
    'preserves custom catalog icons: %s',
    icon => {
      expect(parseToolboxCatalog({ tools: [{ ...catalog.tools[0], icon }] })[0].icon).toBe(icon);
    },
  );

  it.each([
    { tools: [{ ...catalog.tools[0], id: 'plugin:other' }] },
    { tools: [catalog.tools[0], catalog.tools[0]] },
    { tools: [{ ...catalog.tools[0], repository: '--source' }] },
    { tools: [{ ...catalog.tools[0], skill: '../skill' }] },
    { tools: [{ ...catalog.tools[0], icon: 'javascript:alert(1)' }] },
    { tools: [{ ...catalog.tools[0], locales: { en: { title: 3 } } }] },
    {},
  ])('rejects malformed installation metadata: %j', value => {
    expect(() => parseToolboxCatalog(value)).toThrow('Invalid toolbox catalog');
  });

  it('reports failed HTTP requests without interpreting the response as a catalog', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(fetchToolboxCatalog(fetchImpl)).rejects.toThrow('HTTP 503');
  });
});

it('pins official beta Skills without changing third-party or stable sources', () => {
  expect(toolboxSkillSource('mearlhq/mearl', '3.0.0-beta.0')).toBe('https://github.com/mearlhq/mearl/tree/v3.0.0-beta.0');
  expect(toolboxSkillSource('mearlhq/mearl', '3.0.0')).toBe('mearlhq/mearl');
  expect(toolboxSkillSource('example/skills', '3.0.0-beta.0')).toBe('example/skills');
});

it('adds enabled directories while retaining the official source and deduplicating URLs', () => {
  expect(toolboxCatalogSources({ team: { url: 'https://team.example/tools.json', label: 'Team' }, duplicate: { url: TOOLBOX_CATALOG_URL }, disabled: { enabled: false } })).toEqual([{ id: 'official', url: TOOLBOX_CATALOG_URL, label: 'Mearl' }, { id: 'team', url: 'https://team.example/tools.json', label: 'Team' }]);
});
it.each(['git@code.example.test:team/skills.git#release/v3', 'https://code.example.test/team/skills.git#release/v3'])('preserves a trusted directory Git source for the preset-selected manager: %s', repository => {
  expect(parseToolboxCatalog({ tools: [{ ...catalog.tools[0], repository }] })[0].repository).toBe(repository);
  expect(toolboxSkillSource(repository)).toBe(repository);
});
it.each(['file:///etc/passwd', 'https://user:secret@example.com/repo', 'ssh://user:secret@example.com/repo', 'https://example.com/repo?token=secret', '--source=evil', 'team/repo\n--yes'])('rejects unsafe install sources %s', repository => {
  expect(() => parseToolboxCatalog({ tools: [{ ...catalog.tools[0], repository }] })).toThrow('Invalid toolbox catalog');
});
it('bounds downloaded directory size before parsing or caching it', async () => {
  await expect(fetchToolboxCatalog(vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(256 * 1024 + 1))))).rejects.toThrow('256 KiB');
});
