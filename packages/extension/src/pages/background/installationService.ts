import type { InstalledPreset, PresetAutoUpdateResult } from '../../shared/presetAutoUpdate';
import { getExtensionVersion } from '../../shared/extensionVersion';
import { resolvePreset, type ResolvedComponent } from '@mearl/preset';
import {
  loadInstallationConfig,
  parseInstallationConfig,
  matchesInstallationOrigin,
  trustedInstallationPreset,
  installationOriginCovered,
  validateInstallationOrigin,
  type InstallationConfig,
  type InstallationPreset,
} from '@mearl/preset/installation';
import {
  BrowserBundleStore,
  prepareBrowserPreset,
  createBundleFetchLoader,
  bundleDigest,
  MAX_BUNDLE_BYTES,
  MAX_BROWSER_STORAGE_BYTES,
  MAX_PRESET_TRANSFER_HEADER_BYTES,
  PRESET_TRANSFER_CHUNK_BYTES,
  type BundleLoader,
  type PresetTransferTransport,
} from '@mearl/preset/bundles';
import {
  missingPresetPermissions as missingPermissions,
  grantPresetOrigins,
} from '../../shared/presetPermissions';
import {
  INSTALLATION_ACTION,
  INSTALLATION_SITE,
  INSTALLATION_BRIDGE_URL,
  INSTALLATION_VIEW_PATH,
  SHOW_PRESET_INSTALLATION_POPUP,
  type InstallationOpening,
  type InstallationPreview,
  type InstallationView,
} from '../../shared/installation';
import { parseBrowserUiSettings } from '../../shared/browserUiSettings';
import { isExtensionUiSender } from './extensionMessageTrust';
import {
  BROWSER_BUNDLE_API_VERSION,
  browserCapabilityRegistry,
  createBrowserCapabilityRegistry,
} from './browserCapabilityRegistry';
import { withCookieInjection } from './utils/dnr';
import { presetPermissionPromptActive, synchronizeBrowserPreset } from './browserPresetSync';
import { CUSTOM_INSTALL_PAGE_URL } from './installPage';
import { openPermissionRequestWindow } from './permissionRequestWindow';

const SESSION_PREFIX = 'mearl-installation:';
const SESSION_LIFETIME = 15 * 60_000;
type InstallationSelection = Awaited<
  ReturnType<ReturnType<typeof browserCapabilityRegistry>['captureInstallationSelection']>
>;
function sameSelection(left: InstallationSelection, right: InstallationSelection) {
  return (
    left.activeRevision === right.activeRevision &&
    left.installationToken === right.installationToken &&
    Object.keys(left.revisions).length === Object.keys(right.revisions).length &&
    Object.entries(left.revisions).every(([id, revision]) => right.revisions[id] === revision)
  );
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
  viewDocumentId?: string;
  viewUrl?: string;
  completed?: boolean;
  automatic?: boolean;
  firstInstall?: boolean;
  settingsViewKey?: string;
  nativeSelection?: string | null;
  nativeReceipt?: string;
  browserRequired?: boolean;
  localComponentCount?: number;
  catalogUrl?: string;
  requestingPage?: string;
}
type InstallationSourceRequest = {
  kind: 'source-request';
  id: string;
  catalogUrl: string;
  requestingPage: string;
  expires: number;
  viewTabId?: number;
  viewDocumentId?: string;
  viewUrl?: string;
  settingsViewKey?: string;
  preferredPresetId?: string;
} & (
  | (WebsiteIdentity & { presetId: string })
  | { selection: InstallationSelection; owner?: never; presetId?: never }
);
interface WebsiteIdentity {
  owner: NonNullable<InstallationSession['owner']>;
  requestingPage: string;
}
type StoredInstallation = InstallationSession | InstallationSourceRequest;

function ownsInlineView(stored: StoredInstallation, sender: chrome.runtime.MessageSender) {
  return sender.documentId
    ? sender.documentId === stored.viewDocumentId
    : !sender.tab && Boolean(stored.viewUrl) && sender.url === stored.viewUrl;
}

function validateSiteGrant(
  stored: StoredInstallation,
  sender: chrome.runtime.MessageSender,
  presetId: unknown,
  origins: string[],
) {
  if (!ownsInlineView(stored, sender)) throw new Error('INSTALLATION_VIEW_REQUIRED');
  const sourceRequest = 'kind' in stored;
  const scopes = sourceRequest ? [`${new URL(stored.catalogUrl).origin}/*`] : stored.preset.origins;
  if (
    (sourceRequest ? presetId !== undefined : stored.completed || presetId !== stored.presetId) ||
    origins.some(origin => !scopes.includes(origin))
  )
    throw new Error('INSTALLATION_SELECTION_CHANGED');
}

function installationPage(value: string): URL {
  const page = new URL(value);
  if (page.protocol !== 'https:' || page.username || page.password || page.search)
    throw new Error('INSTALLATION_SOURCE_DENIED');
  page.hash = '';
  return page;
}
const sessionId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const samePage = (value: string | undefined, expected: string) => {
  try {
    const url = new URL(value!);
    const target = new URL(expected);
    return url.origin === target.origin && url.pathname === target.pathname;
  } catch {
    return false;
  }
};

function inputRecord(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !allowed.includes(key))
  )
    throw new Error('INVALID_INSTALLATION_REQUEST');
  return value as Record<string, unknown>;
}

interface NativeInstallation {
  protocol: 1;
  selection: string | null;
  id?: string;
  version?: string;
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

/** Binds website catalogs to the requesting document and the extension's installation view. */
export function createInstallationService(dependencies: InstallationDependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const registry = () => dependencies.registry ?? browserCapabilityRegistry();
  const configuration =
    dependencies.configuration ??
    (() =>
      loadInstallationConfig(
        new URL('installation.json', INSTALLATION_SITE),
        INSTALLATION_SITE.origin,
        AbortSignal.timeout(5_000),
      ));
  let opening: Promise<unknown> = Promise.resolve();
  const running = new Map<string, Promise<InstallationView>>();
  // Chrome requires the permission request to start synchronously on the click message.
  const inlineSessions = new Map<string, StoredInstallation>();
  const nativeSessions = new Map<
    string,
    {
      session: InstallationSession;
      load: BundleLoader;
      resources: Map<string, Promise<Uint8Array>>;
      bytes: number;
    }
  >();

  async function captureNative(session: InstallationSession) {
    const captured = await dependencies.native?.capture();
    if (
      captured &&
      (captured.protocol !== 1 ||
        !(
          captured.selection === null ||
          (typeof captured.selection === 'string' &&
            /^(?:node:)?[a-f0-9]{64}$/.test(captured.selection))
        ))
    )
      throw new Error('INVALID_NATIVE_INSTALLATION_STATE');
    delete session.nativeSelection;
    delete session.nativeReceipt;
    delete session.browserRequired;
    delete session.localComponentCount;
    if (captured) session.nativeSelection = captured.selection;
  }

  async function validatePermissions(session: InstallationSession, value: unknown) {
    if (!Array.isArray(value) || value.length > 64) throw new Error('INSTALLATION_RESOURCE_DENIED');
    const origins = value.map(validateInstallationOrigin);
    if (origins.some(origin => !installationOriginCovered(origin, session.preset.origins)))
      throw new Error('INSTALLATION_RESOURCE_DENIED');
    const missing = await missingPermissions([...new Set([...session.preset.origins, ...origins])]);
    if (missing.missingOrigins.length || missing.missingAuthorization.length)
      throw new Error('INSTALLATION_PERMISSION_REQUIRED');
  }

  async function confirmSession(session: InstallationSession) {
    await readSession(session.id);
    if (session.firstInstall && (await dependencies.native?.capture())?.selection != null)
      throw new Error('INSTALLATION_SELECTION_CHANGED');
    if (!sameSelection(session.selection, await registry().captureInstallationSelection()))
      throw new Error('INSTALLATION_SELECTION_CHANGED');
    const missing = await missingPermissions(session.preset.origins);
    if (missing.missingOrigins.length || missing.missingAuthorization.length)
      throw new Error('INSTALLATION_PERMISSION_CHANGED');
  }

  async function checkResourceAccess(preset: InstallationPreset, url: URL) {
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !preset.origins.some(origin => matchesInstallationOrigin(origin, url)) ||
      !(await chrome.permissions.contains({ origins: [`${url.origin}/*`] }))
    )
      throw new Error('INSTALLATION_RESOURCE_DENIED');
  }

  function resourceLoader(session: InstallationSession, signal: AbortSignal): BundleLoader {
    return createBundleFetchLoader({
      fetch: async (input, init) => {
        const url = new URL(String(input));
        await checkResourceAccess(session.preset, url);
        if ((await missingPermissions(session.preset.origins)).missingAuthorization.length)
          throw new Error('INSTALLATION_AUTHORIZATION_REQUIRED');
        return withCookieInjection(url, () =>
          fetch(url, {
            ...init,
            signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
          }),
        );
      },
    });
  }

  async function previewPresets(session: InstallationSession) {
    const signal = AbortSignal.timeout(5_000);
    const presets =
      session.catalogUrl || session.settingsViewKey
        ? (sessionCatalog(session).presets ?? {})
        : { [session.presetId]: session.preset };
    const load = createBundleFetchLoader();
    const manifests = new Map<string, Promise<Uint8Array>>();
    const enabled = (entries: Record<string, ResolvedComponent>) =>
      Object.values(entries).filter(entry => entry.enabled !== false).length;
    const preview = async (id: string, entry: InstallationPreset): Promise<InstallationPreview> => {
      const preset = await resolvePreset(entry.source, {
        mearlApiVersion: BROWSER_BUNDLE_API_VERSION,
        signal,
        load: async source => {
          // Shared manifests still require access within each preset's own scopes.
          await checkResourceAccess(entry, new URL(source));
          const key = String(source);
          let manifest = manifests.get(key);
          if (!manifest) {
            manifest = load(source, { maxBytes: 262_144, signal });
            manifests.set(key, manifest);
          }
          return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await manifest));
        },
      });
      if (
        preset.id !== id ||
        preset.permissions.origins.some(origin => !installationOriginCovered(origin, entry.origins))
      )
        throw new Error('INSTALLATION_RESOURCE_DENIED');
      const extension = preset.defaults.extension;
      return {
        purpose:
          extension === undefined
            ? undefined
            : parseBrowserUiSettings(extension).settings.messages?.presetInstallPurpose,
        appProfileCount: Object.keys(preset.appProfiles).length,
        packageCount: enabled(preset.packages),
        skillCount: enabled(preset.skills),
        providerCount: enabled(preset.providers),
      };
    };
    const entries = await Promise.all(
      Object.entries(presets).map(
        async ([id, entry]) => [id, await preview(id, entry).catch(() => undefined)] as const,
      ),
    );
    return Object.fromEntries(entries.filter(([, result]) => result !== undefined));
  }

  function rememberInlineSession(session: StoredInstallation) {
    if (session.viewDocumentId || session.viewUrl) inlineSessions.set(session.id, session);
  }

  async function saveSession(session: StoredInstallation) {
    inlineSessions.delete(session.id);
    await chrome.storage.session.set({ [`${SESSION_PREFIX}${session.id}`]: session });
    rememberInlineSession(session);
  }

  async function readStoredSession(id: unknown) {
    if (!sessionId(id)) throw new Error('INVALID_INSTALLATION_SESSION');
    const key = `${SESSION_PREFIX}${id}`;
    const value = (await chrome.storage.session.get(key))[key] as
      InstallationSession | InstallationSourceRequest | undefined;
    if (!value || value.id !== id || !Number.isFinite(value.expires) || value.expires < now()) {
      inlineSessions.delete(id);
      await chrome.storage.session.remove(key);
      throw new Error(
        value?.catalogUrl ? 'INSTALLATION_SOURCE_EXPIRED' : 'INSTALLATION_SESSION_EXPIRED',
      );
    }
    rememberInlineSession(value);
    return value;
  }

  async function loadRequestedCatalog(catalogUrl: string, requestingPage: string) {
    if (!(await chrome.permissions.contains({ origins: [`${new URL(catalogUrl).origin}/*`] })))
      throw new Error('INSTALLATION_PERMISSION_REQUIRED');
    const config = await loadInstallationConfig(
      catalogUrl,
      INSTALLATION_SITE.origin,
      AbortSignal.timeout(5_000),
    );
    if (config.guide?.url !== requestingPage) throw new Error('INSTALLATION_SOURCE_DENIED');
    return config;
  }

  function sessionCatalog(session: InstallationSession) {
    return parseInstallationConfig(JSON.parse(session.configuration), INSTALLATION_SITE.origin);
  }

  function preferredPreset(presets: Record<string, InstallationPreset>, preferred?: string) {
    return preferred && Object.hasOwn(presets, preferred) ? preferred : Object.keys(presets)[0];
  }

  async function readSession(id: unknown, refreshCatalog = true) {
    const value = await readStoredSession(id);
    if ('kind' in value) throw new Error('INSTALLATION_SOURCE_CONFIRMATION_REQUIRED');
    // Read-only authorization previews use the catalog accepted when this session opened.
    // Installation and resource access revalidate against the current trusted catalog.
    const config = refreshCatalog
      ? value.catalogUrl
        ? await loadRequestedCatalog(value.catalogUrl, value.requestingPage!)
        : await configuration()
      : sessionCatalog(value);
    if (
      JSON.stringify(config) !== value.configuration ||
      !Object.hasOwn(config.presets ?? {}, value.presetId) ||
      config.presets![value.presetId].source !== value.preset.source ||
      config.presets![value.presetId].label !== value.preset.label ||
      JSON.stringify(config.presets![value.presetId].origins) !==
        JSON.stringify(value.preset.origins)
    )
      throw new Error('INSTALLATION_CATALOG_CHANGED');
    return value;
  }

  async function bridgeIdentity(sender: chrome.runtime.MessageSender) {
    if (
      sender.id ||
      typeof sender.tab?.id !== 'number' ||
      sender.tab.id < 0 ||
      !Number.isInteger(sender.frameId) ||
      !sender.documentId ||
      sender.documentLifecycle !== 'active' ||
      sender.origin !== INSTALLATION_SITE.origin ||
      new URL(sender.url ?? INSTALLATION_SITE.href).search
    )
      throw new Error('INSTALLATION_SOURCE_DENIED');
    const frameId = sender.frameId!;
    const frame = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId });
    if (
      !frame ||
      frame.documentLifecycle !== 'active' ||
      frame.documentId !== sender.documentId ||
      !samePage(frame.url, sender.url!)
    )
      throw new Error('INSTALLATION_SOURCE_CHANGED');
    if (frameId === 0 || !samePage(frame.url, INSTALLATION_BRIDGE_URL) || frame.parentFrameId !== 0)
      throw new Error('INSTALLATION_SOURCE_DENIED');
    const top = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 });
    if (
      !top?.documentId ||
      top.documentLifecycle !== 'active' ||
      frame.parentDocumentId !== top.documentId
    )
      throw new Error('INSTALLATION_PARENT_DENIED');
    return {
      requestingPage: installationPage(top.url).href,
      owner: { tabId: sender.tab.id, frameId: 0, documentId: top.documentId },
    };
  }

  async function readiness(presetId: string, preset: InstallationPreset) {
    const status = await registry().installationStatus();
    const missing = await missingPermissions(preset.origins);
    const selected = status.presetSource === preset.source && status.presetId === presetId;
    return {
      ...missing,
      browserReady: Boolean(
        selected &&
        status.browserReady &&
        status.settingsPending.length === 0 &&
        !missing.missingOrigins.length &&
        !missing.missingAuthorization.length,
      ),
      localComponentCount: selected ? status.pending.length : 0,
    };
  }

  async function view(session: InstallationSession): Promise<InstallationView> {
    if (
      !session.completed &&
      !sameSelection(session.selection, await registry().captureInstallationSelection())
    )
      throw new Error('INSTALLATION_SELECTION_CHANGED');
    const state = await readiness(session.presetId, session.preset);
    if (session.browserRequired === false)
      state.localComponentCount = session.localComponentCount ?? 0;
    let browserRequired = session.browserRequired !== false;
    let localStatus: InstallationView['localStatus'] = state.localComponentCount
      ? 'setup-required'
      : 'none';
    let localIssues: InstallationView['localIssues'];
    if (session.nativeReceipt && dependencies.native) {
      try {
        const status = await dependencies.native.request(
          {
            operation: 'status',
            expectedRevision: session.nativeReceipt,
            presetId: session.presetId,
            source: session.preset.source,
          },
          5000,
        );
        if (status?.changed) throw new Error('INSTALLATION_SELECTION_CHANGED');
        browserRequired = status?.browserSyncRequired !== false;
        if (Array.isArray(status?.pending)) {
          if (
            status.pending.length > 256 ||
            status.pending.some(
              (entry: any) =>
                !entry ||
                !['node', 'browser'].includes(entry.runtime) ||
                typeof entry.id !== 'string' ||
                entry.id.length > 120 ||
                typeof entry.reason !== 'string' ||
                entry.reason.length > 120,
            )
          )
            throw new Error('INVALID_NATIVE_INSTALLATION_STATUS');
          localIssues = status.pending
            .filter((entry: any) => entry.runtime === 'node')
            .map((entry: any) => ({ id: entry.id, reason: entry.reason }));
        }
        const localReady = localIssues
          ? localIssues.length === 0 &&
            Array.isArray(status?.hosts) &&
            status.hosts.length > 0 &&
            status.hosts.every((host: any) => host?.state === 'active')
          : status?.ready === true;
        localStatus =
          localReady && status.revision === session.nativeReceipt && status.id === session.presetId
            ? 'ready'
            : 'pending';
      } catch (error) {
        if (error instanceof Error && error.message === 'INSTALLATION_SELECTION_CHANGED')
          throw error;
        localStatus = 'setup-required';
      }
    }
    return {
      session: session.id,
      presetId: session.presetId,
      label: session.preset.label,
      source: session.preset.source,
      origins: session.preset.origins,
      ...(session.catalogUrl
        ? {
            sourceRequest: {
              catalogUrl: session.catalogUrl,
              requestingPage: session.requestingPage!,
            },
          }
        : {}),
      ...state,
      localStatus,
      localIssues,
      browserRequired,
      ready:
        (!browserRequired || state.browserReady) &&
        (session.nativeReceipt ? localStatus === 'ready' : state.localComponentCount === 0),
      needsInstall: session.completed !== true,
      ...(!session.completed && (session.catalogUrl || session.settingsViewKey)
        ? {
            presetChoices: Object.entries(sessionCatalog(session).presets ?? {}).map(
              ([id, entry]) => ({ id, label: entry.label }),
            ),
          }
        : {}),
    };
  }

  async function availableSessions() {
    const entries = await chrome.storage.session.get(null);
    const sessions = Object.entries(entries).filter(([key]) => key.startsWith(SESSION_PREFIX));
    const expired = sessions
      .filter(([, value]) => !value || typeof value.expires !== 'number' || value.expires < now())
      .map(([key]) => key);
    if (expired.length) {
      for (const key of expired) inlineSessions.delete(key.slice(SESSION_PREFIX.length));
      await chrome.storage.session.remove(expired);
    }
    return sessions.filter(([, value]) => value?.expires >= now());
  }

  function isInstallationView(url: string | undefined, session: string) {
    return (
      samePage(url, chrome.runtime.getURL(INSTALLATION_VIEW_PATH)) &&
      new URL(url!).searchParams.get('session') === session
    );
  }

  async function openManaged(
    presetId: string,
    preset: InstallationPreset,
    config: InstallationConfig,
    reuseViewTabId?: number,
  ) {
    const sessions = await availableSessions();
    const current = sessions.find(
      ([, value]) =>
        (reuseViewTabId === undefined || value.viewTabId === reuseViewTabId) &&
        value.presetId === presetId &&
        value.configuration === JSON.stringify(config) &&
        !value.owner &&
        !value.catalogUrl &&
        !value.settingsViewKey,
    )?.[1] as InstallationSession | undefined;
    if (!current && sessions.length >= 16) throw new Error('INSTALLATION_SESSION_LIMIT');
    const session: InstallationSession = current ?? {
      id: crypto.randomUUID(),
      presetId,
      preset,
      configuration: JSON.stringify(config),
      expires: now() + SESSION_LIFETIME,
      selection: await registry().captureInstallationSelection(),
    };
    session.expires = now() + SESSION_LIFETIME;
    if (!running.has(session.id)) {
      session.completed = false;
      await captureNative(session);
      session.selection = await registry().captureInstallationSelection();
    }
    return showView(session, false, reuseViewTabId);
  }

  async function showView(
    session: InstallationSession | InstallationSourceRequest,
    active = true,
    reuseViewTabId?: number,
  ) {
    if (reuseViewTabId !== undefined) {
      delete session.viewDocumentId;
      delete session.viewUrl;
      session.viewTabId = reuseViewTabId;
      await saveSession(session);
      return { session: session.id };
    }
    if (session.viewTabId !== undefined) {
      try {
        const contexts = await chrome.runtime.getContexts({
          contextTypes: ['TAB' as chrome.runtime.ContextType],
          tabIds: [session.viewTabId],
        });
        const currentView = contexts.find(
          context => context.frameId === 0 && isInstallationView(context.documentUrl, session.id),
        );
        if (!currentView) throw new Error('Installation view navigated');
        await saveSession(session);
        await chrome.tabs.update(session.viewTabId, { active });
        if (active && currentView.windowId >= 0)
          await chrome.windows.update(currentView.windowId, { focused: true });
        await chrome.tabs.reload(session.viewTabId);
        return { session: session.id };
      } catch {
        /* The user may have closed the installation tab. */
      }
    }
    if (active && (await showInToolbarPopup(session))) return { session: session.id };
    delete session.viewDocumentId;
    delete session.viewUrl;
    const popup = await openPermissionRequestWindow('about:blank', 520, 560, active);
    if (popup?.id === undefined) throw new Error('INSTALLATION_VIEW_UNAVAILABLE');
    try {
      const tabId = popup.tabs?.[0]?.id ?? (await chrome.tabs.query({ windowId: popup.id }))[0]?.id;
      if (tabId === undefined) throw new Error('INSTALLATION_VIEW_UNAVAILABLE');
      session.viewTabId = tabId;
      await saveSession(session);
      const source = session.settingsViewKey
        ? '&source=settings'
        : 'kind' in session || session.catalogUrl
          ? '&source=website'
          : '';
      await chrome.tabs.update(tabId, {
        url: chrome.runtime.getURL(`${INSTALLATION_VIEW_PATH}?session=${session.id}${source}`),
        active,
      });
    } catch (error) {
      await chrome.windows.remove(popup.id).catch(() => {});
      throw error;
    }
    return { session: session.id };
  }

  async function showInToolbarPopup(session: InstallationSession | InstallationSourceRequest) {
    try {
      const url = chrome.runtime.getURL('src/pages/popup/index.html');
      const [popup] = await chrome.runtime.getContexts({
        contextTypes: ['POPUP' as chrome.runtime.ContextType],
        documentUrls: [url],
      });
      if (!popup) return false;
      delete session.viewTabId;
      session.viewDocumentId = popup.documentId;
      session.viewUrl = url;
      await saveSession(session);
      const response = await chrome.runtime.sendMessage({
        action: SHOW_PRESET_INSTALLATION_POPUP,
        session: session.id,
      });
      return response?.opened === true;
    } catch {
      return false;
    }
  }

  async function websiteIdentity(sender: chrome.runtime.MessageSender) {
    if (
      sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 ||
      !sender.documentId ||
      sender.documentLifecycle !== 'active' ||
      typeof sender.tab?.id !== 'number' ||
      sender.tab.id < 0 ||
      !sender.url
    )
      throw new Error('INSTALLATION_SOURCE_DENIED');
    const page = installationPage(sender.url);
    if (sender.origin !== page.origin) throw new Error('INSTALLATION_SOURCE_DENIED');
    const frame = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 });
    if (!frame || frame.documentId !== sender.documentId || !samePage(frame.url, sender.url))
      throw new Error('INSTALLATION_SOURCE_CHANGED');
    return {
      requestingPage: page.href,
      owner: { tabId: sender.tab.id, frameId: 0, documentId: sender.documentId },
    };
  }

  async function requestWebsiteSource(
    operation: 'open' | 'status',
    presetId: string,
    catalogUrl: unknown,
    identity: WebsiteIdentity,
  ) {
    if (typeof catalogUrl !== 'string' || catalogUrl.length > 4096)
      throw new Error('INVALID_INSTALLATION_REQUEST');
    const catalog = new URL(catalogUrl);
    if (
      catalog.protocol !== 'https:' ||
      catalog.origin !== new URL(identity.requestingPage).origin ||
      catalog.username ||
      catalog.password ||
      catalog.hash ||
      catalog.search
    )
      throw new Error('INSTALLATION_SOURCE_DENIED');
    const skipSourceConfirmation =
      identity.requestingPage === CUSTOM_INSTALL_PAGE_URL &&
      catalog.href === new URL('public-installation.json', identity.requestingPage).href &&
      (await chrome.permissions.contains({ origins: [`${catalog.origin}/*`] }));
    if (operation === 'status')
      return {
        connected: true,
        version: getExtensionVersion(),
        browserReady: false,
        requiresSourceConfirmation: !skipSourceConfirmation,
      };
    const next = opening
      .catch(() => {})
      .then(async () => {
        const sessions = await availableSessions();
        const current = sessions.find(
          ([, value]) =>
            (value.kind === 'source-request' || (skipSourceConfirmation && !value.completed)) &&
            value.catalogUrl === catalog.href &&
            value.presetId === presetId &&
            value.owner?.tabId === identity.owner.tabId &&
            value.owner?.documentId === identity.owner.documentId,
        )?.[1] as InstallationSourceRequest | InstallationSession | undefined;
        if (!current && sessions.length >= 16) throw new Error('INSTALLATION_SESSION_LIMIT');
        if (
          current &&
          !('kind' in current) &&
          (running.has(current.id) ||
            sameSelection(current.selection, await registry().captureInstallationSelection()))
        )
          return showView(current);
        const request: InstallationSourceRequest =
          current && 'kind' in current
            ? current
            : {
                kind: 'source-request',
                id: current?.id ?? crypto.randomUUID(),
                presetId,
                catalogUrl: catalog.href,
                ...identity,
                viewTabId: current?.viewTabId,
                expires: now() + SESSION_LIFETIME,
              };
        return showView(skipSourceConfirmation ? await prepareSourceSession(request) : request);
      });
    opening = next;
    return next;
  }

  async function sourceView(request: InstallationSourceRequest): Promise<InstallationView> {
    const origin = `${new URL(request.catalogUrl).origin}/*`;
    return {
      session: request.id,
      presetId: request.presetId ?? '',
      label: request.presetId ?? new URL(request.requestingPage).hostname,
      source: request.catalogUrl,
      origins: [],
      missingOrigins: (await chrome.permissions.contains({ origins: [origin] })) ? [] : [origin],
      missingAuthorization: [],
      browserReady: false,
      needsInstall: true,
      localComponentCount: 0,
      sourceRequest: { catalogUrl: request.catalogUrl, requestingPage: request.requestingPage },
      needsSourceConfirmation: true,
    };
  }

  async function prepareSourceSession(request: InstallationSourceRequest) {
    const selection =
      'selection' in request ? request.selection : await registry().captureInstallationSelection();
    const config = await loadRequestedCatalog(request.catalogUrl, request.requestingPage);
    const presets = config.presets ?? {};
    const presetId = request.presetId ?? preferredPreset(presets, request.preferredPresetId);
    if (!presetId || !Object.hasOwn(presets, presetId))
      throw new Error('INSTALLATION_PRESET_UNAVAILABLE');
    if (request.owner) {
      const frame = await chrome.webNavigation.getFrame({ tabId: request.owner.tabId, frameId: 0 });
      if (
        !frame ||
        frame.documentId !== request.owner.documentId ||
        !samePage(frame.url, request.requestingPage)
      )
        throw new Error('INSTALLATION_SOURCE_CHANGED');
    } else if (
      (!request.settingsViewKey && (await dependencies.native?.capture())?.selection != null) ||
      !sameSelection(selection, await registry().captureInstallationSelection())
    ) {
      throw new Error('INSTALLATION_SELECTION_CHANGED');
    }
    const session: InstallationSession = {
      id: request.id,
      presetId,
      preset: presets[presetId],
      configuration: JSON.stringify(config),
      selection,
      expires: request.expires,
      owner: request.owner,
      viewTabId: request.viewTabId,
      viewDocumentId: request.viewDocumentId,
      viewUrl: request.viewUrl,
      catalogUrl: request.catalogUrl,
      requestingPage: request.requestingPage,
      ...(request.settingsViewKey
        ? { settingsViewKey: request.settingsViewKey }
        : 'selection' in request
          ? { firstInstall: true }
          : {}),
    };
    if (request.owner || request.settingsViewKey) await captureNative(session);
    return session;
  }

  async function acceptSource(request: InstallationSourceRequest): Promise<InstallationView> {
    const session = await prepareSourceSession(request);
    const current = await readStoredSession(request.id);
    if (!('kind' in current) || JSON.stringify(current) !== JSON.stringify(request))
      throw new Error('INSTALLATION_SOURCE_CHANGED');
    await saveSession(session);
    return view(session);
  }

  async function prepareSettingsSession(settingsViewKey: string, preferredPresetId?: string) {
    const selection = await registry().captureInstallationSelection();
    const sessions = await availableSessions();
    const current = sessions.find(
      ([, session]) =>
        session.settingsViewKey === settingsViewKey &&
        !session.completed &&
        (running.has(session.id) || sameSelection(selection, session.selection)),
    )?.[1] as InstallationSession | InstallationSourceRequest | undefined;
    if (current) return current;
    if (sessions.length >= 16) throw new Error('INSTALLATION_SESSION_LIMIT');
    const seed = {
      id: crypto.randomUUID(),
      selection,
      settingsViewKey,
      expires: now() + SESSION_LIFETIME,
    };
    if (CUSTOM_INSTALL_PAGE_URL) {
      const catalog = new URL('public-installation.json', CUSTOM_INSTALL_PAGE_URL);
      const request: InstallationSourceRequest = {
        ...seed,
        kind: 'source-request',
        catalogUrl: catalog.href,
        requestingPage: CUSTOM_INSTALL_PAGE_URL,
        preferredPresetId,
      };
      if (!(await chrome.permissions.contains({ origins: [`${catalog.origin}/*`] })))
        return request;
      return prepareSourceSession(request);
    }

    const config = await configuration();
    const presets = config.presets ?? {};
    const presetId = preferredPreset(presets, preferredPresetId);
    if (!presetId) throw new Error('INSTALLATION_PRESET_UNAVAILABLE');
    const session: InstallationSession = {
      ...seed,
      presetId,
      preset: presets[presetId],
      configuration: JSON.stringify(config),
    };
    await captureNative(session);
    return session;
  }

  async function selectPreset(session: InstallationSession, presetId: string) {
    if (session.completed || !(session.catalogUrl || session.settingsViewKey))
      throw new Error('INVALID_INSTALLATION_REQUEST');
    const { presets = {} } = sessionCatalog(session);
    if (!Object.hasOwn(presets, presetId)) throw new Error('INSTALLATION_PRESET_UNAVAILABLE');
    const selected = { ...session, presetId, preset: presets[presetId] };
    const result = await view(selected);
    await saveSession(selected);
    return result;
  }

  async function perform(
    session: InstallationSession,
    authorize: boolean,
    replaceSkills?: string[],
  ) {
    if (session.completed) return view(session);
    if (!sameSelection(session.selection, await registry().captureInstallationSelection()))
      throw new Error('INSTALLATION_SELECTION_CHANGED');
    const missing = await missingPermissions(session.preset.origins);
    if (missing.missingOrigins.length) throw new Error('INSTALLATION_PERMISSION_REQUIRED');
    if (missing.missingAuthorization.length) {
      if (!authorize) throw new Error('INSTALLATION_AUTHORIZATION_REQUIRED');
      await grantPresetOrigins(session.preset.origins);
    }
    if (dependencies.install)
      await dependencies.install(session.preset.source, session.presetId, session.preset.origins);
    else {
      const controller = new AbortController();
      const load = resourceLoader(
        session,
        AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
      );
      try {
        if (session.nativeSelection !== undefined && dependencies.native) {
          nativeSessions.set(session.id, { session, load, resources: new Map(), bytes: 0 });
          const result = await dependencies.native.request(
            {
              operation: session.nativeReceipt ? 'resume' : session.automatic ? 'update' : 'apply',
              session: session.id,
              source: session.preset.source,
              presetId: session.presetId,
              expectedRevision: session.nativeSelection,
              ...(replaceSkills?.length ? { replaceSkills } : {}),
            },
            1_200_000,
          );
          if (
            !result ||
            result.id !== session.presetId ||
            typeof result.revision !== 'string' ||
            !/^[a-f0-9]{64}$/.test(result.revision)
          )
            throw new Error('INVALID_NATIVE_INSTALLATION_RESULT');
          session.nativeReceipt = result.revision;
          session.browserRequired = result.browserSyncRequired !== false;
          if (Number.isSafeInteger(result.localComponentCount) && result.localComponentCount >= 0)
            session.localComponentCount = result.localComponentCount;
        } else {
          const target = createBrowserCapabilityRegistry(
            new BrowserBundleStore({ mearlApiVersion: BROWSER_BUNDLE_API_VERSION }),
            load,
          );
          const result = await target.applyPreset({
            keepIndependentBrowser: true,
            skipUnchanged: session.automatic,
            validatePrepared: prepared =>
              validatePermissions(session, prepared.preset.permissions.origins),
            source: session.preset.source,
            expectedRevision: session.selection.activeRevision,
            expectedSelection: session.selection,
            expectedId: session.presetId,
            confirm: () => confirmSession(session),
          });
          if ('browserRequired' in result && result.browserRequired === false) {
            session.browserRequired = false;
            session.localComponentCount = result.pending.length;
          }
        }
      } finally {
        nativeSessions.delete(session.id);
        controller.abort();
      }
    }
    session.completed = true;
    await saveSession(session);
    return view(session);
  }

  async function installedPresets(): Promise<InstalledPreset[]> {
    const browser = await registry().installationStatus(true);
    const native = await dependencies.native?.capture();
    const attached = Boolean(
      native?.selection &&
      (native.selection === browser.installationRevision ||
        (native.id === browser.presetId && native.source === browser.presetSource)),
    );
    const presets: InstalledPreset[] = [];
    if (browser.presetId && !attached) {
      presets.push({
        id: browser.presetId,
        version: browser.presetVersion,
        source: browser.presetSource,
        browserRevision: browser.browserRevision,
      });
    }
    if (native?.id && native.selection) {
      presets.push({
        id: native.id,
        version: native.version ?? (attached ? browser.presetVersion : undefined),
        source: native.source,
        browserRevision: attached ? browser.browserRevision : null,
        nativeRevision: native.selection,
      });
    }
    return presets;
  }

  return {
    installedPresets,
    async canInstallPresets() {
      return Boolean(
        CUSTOM_INSTALL_PAGE_URL || Object.keys((await configuration()).presets ?? {}).length,
      );
    },
    async openPresetSelector(
      sender: chrome.runtime.MessageSender,
      inline: boolean,
      preferredPresetId?: string,
    ): Promise<InstallationOpening> {
      const { documentId, tab, url } = sender;
      if (!isExtensionUiSender(sender, chrome.runtime.id) || !url)
        throw new Error('INSTALLATION_VIEW_REQUIRED');
      // Messages from toolbar popup frames have no tab or document ID.
      const settingsViewKey = documentId ?? (inline && !tab ? url : undefined);
      if (!settingsViewKey) throw new Error('INSTALLATION_VIEW_REQUIRED');
      const next = opening
        .catch(() => {})
        .then(async () => {
          const session = await prepareSettingsSession(settingsViewKey, preferredPresetId);
          if (!inline) return showView(session);
          delete session.viewTabId;
          if (documentId) {
            session.viewDocumentId = documentId;
            delete session.viewUrl;
          } else {
            delete session.viewDocumentId;
            session.viewUrl = url;
          }
          await saveSession(session);
          return { session: session.id, inline: true };
        });
      opening = next;
      return next;
    },
    async installDefaultForGuide(guide: string): Promise<void> {
      const selection = await registry().captureInstallationSelection();
      if (selection.activeRevision || selection.installationToken) return;
      const native = await dependencies.native?.capture();
      if (native?.selection != null) return;

      const catalog = new URL('public-installation.json', guide);
      const request: InstallationSourceRequest = {
        kind: 'source-request',
        id: crypto.randomUUID(),
        catalogUrl: catalog.href,
        requestingPage: guide,
        selection,
        expires: now() + SESSION_LIFETIME,
      };
      if (!(await chrome.permissions.contains({ origins: [`${catalog.origin}/*`] }))) {
        await showView(request);
        return;
      }

      const session = await prepareSourceSession(request);
      const missing = await missingPermissions(session.preset.origins);
      if (missing.missingOrigins.length || missing.missingAuthorization.length) {
        await showView(session);
        return;
      }

      const key = `${SESSION_PREFIX}${session.id}`;
      await saveSession(session);
      try {
        await perform(session, false);
      } finally {
        await chrome.storage.session.remove(key);
      }
    },
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
      if (
        (browser.installationRevision && !attached) ||
        (attached && native.browserRequired === true && !browser.browserRevision)
      )
        return { status: 'waiting-native', id, source };
      if (!sameSelection(accepted, await registry().captureInstallationSelection()))
        return { status: 'skipped' };
      const missing = await missingPermissions(preset.origins);
      if (missing.missingOrigins.length || missing.missingAuthorization.length) {
        const origins = [...new Set([...missing.missingOrigins, ...missing.missingAuthorization])];
        if (
          attached &&
          browser.installationRevision &&
          browser.installationRevision === native.selection &&
          origins.every(origin => browser.permissionPending.includes(origin)) &&
          (await presetPermissionPromptActive(browser.installationRevision))
        )
          return { status: 'permission-required', id, source, origins };
        const notice = JSON.stringify({ id, source, origins });
        const key = 'presetAutoUpdatePermissionNotice';
        if ((await chrome.storage.local.get(key))[key] !== notice) {
          await openManaged(id, preset, config);
          await chrome.storage.local.set({ [key]: notice });
        }
        return { status: 'permission-required', id, source, origins };
      }
      const session: InstallationSession = {
        id: crypto.randomUUID(),
        presetId: id,
        preset,
        configuration: JSON.stringify(config),
        expires: now() + SESSION_LIFETIME,
        selection: accepted,
        automatic: true,
        ...(attached ? { nativeSelection: native.selection } : {}),
      };
      const key = `${SESSION_PREFIX}${session.id}`;
      await saveSession(session);
      try {
        const before = attached ? native.selection : session.selection.activeRevision;
        const result = await perform(session, false);
        const after = attached
          ? session.nativeReceipt
          : (await registry().captureInstallationSelection()).activeRevision;
        await chrome.storage.local.remove('presetAutoUpdatePermissionNotice');
        return {
          status: before === after ? 'current' : 'updated',
          id,
          source,
          ...((attached && !result.ready) ||
          (!result.browserReady && result.browserRequired !== false)
            ? { error: 'INSTALLATION_SYNC_PENDING' }
            : {}),
        };
      } finally {
        await chrome.storage.session.remove(key);
      }
    },
    async native(value: unknown, transport: PresetTransferTransport) {
      const input = inputRecord(value, [
        'operation',
        'session',
        'source',
        'maxBytes',
        'offset',
        'installationRevision',
        'origins',
        'browserRequired',
        'browserRevision',
      ]);
      const context =
        typeof input.session === 'string' ? nativeSessions.get(input.session) : undefined;
      if (!context || context.session.expires < now())
        throw new Error('INSTALLATION_SESSION_EXPIRED');
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
              if (bytes.byteLength > options.maxBytes)
                throw new Error('INSTALLATION_RESOURCE_QUOTA');
              return bytes;
            },
          });
          if (prepared.snapshot.revision !== input.browserRevision)
            throw new Error('INSTALLATION_SELECTION_CHANGED');
          await registry().validatePreparedPreset(prepared);
        }
        await confirmSession(session);
        return { confirmed: true };
      }
      if (input.operation === 'confirm') {
        await confirmSession(session);
        return { confirmed: true };
      }
      if (input.operation === 'sync') {
        if (
          typeof input.installationRevision !== 'string' ||
          !/^[a-f0-9]{64}$/.test(input.installationRevision)
        )
          throw new Error('INVALID_NATIVE_INSTALLATION_RESULT');
        session.nativeSelection = input.installationRevision;
        session.nativeReceipt = input.installationRevision;
        await saveSession(session);
        const result = await synchronizeBrowserPreset(
          { operation: 'sync', installationRevision: input.installationRevision },
          transport,
          registry(),
          { accepted: { expected: session.selection, confirm: () => confirmSession(session) } },
        );
        if (result.ready) {
          session.selection = await registry().captureInstallationSelection(
            input.installationRevision,
          );
          session.nativeSelection = input.installationRevision;
          await saveSession(session);
        }
        return result;
      }
      if (
        input.operation !== 'resource' ||
        typeof input.source !== 'string' ||
        !Number.isSafeInteger(input.maxBytes) ||
        (input.maxBytes as number) < 0 ||
        (input.maxBytes as number) > MAX_BUNDLE_BYTES ||
        !Number.isSafeInteger(input.offset) ||
        (input.offset as number) < 0 ||
        (input.offset as number) % PRESET_TRANSFER_CHUNK_BYTES !== 0
      )
        throw new Error('INVALID_INSTALLATION_RESOURCE_REQUEST');
      let resource = context.resources.get(input.source);
      if (!resource) {
        if (input.offset !== 0 || context.resources.size >= 4256)
          throw new Error('INVALID_INSTALLATION_RESOURCE_REQUEST');
        if (input.source.length > 4096) throw new Error('INVALID_INSTALLATION_RESOURCE_REQUEST');
        context.bytes += input.maxBytes as number;
        if (context.bytes > MAX_BROWSER_STORAGE_BYTES + MAX_PRESET_TRANSFER_HEADER_BYTES)
          throw new Error('INSTALLATION_RESOURCE_QUOTA');
        resource = context.load(input.source, { maxBytes: input.maxBytes as number });
        context.resources.set(input.source, resource);
      }
      const bytes = await resource;
      const offset = input.offset as number;
      if (
        bytes.byteLength > (input.maxBytes as number) ||
        (offset >= bytes.byteLength && !(offset === 0 && bytes.byteLength === 0))
      )
        throw new Error('INVALID_INSTALLATION_RESOURCE_REQUEST');
      const missing = await missingPermissions(session.preset.origins);
      if (missing.missingOrigins.length || missing.missingAuthorization.length)
        throw new Error('INSTALLATION_PERMISSION_CHANGED');
      const chunk = bytes.subarray(offset, offset + PRESET_TRANSFER_CHUNK_BYTES);
      let encoded = '';
      for (let start = 0; start < chunk.length; start += 8192)
        encoded += String.fromCharCode(...chunk.subarray(start, start + 8192));
      return {
        sha256: offset === 0 ? await bundleDigest(bytes) : undefined,
        byteLength: bytes.byteLength,
        data: btoa(encoded),
      };
    },
    async website(value: unknown, sender: chrome.runtime.MessageSender) {
      const input = inputRecord(value, ['action', 'operation', 'presetId', 'catalogUrl']);
      if (
        input.action !== 'mearlWebsiteInstallation' ||
        (input.operation !== 'open' && input.operation !== 'status') ||
        typeof input.presetId !== 'string' ||
        !/^[a-z][a-z0-9-]{0,79}$/.test(input.presetId)
      )
        throw new Error('INVALID_INSTALLATION_REQUEST');
      return requestWebsiteSource(
        input.operation,
        input.presetId,
        input.catalogUrl,
        await websiteIdentity(sender),
      );
    },
    async external(value: unknown, sender: chrome.runtime.MessageSender) {
      const input = inputRecord(value, ['action', 'operation', 'presetId', 'catalogUrl']);
      if (
        input.action !== INSTALLATION_ACTION ||
        (input.operation !== 'open' && input.operation !== 'status') ||
        typeof input.presetId !== 'string' ||
        !/^[a-z][a-z0-9-]{0,79}$/.test(input.presetId)
      )
        throw new Error('INVALID_INSTALLATION_REQUEST');
      return requestWebsiteSource(
        input.operation,
        input.presetId,
        input.catalogUrl,
        await bridgeIdentity(sender),
      );
    },
    async internal(value: unknown, sender: chrome.runtime.MessageSender) {
      const input = inputRecord(value, [
        'action',
        'operation',
        'session',
        'presetId',
        'authorize',
        'origins',
        'replaceSkills',
      ]);
      if (
        input.action !== INSTALLATION_ACTION ||
        ![
          'inspect',
          'preview',
          'selectPreset',
          'grant',
          'install',
          'retry',
          'restart',
          'confirmSource',
          'cancel',
        ].includes(String(input.operation)) ||
        ((input.operation === 'selectPreset' || input.presetId !== undefined) &&
          (!['selectPreset', 'grant', 'install', 'retry'].includes(String(input.operation)) ||
            typeof input.presetId !== 'string' ||
            !/^[a-z][a-z0-9-]{0,79}$/.test(input.presetId))) ||
        (input.authorize !== undefined && typeof input.authorize !== 'boolean') ||
        (input.origins !== undefined && input.operation !== 'grant')
      )
        throw new Error('INVALID_INSTALLATION_REQUEST');
      if (
        input.replaceSkills !== undefined &&
        (input.operation !== 'retry' ||
          input.authorize !== true ||
          !Array.isArray(input.replaceSkills) ||
          !input.replaceSkills.length ||
          input.replaceSkills.length > 256 ||
          input.replaceSkills.some(
            id => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(id),
          ) ||
          new Set(input.replaceSkills).size !== input.replaceSkills.length)
      )
        throw new Error('INVALID_INSTALLATION_REQUEST');
      if (!isExtensionUiSender(sender, chrome.runtime.id))
        throw new Error('INSTALLATION_VIEW_REQUIRED');
      let operation = input.operation;
      let authorize = input.authorize === true;
      let grantedOrigins: string[] | undefined;
      if (operation === 'grant') {
        if (
          (!sender.documentId && sender.tab) ||
          !sessionId(input.session) ||
          !Array.isArray(input.origins) ||
          !input.origins.length ||
          input.origins.length > 64
        )
          throw new Error('INVALID_INSTALLATION_REQUEST');
        grantedOrigins = input.origins.map(validateInstallationOrigin);
        const cached = inlineSessions.get(input.session);
        if (!cached || cached.expires < now()) {
          const restored = await readStoredSession(input.session);
          validateSiteGrant(restored, sender, input.presetId, grantedOrigins);
          throw new Error('INSTALLATION_PERMISSION_RETRY');
        }
        validateSiteGrant(cached, sender, input.presetId, grantedOrigins);
        if (running.has(cached.id)) throw new Error('INSTALLATION_BUSY');
        // The popup can close as Chrome opens the permission prompt. Start the
        // request on the click's message and keep its continuation in the worker.
        if (!(await chrome.permissions.request({ origins: grantedOrigins })))
          throw new Error('INSTALLATION_PERMISSION_REQUIRED');
        authorize = true;
      }
      const popupView = samePage(sender.url, chrome.runtime.getURL(INSTALLATION_VIEW_PATH));
      if (operation === 'restart') {
        if (!popupView || typeof sender.tab?.id !== 'number' || sender.frameId !== 0)
          throw new Error('INSTALLATION_VIEW_REQUIRED');
        const browser = await registry().installationStatus();
        const native = await dependencies.native?.capture();
        const id = browser.presetId ?? (native?.selection ? native.id : undefined);
        const source = browser.presetSource ?? (native?.selection ? native.source : undefined);
        const config = await configuration();
        const preset = trustedInstallationPreset(config, id, source);
        if (!id || !preset) throw new Error('INSTALLATION_PRESET_UNAVAILABLE');
        const next = opening
          .catch(() => {})
          .then(() => openManaged(id, preset, config, sender.tab!.id));
        opening = next;
        return next;
      }
      const stored = await readStoredSession(input.session);
      const inlineView = Boolean(stored.viewDocumentId || stored.viewUrl);
      const ownsView = inlineView
        ? ownsInlineView(stored, sender)
        : popupView &&
          typeof stored.viewTabId === 'number' &&
          sender.tab?.id === stored.viewTabId &&
          new URL(sender.url!).searchParams.get('session') === stored.id &&
          sender.frameId === 0;
      if (!ownsView) throw new Error('INSTALLATION_VIEW_REQUIRED');
      if (grantedOrigins) {
        validateSiteGrant(stored, sender, input.presetId, grantedOrigins);
        operation = 'kind' in stored ? 'confirmSource' : 'install';
      }
      if (operation === 'cancel') {
        if (running.has(stored.id)) throw new Error('INSTALLATION_BUSY');
        inlineSessions.delete(stored.id);
        await chrome.storage.session.remove(`${SESSION_PREFIX}${stored.id}`);
        return { cancelled: true };
      }
      if ('kind' in stored) {
        if (operation === 'inspect') return sourceView(stored);
        if (operation !== 'confirmSource')
          throw new Error('INSTALLATION_SOURCE_CONFIRMATION_REQUIRED');
        const current = running.get(stored.id);
        if (current) return current;
        const next = acceptSource(stored).finally(() => running.delete(stored.id));
        running.set(stored.id, next);
        return next;
      }
      if (operation === 'confirmSource') return view(await readSession(input.session, false));
      if (operation === 'preview') return previewPresets(await readSession(input.session, false));
      if (operation === 'inspect') return view(await readSession(input.session, false));
      if (
        operation !== 'selectPreset' &&
        input.presetId !== undefined &&
        input.presetId !== stored.presetId
      )
        throw new Error('INSTALLATION_SELECTION_CHANGED');
      const existing = running.get(stored.id);
      if (existing) {
        if (operation === 'selectPreset') throw new Error('INSTALLATION_BUSY');
        return existing;
      }
      const task = (async () => {
        const session = await readSession(input.session, operation !== 'selectPreset');
        if (operation === 'selectPreset') return selectPreset(session, input.presetId as string);
        if (session.presetId !== stored.presetId) throw new Error('INSTALLATION_SELECTION_CHANGED');
        if ((session.catalogUrl || session.settingsViewKey) && !session.completed && !authorize)
          throw new Error('INSTALLATION_AUTHORIZATION_REQUIRED');
        if (operation === 'retry') {
          const latest = await view(session);
          if (!latest.browserReady && latest.browserRequired !== false)
            throw new Error('INSTALLATION_SELECTION_CHANGED');
          if (
            input.replaceSkills !== undefined &&
            (!session.nativeReceipt ||
              (input.replaceSkills as string[]).some(
                id =>
                  !latest.localIssues?.some(
                    issue =>
                      issue.id === id &&
                      [
                        'SKILL_SOURCE_CONFLICT',
                        'SKILL_PLUGIN_REGISTRATION_CONFLICT',
                        'SKILL_PLUGIN_REGISTRATION_REQUIRED',
                      ].includes(issue.reason),
                  ),
              ))
          )
            throw new Error('INVALID_SKILL_REPLACEMENT_SELECTION');
          session.completed = false;
          if (session.nativeReceipt) session.nativeSelection = session.nativeReceipt;
          else await captureNative(session);
          await saveSession(session);
        }
        const missing = await missingPermissions(session.preset.origins);
        if (missing.missingAuthorization.length && !authorize)
          throw new Error('INSTALLATION_AUTHORIZATION_REQUIRED');
        return perform(session, authorize, input.replaceSkills as string[] | undefined);
      })().finally(() => running.delete(stored.id));
      running.set(stored.id, task);
      return task;
    },
  };
}
