import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateContentScriptsForOrigins,
  ensureContentScriptsForOrigins,
  reconcileContentScriptsForOrigins,
} from '../contentScriptRegistrar';
import { ALLOWED_ORIGINS_LIST } from '../../../shared/allowedOrigins';
import { EARLY_CONTENT_SCRIPT_FILES } from '../../../shared/appProfileRuntimeAsset';

describe('contentScriptRegistrar', () => {
  const getRegisteredContentScripts = vi.fn();
  const registerContentScripts = vi.fn();
  const updateContentScripts = vi.fn();
  const unregisterContentScripts = vi.fn();
  const executeScript = vi.fn();
  const queryTabs = vi.fn();
  const sendTabMessage = vi.fn();

  beforeEach(() => {
    getRegisteredContentScripts.mockReset();
    registerContentScripts.mockReset().mockImplementation((_scripts, callback) => callback());
    updateContentScripts.mockReset().mockImplementation((_scripts, callback) => callback());
    unregisterContentScripts.mockReset().mockImplementation((_filter, callback) => callback());
    executeScript.mockReset().mockResolvedValue([]);
    queryTabs.mockReset().mockResolvedValue([]);
    sendTabMessage.mockReset().mockRejectedValue(new Error('No receiver'));
    chrome.scripting = {
      getRegisteredContentScripts,
      registerContentScripts,
      updateContentScripts,
      unregisterContentScripts,
      executeScript,
    } as unknown as typeof chrome.scripting;
    chrome.tabs = {
      query: queryTabs,
      sendMessage: sendTabMessage,
    } as unknown as typeof chrome.tabs;
  });

  it('updates persisted registrations that predate related-frame matching', async () => {
    getRegisteredContentScripts.mockImplementation((_filter, callback) =>
      callback([
        {
          id: 'mearl-auto-early-example-org',
          matches: ['*://*.example.org/*'],
          excludeMatches: ALLOWED_ORIGINS_LIST,
          js: ['src/pages/content-script/early-inject.js'],
          runAt: 'document_start',
          allFrames: true,
          world: 'MAIN',
        },
        {
          id: 'mearl-auto-main-example-org',
          matches: ['*://*.example.org/*'],
          js: ['src/pages/content-script/index.js'],
          runAt: 'document_start',
          allFrames: true,
          world: 'ISOLATED',
        },
      ]),
    );

    await ensureContentScriptsForOrigins(['*://*.example.org/*']);

    expect(updateContentScripts).toHaveBeenCalledOnce();
    expect(updateContentScripts).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: 'mearl-auto-early-example-org',
          matchOriginAsFallback: true,
        }),
        expect.objectContaining({
          id: 'mearl-auto-main-example-org',
          matchOriginAsFallback: true,
        }),
      ],
      expect.any(Function),
    );
    expect(registerContentScripts).not.toHaveBeenCalled();
  });

  it('registers only missing scripts when an existing registration is current', async () => {
    getRegisteredContentScripts.mockImplementation((_filter, callback) =>
      callback([
        {
          id: 'mearl-auto-early-example-org',
          matches: ['*://*.example.org/*'],
          excludeMatches: ALLOWED_ORIGINS_LIST,
          js: EARLY_CONTENT_SCRIPT_FILES,
          runAt: 'document_start',
          allFrames: true,
          matchOriginAsFallback: true,
          world: 'MAIN',
        },
      ]),
    );

    await ensureContentScriptsForOrigins(['*://*.example.org/*']);

    expect(registerContentScripts).toHaveBeenCalledOnce();
    expect(registerContentScripts).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: 'mearl-auto-main-example-org',
          matchOriginAsFallback: true,
        }),
      ],
      expect.any(Function),
    );
    expect(updateContentScripts).not.toHaveBeenCalled();
  });

  it('excludes static manifest origins from dynamic registrations', async () => {
    getRegisteredContentScripts.mockImplementation((_filter, callback) => callback([]));

    await ensureContentScriptsForOrigins(['<all_urls>']);

    expect(registerContentScripts).toHaveBeenCalledOnce();
    expect(registerContentScripts).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: 'mearl-auto-early-all-urls',
          excludeMatches: expect.arrayContaining(ALLOWED_ORIGINS_LIST),
        }),
        expect.objectContaining({
          id: 'mearl-auto-main-all-urls',
          excludeMatches: expect.arrayContaining(ALLOWED_ORIGINS_LIST),
        }),
      ],
      expect.any(Function),
    );
  });

  it.each([
    ['src/pages/content-script/early-inject.js'],
    [...EARLY_CONTENT_SCRIPT_FILES].reverse(),
  ])('修复缺少运行时或加载顺序错误的持久注册 %j', async (...files) => {
    getRegisteredContentScripts.mockImplementation((_filter, callback) =>
      callback([
        {
          id: 'mearl-auto-early-example-org',
          matches: ['*://*.example.org/*'],
          excludeMatches: ALLOWED_ORIGINS_LIST,
          js: files,
          runAt: 'document_start',
          allFrames: true,
          matchOriginAsFallback: true,
          world: 'MAIN',
        },
        {
          id: 'mearl-auto-main-example-org',
          matches: ['*://*.example.org/*'],
          excludeMatches: ALLOWED_ORIGINS_LIST,
          js: ['src/pages/content-script/index.js'],
          runAt: 'document_start',
          allFrames: true,
          matchOriginAsFallback: true,
          world: 'ISOLATED',
        },
      ]),
    );

    await ensureContentScriptsForOrigins(['*://*.example.org/*']);

    expect(updateContentScripts).toHaveBeenCalledWith(
      [expect.objectContaining({ js: EARLY_CONTENT_SCRIPT_FILES })],
      expect.any(Function),
    );
    expect(registerContentScripts).not.toHaveBeenCalled();
  });

  it('uses one all-urls registration instead of narrower redundant registrations', async () => {
    getRegisteredContentScripts.mockImplementation((_filter, callback) => callback([]));

    await ensureContentScriptsForOrigins(['*://*.example.org/*', '<all_urls>']);

    const registered = registerContentScripts.mock.calls[0]?.[0] as Array<{ id: string }>;
    expect(registered.map(script => script.id)).toEqual([
      'mearl-auto-early-all-urls',
      'mearl-auto-main-all-urls',
    ]);
  });

  it('does not dynamically register origins already declared by the manifest', async () => {
    await ensureContentScriptsForOrigins([ALLOWED_ORIGINS_LIST[0]]);

    expect(getRegisteredContentScripts).not.toHaveBeenCalled();
    expect(registerContentScripts).not.toHaveBeenCalled();
  });

  it('reconciles persisted registrations and removes legacy or revoked entries', async () => {
    getRegisteredContentScripts.mockImplementation((_filter, callback) =>
      callback([
        {
          id: 'mtop-auto-early-all-urls',
          matches: ['<all_urls>'],
          js: ['src/pages/content-script/early-inject.js'],
          runAt: 'document_start',
          allFrames: true,
          matchOriginAsFallback: true,
          world: 'MAIN',
        },
        {
          id: 'mearl-auto-main-revoked-example-org',
          matches: ['*://revoked.example.org/*'],
          js: ['src/pages/content-script/index.js'],
          runAt: 'document_start',
          allFrames: true,
          matchOriginAsFallback: true,
          world: 'ISOLATED',
        },
        {
          id: 'mearl-auto-early-all-urls',
          matches: ['<all_urls>'],
          js: EARLY_CONTENT_SCRIPT_FILES,
          runAt: 'document_start',
          allFrames: true,
          matchOriginAsFallback: true,
          world: 'MAIN',
        },
        {
          id: 'mearl-auto-main-all-urls',
          matches: ['<all_urls>'],
          js: ['src/pages/content-script/index.js'],
          runAt: 'document_start',
          allFrames: true,
          matchOriginAsFallback: true,
          world: 'ISOLATED',
        },
      ]),
    );

    await reconcileContentScriptsForOrigins(['<all_urls>']);

    expect(unregisterContentScripts).toHaveBeenCalledWith(
      {
        ids: ['mtop-auto-early-all-urls', 'mearl-auto-main-revoked-example-org'],
      },
      expect.any(Function),
    );
    expect(updateContentScripts).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: 'mearl-auto-early-all-urls',
          excludeMatches: expect.arrayContaining(ALLOWED_ORIGINS_LIST),
        }),
        expect.objectContaining({
          id: 'mearl-auto-main-all-urls',
          excludeMatches: expect.arrayContaining(ALLOWED_ORIGINS_LIST),
        }),
      ],
      expect.any(Function),
    );
    expect(registerContentScripts).not.toHaveBeenCalled();
  });

  it('injects the main content script into matching open tabs after authorization', async () => {
    getRegisteredContentScripts.mockImplementation((_filter, callback) => callback([]));
    queryTabs.mockResolvedValue([{ id: 7 }, { id: 9 }, {}]);

    await activateContentScriptsForOrigins(['*://*.example.org/*']);

    expect(queryTabs).toHaveBeenCalledWith({ url: ['*://*.example.org/*'] });
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, allFrames: true },
      files: ['src/pages/content-script/index.js'],
    });
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 9, allFrames: true },
      files: ['src/pages/content-script/index.js'],
    });
  });

  it('skips full bundle injection when the current content script responds', async () => {
    getRegisteredContentScripts.mockImplementation((_filter, callback) => callback([]));
    queryTabs.mockResolvedValue([{ id: 7 }]);
    sendTabMessage.mockResolvedValue({ alive: true });

    await activateContentScriptsForOrigins(['*://*.example.org/*']);

    expect(sendTabMessage).toHaveBeenCalledWith(7, { action: 'ping' });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('keeps injecting other matching tabs when one tab is restricted', async () => {
    getRegisteredContentScripts.mockImplementation((_filter, callback) => callback([]));
    queryTabs.mockResolvedValue([{ id: 7 }, { id: 9 }]);
    executeScript.mockRejectedValueOnce(new Error('Cannot access this page')).mockResolvedValue([]);

    await expect(
      activateContentScriptsForOrigins(['*://*.example.org/*']),
    ).resolves.toBeUndefined();

    expect(executeScript).toHaveBeenCalledTimes(2);
  });
});
