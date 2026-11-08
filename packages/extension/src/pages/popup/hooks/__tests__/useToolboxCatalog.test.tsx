import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import catalog from '../../../../test/fixtures/toolboxCatalog';
import { useToolboxCatalog, toolboxCatalogCacheKey } from '../useToolboxCatalog';

import { TOOLBOX_CATALOG_URL } from '../../../../shared/toolboxCatalog';
const cacheKey = toolboxCatalogCacheKey(TOOLBOX_CATALOG_URL);
const config = vi.hoisted(() => ({ catalogs: undefined as Record<string, { url?: string; label?: string; enabled?: boolean }> | undefined }));
vi.mock('../../../panel/utils/browserUiSettings', () => ({ useBrowserUiSettings: () => ({ toolCatalogs: config.catalogs }) }));

const storage = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('../../../panel/utils/safeChrome', () => ({
  storageGetSafely: storage.get,
  storageSetSafely: storage.set,
}));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  config.catalogs = undefined;
  storage.get.mockReset().mockResolvedValue({});
  storage.set.mockReset().mockResolvedValue(undefined);
  fetchMock.mockReset().mockImplementation(async () => new Response(JSON.stringify(catalog)));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('toolbox catalog cache', () => {
  it('fetches only when the install dialog opens and caches successful results', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useToolboxCatalog(enabled), {
      initialProps: { enabled: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.get).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.tools).toEqual(catalog.tools));
    expect(storage.set).toHaveBeenCalledWith({ [cacheKey]: catalog });
  });

  it('keeps cached tools available if the website is offline', async () => {
    storage.get.mockResolvedValue({ [cacheKey]: catalog });
    fetchMock.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useToolboxCatalog(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tools).toEqual(catalog.tools);
    expect(result.current.issues).toMatchObject([{ source: { id: 'official' }, reason: 'unavailable', usingCache: true }]);
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('does not let a delayed cache overwrite a fresh empty catalog', async () => {
    let resolveCache!: (value: unknown) => void;
    storage.get.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveCache = resolve;
        }),
    );
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ tools: [] })));
    const { result } = renderHook(() => useToolboxCatalog(true));
    await waitFor(() => expect(result.current.tools).toEqual([]));
    await act(async () => resolveCache({ [cacheKey]: catalog }));
    expect(result.current.tools).toEqual([]);
    expect(storage.set).toHaveBeenCalledWith({ [cacheKey]: { tools: [] } });
  });

  it('supports retrying after both the cache and website fail', async () => {
    storage.get.mockResolvedValue({ [cacheKey]: { tools: [{}] } });
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useToolboxCatalog(true));
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.tools).toBeNull();
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.tools).toEqual(catalog.tools));
    expect(result.current.failed).toBe(false);
  });

  it('does not let a request from a closed dialog overwrite newer cached results', async () => {
    let finishFirst!: (response: Response) => void;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ tools: [] })));
    const { result, rerender } = renderHook(({ enabled }) => useToolboxCatalog(enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ enabled: false });
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.tools).toEqual([]));
    await act(async () => finishFirst(new Response(JSON.stringify(catalog))));
    expect(result.current.tools).toEqual([]);
    expect(storage.set).toHaveBeenCalledOnce();
    expect(storage.set).toHaveBeenLastCalledWith({ [cacheKey]: { tools: [] } });
  });

  it('keeps the current catalog if a later cache read is stale and the refresh fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ tools: [] })));
    const { result, rerender } = renderHook(({ enabled }) => useToolboxCatalog(enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(result.current.tools).toEqual([]));
    rerender({ enabled: false });
    storage.get.mockResolvedValue({ [cacheKey]: catalog });
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.tools).toEqual([]);
    expect(result.current.issues).toMatchObject([{ source: { id: 'official' }, reason: 'unavailable', usingCache: false }]);
  });
});

const teamUrl = 'https://team.example/tools.json';
const teamTool = { ...catalog.tools[0], id: 'plugin:team-tool', plugin: 'team-tool', repository: 'team/skills', skill: 'team-skill', title: 'Team tool' };
it('loads sources in parallel, shows successful tools immediately and keeps them if another source fails', async () => {
  config.catalogs = { team: { url: teamUrl, label: 'Team' } };
  let failOfficial!: (error: Error) => void;
  fetchMock.mockImplementation(async url => url === teamUrl ? new Response(JSON.stringify({ tools: [teamTool] })) : new Promise((_resolve, reject) => { failOfficial = reject; }));
  const { result } = renderHook(() => useToolboxCatalog(true));
  await waitFor(() => expect(result.current.tools).toEqual([teamTool]));
  expect(result.current.loading).toBe(true);
  expect(result.current.groups[1].pendingPriority).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async () => failOfficial(new Error('offline')));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.tools).toEqual([teamTool]);
  expect(result.current.groups[1].pendingPriority).toBe(false);
  expect(result.current.issues).toMatchObject([{ source: { id: 'official' }, reason: 'unavailable', usingCache: false }]);
  expect(storage.set).toHaveBeenCalledWith({ [toolboxCatalogCacheKey(teamUrl)]: { tools: [teamTool] } });
});
it('deduplicates matching entries and surfaces conflicting install sources without replacing official tools', async () => {
  config.catalogs = { team: { url: teamUrl, label: 'Team' } };
  fetchMock.mockImplementation(async url => new Response(JSON.stringify(url === teamUrl ? { tools: [{ ...catalog.tools[0], repository: 'team/conflict' }, teamTool] } : catalog)));
  const { result } = renderHook(() => useToolboxCatalog(true));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.tools).toEqual([...catalog.tools, teamTool]);
  expect(result.current.issues).toMatchObject([{ source: { id: 'team' }, reason: 'conflict', plugin: catalog.tools[0].plugin }]);
});
it('waits for higher-priority cache reads when their remote catalog fails', async () => {
  config.catalogs = { team: { url: teamUrl } };
  let finishCache!: (value: unknown) => void;
  storage.get.mockImplementation(([key]) => key === cacheKey ? new Promise(resolve => { finishCache = resolve; }) : Promise.resolve({}));
  const conflictingTool = { ...catalog.tools[0], repository: 'team/conflict' };
  fetchMock.mockImplementation(async url => {
    if (url !== teamUrl) throw new Error('offline');
    return new Response(JSON.stringify({ tools: [conflictingTool] }));
  });
  const { result } = renderHook(() => useToolboxCatalog(true));
  await waitFor(() => expect(result.current.tools).toEqual([conflictingTool]));
  expect(result.current.failed).toBe(true);
  expect(result.current.groups[1].pendingPriority).toBe(true);
  await act(async () => finishCache({ [cacheKey]: catalog }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.tools).toEqual(catalog.tools);
  expect(result.current.groups[1].tools).toEqual([]);
  expect(result.current.issues).toContainEqual(expect.objectContaining({ reason: 'conflict', plugin: conflictingTool.plugin }));
});
it('uses per-source caches and removes disabled directory entries immediately', async () => {
  config.catalogs = { team: { url: teamUrl } };
  storage.get.mockImplementation(async ([key]) => ({ [key]: key === cacheKey ? catalog : { tools: [teamTool] } }));
  fetchMock.mockRejectedValue(new Error('offline'));
  const { result, rerender } = renderHook(() => useToolboxCatalog(true));
  await waitFor(() => expect(result.current.tools).toEqual([...catalog.tools, teamTool]));
  config.catalogs = { team: { url: teamUrl, enabled: false } };
  rerender();
  await waitFor(() => expect(result.current.tools).toEqual(catalog.tools));
  expect(result.current.groups).toHaveLength(1);
});
it('ignores a removed directory response and never caches it after a source change', async () => {
  config.catalogs = { team: { url: teamUrl } };
  let finishTeam!: (response: Response) => void;
  fetchMock.mockImplementation(async url => url === teamUrl ? new Promise(resolve => { finishTeam = resolve; }) : new Response(JSON.stringify(catalog)));
  const { result, rerender } = renderHook(() => useToolboxCatalog(true));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  config.catalogs = undefined; rerender();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => finishTeam(new Response(JSON.stringify({ tools: [teamTool] }))));
  expect(result.current.tools).toEqual(catalog.tools);
  expect(storage.set.mock.calls.every(([value]) => !Object.hasOwn(value, toolboxCatalogCacheKey(teamUrl)))).toBe(true);
});

it('deduplicates matching plugin identities across directories without warning', async () => {
  config.catalogs = { team: { url: teamUrl } };
  const { result } = renderHook(() => useToolboxCatalog(true));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.tools).toEqual(catalog.tools);
  expect(result.current.issues).toEqual([]);
  expect(result.current.groups[1].tools).toEqual([]);
});
