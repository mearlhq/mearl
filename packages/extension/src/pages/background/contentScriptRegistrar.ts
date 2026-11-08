import { ALLOWED_ORIGINS_LIST } from '../../shared/allowedOrigins';
import { EARLY_CONTENT_SCRIPT_FILES } from '../../shared/appProfileRuntimeAsset';

const AUTO_SCRIPT_PREFIX_EARLY = 'mearl-auto-early';
const AUTO_SCRIPT_PREFIX_MAIN = 'mearl-auto-main';
const LEGACY_AUTO_SCRIPT_PREFIXES = ['mtop-auto-early', 'mtop-auto-main'];
const MANAGED_AUTO_SCRIPT_PREFIXES = [
  AUTO_SCRIPT_PREFIX_EARLY,
  AUTO_SCRIPT_PREFIX_MAIN,
  ...LEGACY_AUTO_SCRIPT_PREFIXES,
];

function readStaticOriginPatterns(): string[] {
  try {
    const matches = chrome.runtime
      .getManifest()
      .content_scripts?.flatMap(script => script.matches ?? [])
      .flatMap(match => {
        const normalized = normalizeOriginPattern(match);
        return normalized ? [normalized] : [];
      });
    if (matches && matches.length > 0) return [...new Set(matches)];
  } catch {
    // 测试环境或初始化早期无法读取 manifest 时使用源码声明
  }
  return [...ALLOWED_ORIGINS_LIST];
}

// 使用运行中 manifest，兼容离线包把静态 matches 扩为 <all_urls> 的情况。
const STATIC_ORIGIN_PATTERNS = readStaticOriginPatterns();
const STATIC_ORIGINS = new Set(STATIC_ORIGIN_PATTERNS);

function readNetworkOnlyOriginPatterns(): string[] {
  try {
    return (
      chrome.runtime.getManifest().host_permissions?.flatMap((origin: string) => {
        const match = normalizeOriginPattern(origin);
        return match && !STATIC_ORIGINS.has(match) ? [match] : [];
      }) ?? []
    );
  } catch {
    return [];
  }
}

// Manifest 固定声明、但不用于页面注入的后台网络权限（例如 GA 上报域名）。
const NETWORK_ONLY_ORIGINS = new Set(readNetworkOnlyOriginPatterns());

function buildAutoScriptId(prefix: string, origin: string): string {
  const safeOrigin = origin
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${prefix}-${safeOrigin}`;
}

function normalizeOriginPattern(origin: string): string | null {
  if (!origin || typeof origin !== 'string') return null;
  if (origin === '<all_urls>') return '<all_urls>';
  if (!origin.includes('://')) return null;
  if (!origin.endsWith('/*')) return null;
  return origin;
}

function getRegisteredContentScripts(
  ids?: string[],
): Promise<chrome.scripting.RegisteredContentScript[]> {
  return new Promise(resolve => {
    chrome.scripting.getRegisteredContentScripts(ids ? { ids } : {}, scripts => {
      if (chrome.runtime.lastError) {
        resolve([]);
        return;
      }
      resolve(scripts ?? []);
    });
  });
}

function unregisterContentScripts(ids: string[]): Promise<boolean> {
  return new Promise(resolve => {
    chrome.scripting.unregisterContentScripts({ ids }, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

function registerContentScripts(
  scripts: chrome.scripting.RegisteredContentScript[],
): Promise<boolean> {
  return new Promise(resolve => {
    chrome.scripting.registerContentScripts(scripts, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

function updateContentScripts(
  scripts: chrome.scripting.RegisteredContentScript[],
): Promise<boolean> {
  return new Promise(resolve => {
    chrome.scripting.updateContentScripts(scripts, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

function buildDesiredContentScripts(match: string): chrome.scripting.RegisteredContentScript[] {
  const earlyScriptId = buildAutoScriptId(AUTO_SCRIPT_PREFIX_EARLY, match);
  const mainScriptId = buildAutoScriptId(AUTO_SCRIPT_PREFIX_MAIN, match);
  const excludeMatches = STATIC_ORIGIN_PATTERNS.length > 0 ? STATIC_ORIGIN_PATTERNS : undefined;
  return [
    {
      id: earlyScriptId,
      matches: [match],
      ...(excludeMatches ? { excludeMatches } : {}),
      js: EARLY_CONTENT_SCRIPT_FILES,
      runAt: 'document_start',
      allFrames: true,
      matchOriginAsFallback: true,
      world: 'MAIN',
    },
    {
      id: mainScriptId,
      matches: [match],
      ...(excludeMatches ? { excludeMatches } : {}),
      js: ['src/pages/content-script/index.js'],
      runAt: 'document_start',
      allFrames: true,
      matchOriginAsFallback: true,
      world: 'ISOLATED',
    },
  ];
}

function normalizeOrigins(origins: string[]): string[] {
  return [
    ...new Set(
      origins.flatMap(origin => {
        const match = normalizeOriginPattern(origin);
        return match ? [match] : [];
      }),
    ),
  ];
}

function buildDesiredContentScriptsForOrigins(
  origins: string[],
): chrome.scripting.RegisteredContentScript[] {
  const dynamicMatches = normalizeOrigins(origins).filter(
    match => !STATIC_ORIGINS.has(match) && !NETWORK_ONLY_ORIGINS.has(match),
  );
  const effectiveMatches = dynamicMatches.includes('<all_urls>') ? ['<all_urls>'] : dynamicMatches;
  return effectiveMatches.flatMap(match => buildDesiredContentScripts(match));
}

function arraysEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  const a = [...(left ?? [])].sort();
  const b = [...(right ?? [])].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function registrationIsCurrent(
  registered: chrome.scripting.RegisteredContentScript,
  desired: chrome.scripting.RegisteredContentScript,
): boolean {
  return (
    arraysEqual(registered.matches, desired.matches) &&
    arraysEqual(registered.excludeMatches, desired.excludeMatches) &&
    registered.js?.length === desired.js?.length &&
    registered.js?.every((file, index) => file === desired.js?.[index]) === true &&
    registered.runAt === desired.runAt &&
    registered.allFrames === desired.allFrames &&
    registered.matchOriginAsFallback === desired.matchOriginAsFallback &&
    registered.world === desired.world
  );
}

async function syncDesiredContentScripts(
  desired: chrome.scripting.RegisteredContentScript[],
  existing?: chrome.scripting.RegisteredContentScript[],
): Promise<void> {
  if (desired.length === 0) return;
  const registered =
    existing ?? (await getRegisteredContentScripts(desired.map(script => script.id)));
  const existingById = new Map(registered.map(script => [script.id, script]));
  const toRegister = desired.filter(script => !existingById.has(script.id));
  const toUpdate = desired.filter(script => {
    const current = existingById.get(script.id);
    return current && !registrationIsCurrent(current, script);
  });

  if (toUpdate.length > 0) {
    await updateContentScripts(toUpdate);
  }

  if (toRegister.length > 0) {
    await registerContentScripts(toRegister);
  }
}

function isManagedRegistration(id: string): boolean {
  return MANAGED_AUTO_SCRIPT_PREFIXES.some(prefix => id.startsWith(`${prefix}-`));
}

let registrationQueue: Promise<unknown> = Promise.resolve();

function runRegistrationTask(operation: () => Promise<void>): Promise<void> {
  const result = registrationQueue.then(operation, operation);
  registrationQueue = result.catch(() => {});
  return result;
}

export async function ensureContentScriptsForOrigins(origins: string[]): Promise<void> {
  await runRegistrationTask(async () => {
    await syncDesiredContentScripts(buildDesiredContentScriptsForOrigins(origins));
  });
}

/** 对账当前授权：清理旧命名前缀、已撤权域名和已被静态 manifest 覆盖的动态注册。 */
export async function reconcileContentScriptsForOrigins(origins: string[]): Promise<void> {
  await runRegistrationTask(async () => {
    const desired = buildDesiredContentScriptsForOrigins(origins);
    const desiredIds = new Set(desired.map(script => script.id));
    const registered = await getRegisteredContentScripts();
    const managed = registered.filter(script => isManagedRegistration(script.id));
    const staleIds = managed.filter(script => !desiredIds.has(script.id)).map(script => script.id);

    if (staleIds.length > 0) await unregisterContentScripts(staleIds);
    await syncDesiredContentScripts(
      desired,
      managed.filter(script => desiredIds.has(script.id)),
    );
  });
}

async function activateOpenTabs(matches: string[]): Promise<void> {
  if (matches.length === 0) return;

  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ url: matches });
  } catch {
    return;
  }

  await Promise.all(
    tabs.map(async tab => {
      if (typeof tab.id !== 'number') return;
      try {
        const response = (await chrome.tabs.sendMessage(tab.id, { action: 'ping' })) as
          | { alive?: boolean }
          | undefined;
        if (response?.alive === true) return;
      } catch {
        // 没有可达的当前版本 content script 时执行补注入
      }
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['src/pages/content-script/index.js'],
        });
      } catch {
        // Restricted pages and tabs that navigate during injection remain on the refresh fallback.
      }
    }),
  );
}

export async function activateContentScriptsForOrigins(origins: string[]): Promise<void> {
  const matches = normalizeOrigins(origins);
  await ensureContentScriptsForOrigins(matches);
  await activateOpenTabs(matches);
}

/** 扩展启动时先完成持久注册对账，再补注入当前已打开的授权页面。 */
export async function initializeContentScriptsForOrigins(origins: string[]): Promise<void> {
  const matches = normalizeOrigins(origins);
  await reconcileContentScriptsForOrigins(matches);
  await activateOpenTabs(matches);
}
