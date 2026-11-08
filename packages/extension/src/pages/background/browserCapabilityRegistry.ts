import { invalidateRequestInspection } from './requestInspection';
import { missingPresetPermissions } from '../../shared/presetPermissions';
import { invalidateBrowserTracking } from './browserTracking';
import {
  appProfileRevision,
  APP_PROFILE_NAMES,
  DomainPermissionError,
  validateAppProfileDefinition,
  type AppProfileCatalogEntry,
} from '@mearl/browser-core';
import {
  BrowserBundleStore,
  BundleError,
  createBundleFetchLoader,
  prepareBundle,
  resolveProfileSource,
  prepareBrowserPreset,
  presetRequiresBrowser,
  prepareBrowserBundleSnapshot,
  verifyPreparedBrowserPreset,
  readBundleJson,
  readBundleText,
  selectBrowserRequestUi,
  selectBrowserView,
  selectBrowserControl,
  selectExtensionContributions,
  type SelectedBrowserControl,
  type BundleLoader,
  type PreparedBundle,
  type PreparedBrowserPreset,
  type BrowserPresetInstallation,
  type BrowserViewSlot,
} from '@mearl/preset/bundles';
import { isAgentDomainAuthorized } from '../../shared/proxyPermissions';
import { withCookieInjection } from './utils/dnr';
import { validateBrowserCapabilities } from './browserCapabilities';
import { browserCapabilityCatalog, profileEntries, presetSettings, browserPresetStatus, BROWSER_BUNDLE_API_VERSION, type BrowserBundleSelection } from './browserCapabilityCatalog';
import { mergePresetDefaults, resolveCapabilityConfig, type ResolvedPreset } from '@mearl/preset';
import { BROWSER_REQUEST_UI_CHANGED } from '../../shared/browserRequestUi';
import { validateRequestUiSetting } from '../../shared/browserRequestUiValidation';
import { validateBrowserViewPreferences } from '../../shared/browserViewPreferences';
import { resolveBrowserPresetSettings, type BrowserPresetSettings } from '../../shared/browserPresetSettings';
import type { JsonObject } from '@mearl/preset';


function validateBrowserUiContributions(bundles: PreparedBundle[], apiVersion: string) {
  selectExtensionContributions(bundles);
  validateBrowserViewPreferences(selectBrowserView(bundles, 'requestImport', apiVersion));
  validateBrowserViewPreferences(selectBrowserView(bundles, 'requestCases', apiVersion));
  validateBrowserViewPreferences(selectBrowserView(bundles, 'captureLauncher', apiVersion));
  validateBrowserViewPreferences(selectBrowserView(bundles, 'captureController', apiVersion));
  const selected = selectBrowserRequestUi(bundles, apiVersion);
  if (selected) validateRequestUiSetting(selected.definition);
  return selected;
}

const presetListeners = new Set<() => void>();
export function onBrowserPresetChange(listener: () => void) { presetListeners.add(listener); return () => { presetListeners.delete(listener); }; }
function notifyRequestUiChanged() {
  for (const listener of presetListeners) { try { listener(); } catch { /* A listener cannot interrupt preset activation. */ } }
  invalidateBrowserTracking();
  invalidateRequestInspection();
  try {
    void chrome.runtime.sendMessage({ action: BROWSER_REQUEST_UI_CHANGED }).catch(() => {});
  } catch {
    /* The registry also runs in hosts without extension messaging. */
  }
}

export { BROWSER_BUNDLE_API_VERSION } from './browserCapabilityCatalog';

export function createBrowserCapabilityRegistry(store: BrowserBundleStore, load: BundleLoader, profileLoad = load) {
  async function installBundle(bundle: PreparedBundle, previous: BrowserBundleSelection, expectedRevision: string | null) {
    const profiles = profileEntries(bundle);
    const candidates = [...previous.bundles.filter(entry => entry.manifest.id !== bundle.manifest.id), bundle];
    validateBrowserUiContributions(candidates, BROWSER_BUNDLE_API_VERSION);
    await validateBrowserCapabilities(candidates, [bundle.manifest.id]);
    await store.install(bundle, expectedRevision, previous.revisions);
    notifyRequestUiChanged();
    return { id: bundle.manifest.id, source: bundle.source, version: bundle.manifest.version, revision: bundle.revision, profiles };
  }

  async function applyPrepared(
    prepared: PreparedBrowserPreset,
    previous: { activeRevision: string | null; revisions: Record<string, string> },
    association?: {
      installation?: BrowserPresetInstallation;
      expectedInstallationToken: string | null;
    },
    confirm?: () => Promise<void>,
    validateOnly = false,
  ) {
    const profiles = prepared.bundles.flatMap(profileEntries);
    for (const target of Object.values(prepared.preset.appProfiles)) {
      if (!profiles.some(profile => profile.id === target))
        throw new BundleError(
          'BUNDLE_INVALID',
          'The selected app implementation is not provided by its package',
        );
    }
    const current = await store.list();
    const previousManaged = new Set(
      Object.keys(current.activation?.snapshot.bundleRevisions ?? {}),
    );
    const replacing = new Set(prepared.bundles.map(bundle => bundle.manifest.id));
    for (const id of replacing) {
      if (Object.hasOwn(current.revisions, id) && !previousManaged.has(id))
        throw new BundleError('BUNDLE_CONFLICT', 'An independently installed bundle owns this ID');
    }
    const candidates = [
      ...current.bundles.filter(
        bundle => !previousManaged.has(bundle.manifest.id) && !replacing.has(bundle.manifest.id),
      ),
      ...prepared.bundles,
    ];
    validateBrowserUiContributions(candidates, BROWSER_BUNDLE_API_VERSION);
    presetSettings(prepared.preset, association?.installation?.overrides ?? {}, candidates);
    await validateBrowserCapabilities(candidates, [...replacing], resolveCapabilityConfig(mergePresetDefaults(prepared.preset.defaults, association?.installation?.overrides ?? {})));
    if (validateOnly) return browserPresetStatus(prepared.preset, prepared.snapshot.revision);
    await confirm?.();
    await store.activatePreset(
      prepared.snapshot,
      prepared.bundles.map(bundle => ({
        bundle,
        expectedRevision: previous.revisions[bundle.manifest.id] ?? null,
      })),
      previous.activeRevision,
      association,
      previous.revisions,
    );
    notifyRequestUiChanged();
    return browserPresetStatus(prepared.preset, prepared.snapshot.revision);
  }
  async function installationStatus() {
    const current = await store.list();
    let browserReady = Boolean(
      current.activation &&
      !current.activationError &&
      !current.installationError &&
      !current.errors.some(error =>
        Object.hasOwn(current.activation?.snapshot.bundleRevisions ?? {}, error.id),
      ),
    );
    let error = current.installationError ?? current.activationError;
    if (browserReady) {
      try {
        await prepareBrowserBundleSnapshot(
          current.bundles,
          'extension',
          BROWSER_BUNDLE_API_VERSION,
          resolveCapabilityConfig(mergePresetDefaults(current.activation!.preset.defaults, current.installation?.overrides ?? {})),
        );
        validateBrowserUiContributions(current.bundles, BROWSER_BUNDLE_API_VERSION);
        const profiles = current.bundles
          .filter(bundle =>
            Object.hasOwn(current.activation!.snapshot.bundleRevisions, bundle.manifest.id),
          )
          .flatMap(profileEntries);
        if (
          Object.values(current.activation!.preset.appProfiles).some(
            target => !profiles.some(profile => profile.id === target),
          )
        )
          throw new BundleError('BUNDLE_INVALID', 'The selected app implementation is missing');
      } catch (failure) {
        browserReady = false;
        error = failure instanceof Error ? failure.message : 'Invalid app profile contribution';
      }
    }
    let settingsPending: string[] = [];
    if (browserReady) {
      try {
        settingsPending = presetSettings(
          current.activation!.preset,
          current.installation?.overrides ?? {},
          current.bundles,
        ).pending;
      } catch (failure) {
        browserReady = false;
        error = failure instanceof Error ? failure.message : 'Invalid browser settings';
      }
    }
    const requiredOrigins = current.activation?.preset.permissions.origins ?? [];
    let permissionPending: string[] = [];
    try {
      const missing = await missingPresetPermissions(requiredOrigins);
      permissionPending = [...new Set([...missing.missingOrigins, ...missing.missingAuthorization])];
    } catch (failure) {
      browserReady = false;
      error = failure instanceof Error ? failure.message : 'Invalid preset permissions';
    }
    const ready = browserReady && Boolean(current.installation) && permissionPending.length === 0;
    return {
      browserReady,
      requiredOrigins,
      permissionPending,
      presetId: current.activation?.preset.id,
      presetVersion: current.activation?.preset.version,
      presetSource: current.activation?.snapshot.source,
      pending: current.activation ? browserPresetStatus(current.activation.preset, current.activation.snapshot.revision).pending : [],
      installationRevision: current.installation?.revision ?? null,
      browserRevision: current.activeRevision,
      ready,
      settingsReady: ready && settingsPending.length === 0,
      settingsPending,
      ...(error ? { error } : {}),
    };
  }
  return {
    captureSelection: () => store.list(),
    async settings(selection?: BrowserBundleSelection): Promise<BrowserPresetSettings & { cacheScope: string; browserControl?: SelectedBrowserControl; appProfiles: AppProfileCatalogEntry[] }> {
      const current = selection ?? await store.list();
      if (
        current.activationError ||
        current.installationError ||
        current.errors.some(error =>
          Object.hasOwn(current.activation?.snapshot.bundleRevisions ?? {}, error.id),
        )
      )
        throw new BundleError(
          'BUNDLE_INTEGRITY',
          'The selected browser settings graph is unavailable',
        );
      const catalog = browserCapabilityCatalog(current);
      return { ...catalog.settings(), appProfiles: catalog.profiles().profiles, cacheScope: JSON.stringify([current.activeRevision, current.installationToken, current.revisions]) };
    },
    async view(slot: BrowserViewSlot = 'requestImport') {
      const current = await store.list();
      if (
        current.activationError ||
        current.errors.some(error =>
          Object.hasOwn(current.activation?.snapshot.bundleRevisions ?? {}, error.id),
        )
      )
        throw new BundleError('BUNDLE_INTEGRITY', 'The selected browser view graph is unavailable');
      return browserCapabilityCatalog(current).view(slot);
    },
    async requestUi() {
      const current = await store.list();
      if (
        current.activationError ||
        current.errors.some(error =>
          Object.hasOwn(current.activation?.snapshot.bundleRevisions ?? {}, error.id),
        )
      )
        throw new BundleError('BUNDLE_INTEGRITY', 'The selected browser UI graph is unavailable');
      return browserCapabilityCatalog(current).requestUi();
    },
    installationStatus,
    async captureInstallationSelection(expectedInstallationRevision?: string) {
      const current = await store.list();
      if (expectedInstallationRevision !== undefined && (
        current.installation?.revision !== expectedInstallationRevision ||
        current.installation.browserRevision !== current.activeRevision ||
        !current.installationToken || current.installationError || current.activationError
      )) throw new BundleError('BUNDLE_CONFLICT', 'INSTALLATION_SELECTION_CHANGED');
      return {
        activeRevision: current.activeRevision,
        revisions: current.revisions,
        installationToken: current.installationToken,
      };
    },
    async validatePreparedPreset(input: PreparedBrowserPreset) {
      const prepared = await verifyPreparedBrowserPreset(input, BROWSER_BUNDLE_API_VERSION);
      const current = await store.list();
      await applyPrepared(prepared, current, { installation: current.installation, expectedInstallationToken: current.installationToken }, undefined, true);
    },
    async applyPreparedPreset(input: {
      prepared: Pick<PreparedBrowserPreset, 'snapshot' | 'bundles'>;
      installation: BrowserPresetInstallation;
      expected: {
        activeRevision: string | null;
        revisions: Record<string, string>;
        installationToken: string | null;
      };
      confirm: () => Promise<void>;
    }) {
      const installation = structuredClone(input.installation);
      const previous = structuredClone(input.expected);
      const prepared = await verifyPreparedBrowserPreset(
        input.prepared,
        BROWSER_BUNDLE_API_VERSION,
      );
      await applyPrepared(
        prepared,
        previous,
        {
          installation,
          expectedInstallationToken: previous.installationToken,
        },
        input.confirm,
      );
      return installationStatus();
    },
    browserRuntimeBytes: (sha256: string) => store.browserRuntimeBytes(sha256),
    pageRuntimeSource: (sha256: string) => store.pageRuntimeSource(sha256),
    pinPageRuntimes: (patch: Record<string, string | null>) => store.pinPageRuntimes(patch),
    synchronizePageRuntimePins: (pins: Record<string, string>) =>
      store.synchronizePageRuntimePins(pins),
    async applyPreset(input: { source: string; expectedRevision: string | null; expectedId?: string; keepIndependentBrowser?: boolean; skipUnchanged?: boolean; validatePrepared?: (prepared: PreparedBrowserPreset) => Promise<void>; expectedSelection?: { activeRevision: string | null; revisions: Record<string, string>; installationToken: string | null }; confirm?: () => Promise<void> }) {
      const previous = await store.list();
      if (previous.activeRevision !== input.expectedRevision || input.expectedSelection && (previous.activeRevision !== input.expectedSelection.activeRevision || previous.installationToken !== input.expectedSelection.installationToken || Object.keys(previous.revisions).length !== Object.keys(input.expectedSelection.revisions).length || Object.entries(previous.revisions).some(([id, revision]) => input.expectedSelection!.revisions[id] !== revision)))
        throw new BundleError('BUNDLE_CONFLICT', 'The selected preset has changed');
      const prepared = await prepareBrowserPreset(input.source, {
        load,
        mearlApiVersion: BROWSER_BUNDLE_API_VERSION,
      });
      if (input.expectedId !== undefined && prepared.preset.id !== input.expectedId) throw new BundleError('BUNDLE_INVALID', 'The preset identity differs from the selected catalog entry');
      await input.validatePrepared?.(prepared);
      if (input.skipUnchanged && prepared.snapshot.revision === previous.activeRevision) { await input.confirm?.(); return { ...await installationStatus(), revision: previous.activeRevision }; }
      if (input.keepIndependentBrowser && !presetRequiresBrowser(prepared.preset)) { await input.confirm?.(); return { ...browserPresetStatus(prepared.preset, prepared.snapshot.revision, false), browserRequired: false }; }
      if (previous.installationError) throw new BundleError('BUNDLE_INTEGRITY', 'INSTALLATION_NATIVE_SYNC_REQUIRED');
      if (previous.installation && prepared.snapshot.revision !== previous.activeRevision) throw new BundleError('BUNDLE_CONFLICT', 'INSTALLATION_NATIVE_SYNC_REQUIRED');
      return applyPrepared(prepared, previous, { installation: previous.installation, expectedInstallationToken: previous.installationToken }, input.confirm);
    },
    async install(input: {
      id: string;
      source: string;
      expectedRevision: string | null;
      version?: string;
    }) {
      const bundle = await prepareBundle(input.source, {
        load,
        expectedId: input.id,
        version: input.version,
        mearlApiVersion: BROWSER_BUNDLE_API_VERSION,
      });
      const previous = await store.list();
      return installBundle(bundle, previous, input.expectedRevision);
    },
    async installProfile(source: string) {
      const previous = await store.list();
      const bundle = await prepareBundle(await resolveProfileSource(source), {
        load: profileLoad, mearlApiVersion: BROWSER_BUNDLE_API_VERSION, signal: AbortSignal.timeout(30000),
      });
      const { contributions, id } = bundle.manifest;
      if (!contributions?.appProfiles?.length || Object.keys(contributions).some(key => !['appProfiles', 'pageRuntimes'].includes(key))) {
        throw new BundleError('BUNDLE_INVALID', 'Expected an App profile bundle');
      }
      const installed = previous.bundles.find(entry => entry.manifest.id === id);
      const sourceKey = (url: string) => url.replace(/^(https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+)\/[a-f0-9]{40}\/bundle\.json$/, '$1/bundle.json');
      if (installed && sourceKey(installed.source) !== sourceKey(bundle.source)) {
        throw new BundleError('BUNDLE_CONFLICT', 'An installed package already owns this ID at another source');
      }
      return installBundle(bundle, previous, previous.revisions[id] ?? null);
    },
    async remove(id: string, expectedRevision: string) {
      await store.remove(id, expectedRevision);
      notifyRequestUiChanged();
    },
    async get(name: string): Promise<AppProfileCatalogEntry | undefined> {
      if (!name.includes('/')) {
        const selected = await store.profileBinding(name);
        if (!selected) return browserCapabilityCatalog(await store.list()).profiles().profiles.find(profile => profile.id === name);
        const profile = profileEntries(selected.bundle).find(
          profile => profile.id === selected.target,
        );
        if (!profile)
          throw new BundleError('BUNDLE_INVALID', 'The selected app implementation is missing');
        const definition = validateAppProfileDefinition({ ...profile.definition, name });
        return { ...profile, id: name, definition, revision: appProfileRevision(definition) };
      }
      const id = name.split('/')[0];
      const bundle = await store.get(id);
      if (!bundle) return undefined;
      const profile = profileEntries(bundle).find(profile => profile.id === name);
      if (!profile)
        throw new BundleError(
          'BUNDLE_INVALID',
          'The installed browser bundle does not provide this app profile',
        );
      return profile;
    },
    async catalog() {
      return browserCapabilityCatalog(await store.list()).profiles();
    },
  };
}

let registry: ReturnType<typeof createBrowserCapabilityRegistry> | undefined;

export function browserCapabilityRegistry() {
  if (registry) return registry;
  const load = createBundleFetchLoader({
    credentials: 'omit',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        throw new BundleError('BUNDLE_INVALID', 'Browser bundle sources require HTTPS');
      }
      if (
        !(await isAgentDomainAuthorized(url.hostname)) ||
        !(await chrome.permissions.contains({ origins: [`${url.origin}/*`] }))
      ) {
        throw new DomainPermissionError('browserCapabilityBundle', url.hostname);
      }
      return withCookieInjection(url, () => fetch(url.href, init));
    },
  });
  registry = createBrowserCapabilityRegistry(
    new BrowserBundleStore({ mearlApiVersion: BROWSER_BUNDLE_API_VERSION }),
    load,
    createBundleFetchLoader(),
  );
  return registry;
}

export async function getBrowserAppProfileCatalog() {
  try {
    return await browserCapabilityRegistry().catalog();
  } catch (error) {
    return {
      profiles: [] as AppProfileCatalogEntry[],
      bundleIds: [] as string[],
      boundAppIds: [] as string[],
      presetUnavailable: false,
      preset: undefined,
      presetRevision: null,
      errors: [
        {
          plugin: '',
          error: error instanceof Error ? error.message : 'Browser bundle storage unavailable',
        },
      ],
    };
  }
}

export async function getBrowserAppProfile(name: string) {
  try {
    return await browserCapabilityRegistry().get(name);
  } catch (error) {
    if (
      error instanceof Error &&
      [
        'ReferenceError',
        'SecurityError',
        'InvalidStateError',
        'UnknownError',
        'VersionError',
      ].includes(error.name)
    )
      return undefined;
    throw error;
  }
}
