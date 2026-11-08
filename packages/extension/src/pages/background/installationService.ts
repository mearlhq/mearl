import type { PresetAutoUpdateResult } from '../../shared/presetAutoUpdate';
import { getExtensionVersion } from '../../shared/extensionVersion';
import {
  loadInstallationConfig, parseInstallationConfig, matchesInstallationOrigin, trustedInstallationPreset, installationOriginCovered, validateInstallationOrigin, type InstallationConfig, type InstallationPreset,
} from '@mearl/preset/installation';
import { BrowserBundleStore, prepareBrowserPreset, createBundleFetchLoader, bundleDigest, MAX_BUNDLE_BYTES, MAX_BROWSER_STORAGE_BYTES, MAX_PRESET_TRANSFER_HEADER_BYTES, PRESET_TRANSFER_CHUNK_BYTES, type BundleLoader, type PresetTransferTransport } from '@mearl/preset/bundles';
import { missingPresetPermissions as missingPermissions, grantPresetOrigins } from '../../shared/presetPermissions';
import {
  INSTALLATION_ACTION, INSTALLATION_SITE, INSTALLATION_BRIDGE_URL,
  INSTALLATION_CONNECT_URL, INSTALLATION_CONNECT_EN_URL, INSTALLATION_VIEW_PATH, DIRECT_INSTALLATION_CONFIG_URL, type InstallationView,
} from '../../shared/installation';
import { isExtensionUiSender } from './extensionMessageTrust';
import { BROWSER_BUNDLE_API_VERSION, browserCapabilityRegistry, createBrowserCapabilityRegistry } from './browserCapabilityRegistry';
import { withCookieInjection } from './utils/dnr';
import { synchronizeBrowserPreset } from './browserPresetSync';

const SESSION_PREFIX = 'mearl-installation:';
const SESSION_LIFETIME = 15 * 60_000;
type InstallationSelection = Awaited<ReturnType<ReturnType<typeof browserCapabilityRegistry>['captureInstallationSelection']>>;
function sameSelection(left: InstallationSelection, right: InstallationSelection) {
  return left.activeRevision === right.activeRevision && left.installationToken === right.installationToken && Object.keys(left.revisions).length === Object.keys(right.revisions).length && Object.entries(left.revisions).every(([id, revision]) => right.revisions[id] === revision);
}
interface InstallationSession {
  id: string;
  presetId: string;
  preset: InstallationPreset;
  configuration: string;
  selection: InstallationSelection;
  expires: number;
  owner?: { tabId: number; frameId: number; documentId: string };
  viewTabId?: number;
  completed?: boolean;
  automatic?: boolean;
  nativeSelection?: string | null;
  nativeReceipt?: string;
  browserRequired?: boolean;
  localComponentCount?: number;
  catalogUrl?: string;
  requestingPage?: string;
}
interface InstallationSourceRequest {
  kind: 'source-request';
  id: string;
  presetId: string;
  catalogUrl: string;
  requestingPage: string;
  expires: number;
  owner: NonNullable<InstallationSession['owner']>;
  viewTabId?: number;
}
const sessionId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const samePage = (value: string | undefined, expected: string) => {
  try { const url = new URL(value!); const target = new URL(expected); return url.origin === target.origin && url.pathname === target.pathname; }
  catch { return false; }
};

function inputRecord(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('INVALID_INSTALLATION_REQUEST');
  return value as Record<string, unknown>;
}

interface NativeInstallation {
  protocol: 1;
  selection: string | null;
  id?: string;
  source?: string;
  browserRequired?: boolean;
}
export interface InstallationDependencies {
  native?: {
    capture: () => Promise<NativeInstallation | undefined>;
    request: (data: Record<string, unknown>, timeoutMs: number) => Promise<any>;
  };
  configuration?: () => Promise<InstallationConfig>;
  registry?: ReturnType<typeof browserCapabilityRegistry>;
  install?: (source: string, presetId: string, origins: string[]) => Promise<void>;
  now?: () => number;
}

/** Website catalogs require extension-owned confirmation before they can supply installation entries. */
export function createInstallationService(dependencies: InstallationDependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const registry = () => dependencies.registry ?? browserCapabilityRegistry();
  const configuration = dependencies.configuration ?? (() => loadInstallationConfig(
    DIRECT_INSTALLATION_CONFIG_URL || new URL('installation.json', INSTALLATION_SITE), INSTALLATION_SITE.origin, AbortSignal.timeout(5_000),
  ));
  let opening: Promise<unknown> = Promise.resolve();
  const running = new Map<string, Promise<InstallationView>>();
  const nativeSessions = new Map<string, { session: InstallationSession; load: BundleLoader; resources: Map<string, Promise<Uint8Array>>; bytes: number }>();

  async function captureNative(session: InstallationSession) {
    const captured = await dependencies.native?.capture();
    if (captured && (captured.protocol !== 1 || !(captured.selection === null || typeof captured.selection === 'string' && /^(?:node:)?[a-f0-9]{64}$/.test(captured.selection)))) throw new Error('INVALID_NATIVE_INSTALLATION_STATE');
    delete session.nativeSelection;
    delete session.nativeReceipt;
    delete session.browserRequired;
    delete session.localComponentCount;
    if (captured) session.nativeSelection = captured.selection;
  }

  async function validatePermissions(session: InstallationSession, value: unknown) {
    if (!Array.isArray(value) || value.length > 64) throw new Error('INSTALLATION_RESOURCE_DENIED');
    const origins = value.map(validateInstallationOrigin);
    if (origins.some(origin => !installationOriginCovered(origin, session.preset.origins))) throw new Error('INSTALLATION_RESOURCE_DENIED');
    const missing = await missingPermissions([...new Set([...session.preset.origins, ...origins])]);
    if (missing.missingOrigins.length || missing.missingAuthorization.length) throw new Error('INSTALLATION_PERMISSION_REQUIRED');
  }

  async function confirmSession(session: InstallationSession) {
    await readSession(session.id);
    if (!sameSelection(session.selection, await registry().captureInstallationSelection())) throw new Error('INSTALLATION_SELECTION_CHANGED');
    const missing = await missingPermissions(session.preset.origins);
    if (missing.missingOrigins.length || missing.missingAuthorization.length) throw new Error('INSTALLATION_PERMISSION_CHANGED');
  }

  function resourceLoader(session: InstallationSession, signal: AbortSignal): BundleLoader {
    return createBundleFetchLoader({ fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.protocol !== 'https:' || url.username || url.password || !session.preset.origins.some(origin => matchesInstallationOrigin(origin, url)) || !(await chrome.permissions.contains({ origins: [`${url.origin}/*`] }))) throw new Error('INSTALLATION_RESOURCE_DENIED');
      if ((await missingPermissions(session.preset.origins)).missingAuthorization.length) throw new Error('INSTALLATION_AUTHORIZATION_REQUIRED');
      return withCookieInjection(url, () => fetch(url, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) }));
    } });
  }

  async function readStoredSession(id: unknown) {
    if (!sessionId(id)) throw new Error('INVALID_INSTALLATION_SESSION');
    const key = `${SESSION_PREFIX}${id}`;
    const value = (await chrome.storage.session.get(key))[key] as InstallationSession | InstallationSourceRequest | undefined;
    if (!value || value.id !== id || !Number.isFinite(value.expires) || value.expires < now()) {
      await chrome.storage.session.remove(key);
      throw new Error(value?.catalogUrl ? 'INSTALLATION_SOURCE_EXPIRED' : 'INSTALLATION_SESSION_EXPIRED');
    }
    return value;
  }

  async function loadRequestedCatalog(catalogUrl: string, requestingPage: string) {
    if (!(await chrome.permissions.contains({ origins: [`${new URL(catalogUrl).origin}/*`] }))) throw new Error('INSTALLATION_PERMISSION_REQUIRED');
    const config = await loadInstallationConfig(catalogUrl, INSTALLATION_SITE.origin, AbortSignal.timeout(5_000));
    if (config.guide?.url !== requestingPage) throw new Error('INSTALLATION_SOURCE_DENIED');
    return config;
  }

  async function readSession(id: unknown, refreshCatalog = true) {
    const value = await readStoredSession(id);
    if ('kind' in value) throw new Error('INSTALLATION_SOURCE_CONFIRMATION_REQUIRED');
    // Read-only authorization previews use the catalog accepted when this session opened.
    // Installation and resource access revalidate against the current trusted catalog.
    const config = refreshCatalog
      ? value.catalogUrl ? await loadRequestedCatalog(value.catalogUrl, value.requestingPage!) : await configuration()
      : parseInstallationConfig(JSON.parse(value.configuration), INSTALLATION_SITE.origin);
    if (JSON.stringify(config) !== value.configuration || !Object.hasOwn(config.presets ?? {}, value.presetId) || config.presets![value.presetId].source !== value.preset.source || config.presets![value.presetId].label !== value.preset.label || JSON.stringify(config.presets![value.presetId].origins) !== JSON.stringify(value.preset.origins)) throw new Error('INSTALLATION_CATALOG_CHANGED');
    return value;
  }

  async function senderIdentity(sender: chrome.runtime.MessageSender, config: InstallationConfig) {
    if (sender.id || typeof sender.tab?.id !== 'number' || sender.tab.id < 0 || !Number.isInteger(sender.frameId) || !sender.documentId || sender.documentLifecycle !== 'active' || sender.origin !== INSTALLATION_SITE.origin || new URL(sender.url ?? INSTALLATION_SITE.href).search) throw new Error('INSTALLATION_SOURCE_DENIED');
    const frameId = sender.frameId!;
    const frame = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId });
    if (!frame || frame.documentId !== sender.documentId || !samePage(frame.url, sender.url!)) throw new Error('INSTALLATION_SOURCE_CHANGED');
    if (frameId === 0) {
      if (![INSTALLATION_CONNECT_URL, INSTALLATION_CONNECT_EN_URL].some(url => samePage(frame.url, url))) throw new Error('INSTALLATION_SOURCE_DENIED');
    } else {
      if (!samePage(frame.url, INSTALLATION_BRIDGE_URL) || frame.parentFrameId !== 0 || !config.guide) throw new Error('INSTALLATION_SOURCE_DENIED');
      const top = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 });
      if (!top || !samePage(top.url, config.guide.url)) throw new Error('INSTALLATION_PARENT_DENIED');
    }
    return { tabId: sender.tab.id, frameId, documentId: sender.documentId };
  }

  async function readiness(presetId: string, preset: InstallationPreset) {
    const status = await registry().installationStatus();
    const missing = await missingPermissions(preset.origins);
    const selected = status.presetSource === preset.source && status.presetId === presetId;
    return {
      ...missing,
      browserReady: Boolean(selected && status.browserReady && status.settingsPending.length === 0 && !missing.missingOrigins.length && !missing.missingAuthorization.length),
      localComponentCount: selected ? status.pending.length : 0,
    };
  }

  async function view(session: InstallationSession): Promise<InstallationView> {
    if (!session.completed && !sameSelection(session.selection, await registry().captureInstallationSelection())) throw new Error('INSTALLATION_SELECTION_CHANGED');
    const state = await readiness(session.presetId, session.preset);
    if (session.browserRequired === false) state.localComponentCount = session.localComponentCount ?? 0;
    let browserRequired = session.browserRequired !== false;
    let localStatus: InstallationView['localStatus'] = state.localComponentCount ? 'setup-required' : 'none';
    let localIssues: InstallationView['localIssues'];
    if (session.nativeReceipt && dependencies.native) {
      try {
        const status = await dependencies.native.request({ operation: 'status', expectedRevision: session.nativeReceipt, presetId: session.presetId, source: session.preset.source }, 5000);
        if (status?.changed) throw new Error('INSTALLATION_SELECTION_CHANGED');
        browserRequired = status?.browserSyncRequired !== false;
        if (Array.isArray(status?.pending)) {
          if (status.pending.length > 256 || status.pending.some((entry: any) => !entry || !['node', 'browser'].includes(entry.runtime) || typeof entry.id !== 'string' || entry.id.length > 120 || typeof entry.reason !== 'string' || entry.reason.length > 120)) throw new Error('INVALID_NATIVE_INSTALLATION_STATUS');
          localIssues = status.pending.filter((entry: any) => entry.runtime === 'node').map((entry: any) => ({ id: entry.id, reason: entry.reason }));
        }
        const localReady = localIssues ? localIssues.length === 0 && Array.isArray(status?.hosts) && status.hosts.length > 0 && status.hosts.every((host: any) => host?.state === 'active') : status?.ready === true;
        localStatus = localReady && status.revision === session.nativeReceipt && status.id === session.presetId ? 'ready' : 'pending';
      } catch (error) { if (error instanceof Error && error.message === 'INSTALLATION_SELECTION_CHANGED') throw error; localStatus = 'setup-required'; }
    }
    return {
      session: session.id, presetId: session.presetId, label: session.preset.label,
      source: session.preset.source, origins: session.preset.origins,
      ...(session.catalogUrl ? { sourceRequest: { catalogUrl: session.catalogUrl, requestingPage: session.requestingPage! } } : {}),
      ...state, localStatus, localIssues, browserRequired, ready: (!browserRequired || state.browserReady) && (session.nativeReceipt ? localStatus === 'ready' : state.localComponentCount === 0),
      needsInstall: session.completed !== true,
    };
  }

  async function availableSessions() {
    const entries = await chrome.storage.session.get(null);
    const sessions = Object.entries(entries).filter(([key]) => key.startsWith(SESSION_PREFIX));
    const expired = sessions.filter(([, value]) => !value || typeof value.expires !== 'number' || value.expires < now()).map(([key]) => key);
    if (expired.length) await chrome.storage.session.remove(expired);
    return sessions.filter(([, value]) => value?.expires >= now());
  }

  async function open(presetId: string, preset: InstallationPreset, config: InstallationConfig, owner: InstallationSession['owner'], active = true, reuseViewTabId?: number) {
    const sessions = await availableSessions();
    const current = sessions.find(([, value]) => (reuseViewTabId === undefined || value.viewTabId === reuseViewTabId) && value.presetId === presetId && value.configuration === JSON.stringify(config) && value.owner?.tabId === owner?.tabId && value.owner?.documentId === owner?.documentId && value.owner?.frameId === owner?.frameId)?.[1] as InstallationSession | undefined;
    if (!current && sessions.length >= 16) throw new Error('INSTALLATION_SESSION_LIMIT');
    const session: InstallationSession = current ?? { id: crypto.randomUUID(), presetId, preset, configuration: JSON.stringify(config), expires: now() + SESSION_LIFETIME, owner, selection: await registry().captureInstallationSelection() };
    session.expires = now() + SESSION_LIFETIME;
    if (!running.has(session.id)) { session.completed = false; await captureNative(session); session.selection = await registry().captureInstallationSelection(); }
    return showView(session, active, reuseViewTabId);
  }

  async function showView(session: InstallationSession | InstallationSourceRequest, active = true, reuseViewTabId?: number) {
    if (reuseViewTabId !== undefined) {
      session.viewTabId = reuseViewTabId;
      await chrome.storage.session.set({ [`${SESSION_PREFIX}${session.id}`]: session });
      return { session: session.id };
    }
    if (session.viewTabId !== undefined) {
      try {
        const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB' as chrome.runtime.ContextType], tabIds: [session.viewTabId] });
        const currentView = contexts.find(context => context.frameId === 0 && samePage(context.documentUrl, chrome.runtime.getURL(INSTALLATION_VIEW_PATH)) && new URL(context.documentUrl!).searchParams.get('session') === session.id);
        if (!currentView) throw new Error('Installation view navigated');
        await chrome.storage.session.set({ [`${SESSION_PREFIX}${session.id}`]: session });
        await chrome.tabs.update(session.viewTabId, { active });
        await chrome.tabs.reload(session.viewTabId);
        return { session: session.id };
      }
      catch { /* The user may have closed the installation tab. */ }
    }
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    if (tab.id === undefined) throw new Error('INSTALLATION_VIEW_UNAVAILABLE');
    session.viewTabId = tab.id;
    try {
      await chrome.storage.session.set({ [`${SESSION_PREFIX}${session.id}`]: session });
      const websiteSource = 'kind' in session || session.catalogUrl ? '&source=website' : '';
      await chrome.tabs.update(tab.id, { url: chrome.runtime.getURL(`${INSTALLATION_VIEW_PATH}?session=${session.id}${websiteSource}`), active });
    } catch (error) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      throw error;
    }
    return { session: session.id };
  }

  async function websiteIdentity(sender: chrome.runtime.MessageSender) {
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.documentId || sender.documentLifecycle !== 'active' || typeof sender.tab?.id !== 'number' || sender.tab.id < 0 || !sender.url) throw new Error('INSTALLATION_SOURCE_DENIED');
    const page = new URL(sender.url);
    if (page.protocol !== 'https:' || page.username || page.password || page.search || sender.origin !== page.origin) throw new Error('INSTALLATION_SOURCE_DENIED');
    const frame = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 });
    if (!frame || frame.documentId !== sender.documentId || !samePage(frame.url, sender.url)) throw new Error('INSTALLATION_SOURCE_CHANGED');
    page.hash = '';
    return { requestingPage: page.href, owner: { tabId: sender.tab.id, frameId: 0, documentId: sender.documentId } };
  }

  async function sourceView(request: InstallationSourceRequest): Promise<InstallationView> {
    const origin = `${new URL(request.catalogUrl).origin}/*`;
    return {
      session: request.id, presetId: request.presetId, label: request.presetId, source: request.catalogUrl,
      origins: [], missingOrigins: await chrome.permissions.contains({ origins: [origin] }) ? [] : [origin],
      missingAuthorization: [], browserReady: false, needsInstall: true, localComponentCount: 0,
      sourceRequest: { catalogUrl: request.catalogUrl, requestingPage: request.requestingPage }, needsSourceConfirmation: true,
    };
  }

  async function acceptSource(request: InstallationSourceRequest): Promise<InstallationView> {
    const selection = await registry().captureInstallationSelection();
    const config = await loadRequestedCatalog(request.catalogUrl, request.requestingPage);
    const preset = config.presets?.[request.presetId];
    if (!preset) throw new Error('INSTALLATION_PRESET_UNAVAILABLE');
    const frame = await chrome.webNavigation.getFrame({ tabId: request.owner.tabId, frameId: 0 });
    if (!frame || frame.documentId !== request.owner.documentId || !samePage(frame.url, request.requestingPage)) throw new Error('INSTALLATION_SOURCE_CHANGED');
    const session: InstallationSession = {
      id: request.id, presetId: request.presetId, preset, configuration: JSON.stringify(config), selection,
      expires: request.expires, owner: request.owner, viewTabId: request.viewTabId,
      catalogUrl: request.catalogUrl, requestingPage: request.requestingPage,
    };
    await captureNative(session);
    const current = await readStoredSession(request.id);
    if (!('kind' in current) || JSON.stringify(current) !== JSON.stringify(request)) throw new Error('INSTALLATION_SOURCE_CHANGED');
    await chrome.storage.session.set({ [`${SESSION_PREFIX}${session.id}`]: session });
    return view(session);
  }

  async function perform(session: InstallationSession, authorize: boolean, replaceSkills?: string[]) {
    if (session.completed) return view(session);
    if (!sameSelection(session.selection, await registry().captureInstallationSelection())) throw new Error('INSTALLATION_SELECTION_CHANGED');
    const missing = await missingPermissions(session.preset.origins);
    if (missing.missingOrigins.length) throw new Error('INSTALLATION_PERMISSION_REQUIRED');
    if (missing.missingAuthorization.length) {
      if (!authorize) throw new Error('INSTALLATION_AUTHORIZATION_REQUIRED');
      await grantPresetOrigins(session.preset.origins);
    }
    if (dependencies.install) await dependencies.install(session.preset.source, session.presetId, session.preset.origins);
    else {
      const controller = new AbortController();
      const load = resourceLoader(session, AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]));
      try {
        if (session.nativeSelection !== undefined && dependencies.native) {
          nativeSessions.set(session.id, { session, load, resources: new Map(), bytes: 0 });
          const result = await dependencies.native.request({ operation: session.nativeReceipt ? 'resume' : session.automatic ? 'update' : 'apply', session: session.id, source: session.preset.source, presetId: session.presetId, expectedRevision: session.nativeSelection, ...(replaceSkills?.length ? { replaceSkills } : {}) }, 1_200_000);
          if (!result || result.id !== session.presetId || typeof result.revision !== 'string' || !/^[a-f0-9]{64}$/.test(result.revision)) throw new Error('INVALID_NATIVE_INSTALLATION_RESULT');
          session.nativeReceipt = result.revision;
          session.browserRequired = result.browserSyncRequired !== false;
          if (Number.isSafeInteger(result.localComponentCount) && result.localComponentCount >= 0) session.localComponentCount = result.localComponentCount;
        } else {
          const target = createBrowserCapabilityRegistry(new BrowserBundleStore({ mearlApiVersion: BROWSER_BUNDLE_API_VERSION }), load);
          const result = await target.applyPreset({ keepIndependentBrowser: true, skipUnchanged: session.automatic, validatePrepared: prepared => validatePermissions(session, prepared.preset.permissions.origins), source: session.preset.source, expectedRevision: session.selection.activeRevision, expectedSelection: session.selection, expectedId: session.presetId, confirm: () => confirmSession(session) });
          if ('browserRequired' in result && result.browserRequired === false) { session.browserRequired = false; session.localComponentCount = result.pending.length; }
        }
      } finally { nativeSessions.delete(session.id); controller.abort(); }
    }
    session.completed = true;
    await chrome.storage.session.set({ [`${SESSION_PREFIX}${session.id}`]: session });
    return view(session);
  }

  return {
    async autoUpdate(): Promise<PresetAutoUpdateResult> {
      if (running.size) return { status: 'skipped' };
      const accepted = await registry().captureInstallationSelection();
      const browser = await registry().installationStatus();
      const native = await dependencies.native?.capture();
      const id = browser.presetId ?? (native?.selection ? native.id : undefined);
      const source = browser.presetSource ?? (native?.selection ? native.source : undefined);
      if (!id || !source) return { status: 'skipped' };
      const config = await configuration();
      const preset = trustedInstallationPreset(config, id, source);
      if (!preset) return { status: 'untrusted', id, source };
      const attached = native?.selection != null && native.id === id && native.source === source;
      if (browser.installationRevision && !attached) return { status: 'waiting-native', id, source };
      if (!sameSelection(accepted, await registry().captureInstallationSelection())) return { status: 'skipped' };
      const missing = await missingPermissions(preset.origins);
      if (missing.missingOrigins.length || missing.missingAuthorization.length) {
        const origins = [...new Set([...missing.missingOrigins, ...missing.missingAuthorization])];
        const notice = JSON.stringify({ id, source, origins });
        const key = 'presetAutoUpdatePermissionNotice';
        if ((await chrome.storage.local.get(key))[key] !== notice) {
          await open(id, preset, config, undefined, false);
          await chrome.storage.local.set({ [key]: notice });
        }
        return { status: 'permission-required', id, source, origins };
      }
      const session: InstallationSession = {
        id: crypto.randomUUID(), presetId: id, preset, configuration: JSON.stringify(config),
        expires: now() + SESSION_LIFETIME, selection: accepted, automatic: true,
        ...(attached ? { nativeSelection: native.selection } : {}),
      };
      const key = `${SESSION_PREFIX}${session.id}`;
      await chrome.storage.session.set({ [key]: session });
      try {
        const before = attached ? native.selection : session.selection.activeRevision;
        const result = await perform(session, false);
        const after = attached ? session.nativeReceipt : (await registry().captureInstallationSelection()).activeRevision;
        await chrome.storage.local.remove('presetAutoUpdatePermissionNotice');
        return { status: before === after ? 'current' : 'updated', id, source, ...((attached && !result.ready || !result.browserReady && result.browserRequired !== false) ? { error: 'INSTALLATION_SYNC_PENDING' } : {}) };
      } finally {
        await chrome.storage.session.remove(key);
      }
    },
    async native(value: unknown, transport: PresetTransferTransport) {
      const input = inputRecord(value, ['operation', 'session', 'source', 'maxBytes', 'offset', 'installationRevision', 'origins', 'browserRequired', 'browserRevision']);
      const context = typeof input.session === 'string' ? nativeSessions.get(input.session) : undefined;
      if (!context || context.session.expires < now()) throw new Error('INSTALLATION_SESSION_EXPIRED');
      const session = context.session;
      if (input.operation === 'permissions') {
        await confirmSession(session);
        await validatePermissions(session, input.origins);
        if (input.browserRequired === true) {
          const prepared = await prepareBrowserPreset(session.preset.source, {
            mearlApiVersion: BROWSER_BUNDLE_API_VERSION,
            load: async (source, options) => {
              const resource = context.resources.get(source);
              if (!resource) throw new Error('INSTALLATION_RESOURCE_NOT_PREPARED');
              const bytes = await resource;
              if (bytes.byteLength > options.maxBytes) throw new Error('INSTALLATION_RESOURCE_QUOTA');
              return bytes;
            },
          });
          if (prepared.snapshot.revision !== input.browserRevision) throw new Error('INSTALLATION_SELECTION_CHANGED');
          await registry().validatePreparedPreset(prepared);
        }
        await confirmSession(session);
        return { confirmed: true };
      }
      if (input.operation === 'confirm') { await confirmSession(session); return { confirmed: true }; }
      if (input.operation === 'sync') {
        if (typeof input.installationRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.installationRevision)) throw new Error('INVALID_NATIVE_INSTALLATION_RESULT');
        session.nativeSelection = input.installationRevision;
        session.nativeReceipt = input.installationRevision;
        await chrome.storage.session.set({ [`${SESSION_PREFIX}${session.id}`]: session });
        const result = await synchronizeBrowserPreset({ operation: 'sync', installationRevision: input.installationRevision }, transport, registry(), { expected: session.selection, confirm: () => confirmSession(session) });
        if (result.ready) {
          session.selection = await registry().captureInstallationSelection(input.installationRevision);
          session.nativeSelection = input.installationRevision;
          await chrome.storage.session.set({ [`${SESSION_PREFIX}${session.id}`]: session });
        }
        return result;
      }
      if (input.operation !== 'resource' || typeof input.source !== 'string' || !Number.isSafeInteger(input.maxBytes) || (input.maxBytes as number) < 0 || (input.maxBytes as number) > MAX_BUNDLE_BYTES || !Number.isSafeInteger(input.offset) || (input.offset as number) < 0 || (input.offset as number) % PRESET_TRANSFER_CHUNK_BYTES !== 0) throw new Error('INVALID_INSTALLATION_RESOURCE_REQUEST');
      let resource = context.resources.get(input.source);
      if (!resource) {
        if (input.offset !== 0 || context.resources.size >= 4256) throw new Error('INVALID_INSTALLATION_RESOURCE_REQUEST');
        if (input.source.length > 4096) throw new Error('INVALID_INSTALLATION_RESOURCE_REQUEST');
        context.bytes += input.maxBytes as number;
        if (context.bytes > MAX_BROWSER_STORAGE_BYTES + MAX_PRESET_TRANSFER_HEADER_BYTES) throw new Error('INSTALLATION_RESOURCE_QUOTA');
        resource = context.load(input.source, { maxBytes: input.maxBytes as number });
        context.resources.set(input.source, resource);
      }
      const bytes = await resource;
      const offset = input.offset as number;
      if (bytes.byteLength > (input.maxBytes as number) || offset >= bytes.byteLength && !(offset === 0 && bytes.byteLength === 0)) throw new Error('INVALID_INSTALLATION_RESOURCE_REQUEST');
      const missing = await missingPermissions(session.preset.origins);
      if (missing.missingOrigins.length || missing.missingAuthorization.length) throw new Error('INSTALLATION_PERMISSION_CHANGED');
      const chunk = bytes.subarray(offset, offset + PRESET_TRANSFER_CHUNK_BYTES);
      let encoded = '';
      for (let start = 0; start < chunk.length; start += 8192) encoded += String.fromCharCode(...chunk.subarray(start, start + 8192));
      return { sha256: offset === 0 ? await bundleDigest(bytes) : undefined, byteLength: bytes.byteLength, data: btoa(encoded) };
    },
    async website(value: unknown, sender: chrome.runtime.MessageSender) {
      const input = inputRecord(value, ['action', 'operation', 'presetId', 'catalogUrl']);
      if (input.action !== 'mearlWebsiteInstallation' || !['open', 'status'].includes(String(input.operation)) || typeof input.presetId !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(input.presetId)) throw new Error('INVALID_INSTALLATION_REQUEST');
      const identity = await websiteIdentity(sender);
      if (input.catalogUrl !== undefined && input.catalogUrl !== DIRECT_INSTALLATION_CONFIG_URL) {
        if (typeof input.catalogUrl !== 'string' || input.catalogUrl.length > 4096) throw new Error('INVALID_INSTALLATION_REQUEST');
        const catalog = new URL(input.catalogUrl);
        if (catalog.protocol !== 'https:' || catalog.origin !== sender.origin || catalog.username || catalog.password || catalog.hash || catalog.search) throw new Error('INSTALLATION_SOURCE_DENIED');
        if (input.operation === 'status') return { connected: true, version: getExtensionVersion(), browserReady: false, requiresSourceConfirmation: true };
        const next = opening.catch(() => {}).then(async () => {
          const sessions = await availableSessions();
          const current = sessions.find(([, value]) => value.kind === 'source-request' && value.catalogUrl === catalog.href && value.presetId === input.presetId && value.owner?.tabId === identity.owner.tabId && value.owner?.documentId === identity.owner.documentId)?.[1] as InstallationSourceRequest | undefined;
          if (!current && sessions.length >= 16) throw new Error('INSTALLATION_SESSION_LIMIT');
          const request: InstallationSourceRequest = current ?? { kind: 'source-request', id: crypto.randomUUID(), presetId: input.presetId as string, catalogUrl: catalog.href, ...identity, expires: now() + SESSION_LIFETIME };
          return showView(request);
        });
        opening = next;
        return next;
      }
      if (!DIRECT_INSTALLATION_CONFIG_URL && !dependencies.configuration) throw new Error('INSTALLATION_SITE_NOT_CONFIGURED');
      const config = await configuration();
      if (config.guide?.url !== identity.requestingPage) throw new Error('INSTALLATION_SOURCE_DENIED');
      await websiteIdentity(sender);
      if (!Object.hasOwn(config.presets ?? {}, input.presetId)) throw new Error('INSTALLATION_PRESET_UNAVAILABLE');
      const preset = config.presets![input.presetId];
      if (input.operation === 'status') {
        const status = await readiness(input.presetId, preset);
        return { connected: true, version: getExtensionVersion(), browserReady: status.browserReady, localComponentCount: status.localComponentCount };
      }
      const next = opening.catch(() => {}).then(() => open(input.presetId as string, preset, config, identity.owner));
      opening = next;
      return next;
    },
    async external(value: unknown, sender: chrome.runtime.MessageSender) {
      const input = inputRecord(value, ['action', 'operation', 'presetId']);
      if (input.action !== INSTALLATION_ACTION || !['open', 'status'].includes(String(input.operation)) || typeof input.presetId !== 'string') throw new Error('INVALID_INSTALLATION_REQUEST');
      const config = await configuration();
      const owner = await senderIdentity(sender, config);
      if (!Object.hasOwn(config.presets ?? {}, input.presetId)) throw new Error('INSTALLATION_PRESET_UNAVAILABLE');
      const preset = config.presets![input.presetId];
      if (input.operation === 'status') {
        const status = await readiness(input.presetId, preset);
        return { connected: true, version: getExtensionVersion(), browserReady: status.browserReady, localComponentCount: status.localComponentCount };
      }
      const next = opening.catch(() => {}).then(() => open(input.presetId as string, preset, config, owner));
      opening = next;
      return next;
    },
    async internal(value: unknown, sender: chrome.runtime.MessageSender) {
      const input = inputRecord(value, ['action', 'operation', 'session', 'authorize', 'replaceSkills']);
      if (input.action !== INSTALLATION_ACTION || !['inspect', 'install', 'retry', 'restart', 'confirmSource', 'cancel'].includes(String(input.operation)) || (input.authorize !== undefined && typeof input.authorize !== 'boolean')) throw new Error('INVALID_INSTALLATION_REQUEST');
      if (input.replaceSkills !== undefined && (input.operation !== 'retry' || input.authorize !== true || !Array.isArray(input.replaceSkills) || !input.replaceSkills.length || input.replaceSkills.length > 256 || input.replaceSkills.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(id)) || new Set(input.replaceSkills).size !== input.replaceSkills.length)) throw new Error('INVALID_INSTALLATION_REQUEST');
      if (!isExtensionUiSender(sender, chrome.runtime.id) || !samePage(sender.url, chrome.runtime.getURL(INSTALLATION_VIEW_PATH))) throw new Error('INSTALLATION_VIEW_REQUIRED');
      if (input.operation === 'restart') {
        if (typeof sender.tab?.id !== 'number' || sender.frameId !== 0) throw new Error('INSTALLATION_VIEW_REQUIRED');
        const browser = await registry().installationStatus();
        const native = await dependencies.native?.capture();
        const id = browser.presetId ?? (native?.selection ? native.id : undefined);
        const source = browser.presetSource ?? (native?.selection ? native.source : undefined);
        const config = await configuration();
        const preset = trustedInstallationPreset(config, id, source);
        if (!id || !preset) throw new Error('INSTALLATION_PRESET_UNAVAILABLE');
        const next = opening.catch(() => {}).then(() => open(id, preset, config, undefined, false, sender.tab!.id));
        opening = next;
        return next;
      }
      const stored = await readStoredSession(input.session);
      if (sender.tab?.id !== stored.viewTabId || new URL(sender.url!).searchParams.get('session') !== stored.id || sender.frameId !== 0) throw new Error('INSTALLATION_VIEW_REQUIRED');
      if (input.operation === 'cancel') {
        if (running.has(stored.id)) throw new Error('INSTALLATION_BUSY');
        await chrome.storage.session.remove(`${SESSION_PREFIX}${stored.id}`);
        return { cancelled: true };
      }
      if ('kind' in stored) {
        if (input.operation === 'inspect') return sourceView(stored);
        if (input.operation !== 'confirmSource') throw new Error('INSTALLATION_SOURCE_CONFIRMATION_REQUIRED');
        const current = running.get(stored.id);
        if (current) return current;
        const next = acceptSource(stored).finally(() => running.delete(stored.id));
        running.set(stored.id, next);
        return next;
      }
      if (input.operation === 'confirmSource') return view(await readSession(input.session, false));
      const session = await readSession(input.session, input.operation !== 'inspect');
      if (input.operation === 'inspect') return view(session);
      if (session.catalogUrl && !session.completed && input.authorize !== true) throw new Error('INSTALLATION_AUTHORIZATION_REQUIRED');
      if (input.operation === 'retry') {
        if (running.has(session.id)) return running.get(session.id)!;
        const latest = await view(session);
        if (!latest.browserReady && latest.browserRequired !== false) throw new Error('INSTALLATION_SELECTION_CHANGED');
        if (input.replaceSkills !== undefined && (!session.nativeReceipt || (input.replaceSkills as string[]).some(id => !latest.localIssues?.some(issue => issue.id === id && ['SKILL_SOURCE_CONFLICT', 'SKILL_PLUGIN_REGISTRATION_CONFLICT', 'SKILL_PLUGIN_REGISTRATION_REQUIRED'].includes(issue.reason))))) throw new Error('INVALID_SKILL_REPLACEMENT_SELECTION');
        session.completed = false;
        if (session.nativeReceipt) session.nativeSelection = session.nativeReceipt;
        else await captureNative(session);
        await chrome.storage.session.set({ [`${SESSION_PREFIX}${session.id}`]: session });
      }
      const missing = await missingPermissions(session.preset.origins);
      if (missing.missingAuthorization.length && input.authorize !== true) throw new Error('INSTALLATION_AUTHORIZATION_REQUIRED');
      const existing = running.get(session.id);
      if (existing) return existing;
      const task = perform(session, input.authorize === true, input.replaceSkills as string[] | undefined).finally(() => running.delete(session.id));
      running.set(session.id, task);
      return task;
    },
  };
}
