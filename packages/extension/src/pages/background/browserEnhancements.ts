import {
  BROWSER_ENHANCEMENT_PROTOCOL_VERSION,
  BROWSER_ENHANCEMENT_NAVIGATION_ORIGIN_VERSION,
  BROWSER_ENHANCEMENT_PREPARATION_VERSION, BROWSER_ENHANCEMENT_PREPARATION_PATH,
  BROWSER_ENHANCEMENT_HOST_ENVIRONMENT_VERSION,
  type BrowserEnhancementBinding,
  type BrowserEnhancementCapabilities,
  type BrowserEnhancementRequest,
  type BrowserEnhancementResponse,
  isProviderInitialEnvironment, isDeviceEnvironmentObservation, isEnhancementNavigationOrigin,
  type BrowserEnhancementAction,
  requiredBrowserEnhancementActions,
} from '@mearl/browser-core';
import {
  applyEnvironmentChange, restoreEnvironmentChange,
  type EnvironmentChange, type EnvironmentChangeHost,
} from '@mearl/app-profiles';
import { acquireDebuggerLease, type DebuggerLease } from './debuggerSessionManager';
import { getTabState, hydrateRecordedTimezoneSettings, restoreRecordedTimezoneOwnership } from './debuggerManager';
import { getTabPageOverrides } from './tabPageOverrides';
import { getEnvironmentRevision } from './environmentRevisions';
import { handleSetTimezone } from './agentHandlers/timezoneHandlers';
import { handlePageFrames } from './agentHandlers/snapshotHandlers';
import { isQuickSimulationUpdatePending, runSerializedQuickSimulationUpdate } from './quickSimulationUpdateQueue';
import { appDeviceEnvironmentHost, appDeviceEnvironmentFingerprint, invokeAppDeviceEnvironment, type EnhancementEnvironmentState } from './browserEnhancementEnvironments';
import { getEnhancementTabUrl } from './browserEnhancementTarget';

interface TimezoneState { agent: string | null; observed: string }
interface BindingRecord extends BrowserEnhancementBinding, EnhancementEnvironmentState {
  owner: string;
  epoch: string;
  timezone?: EnvironmentChange<TimezoneState>;
  navigationOrigin?: string;
}

const epoch = crypto.randomUUID();
const bindings = new Map<string, BindingRecord>();
const bindingLeases = new Map<number, Promise<DebuggerLease>>();
const storageKey = (tabId: number) => `browserEnhancement:${tabId}`;
const capabilities: BrowserEnhancementCapabilities = {
  protocolVersion: BROWSER_ENHANCEMENT_PROTOCOL_VERSION,
  actions: ['set_timezone', 'set_device_emulation', 'set_app_profile'],
  navigationOriginVersion: BROWSER_ENHANCEMENT_NAVIGATION_ORIGIN_VERSION,
  preparationVersion: BROWSER_ENHANCEMENT_PREPARATION_VERSION,
  hostEnvironmentVersion: BROWSER_ENHANCEMENT_HOST_ENVIRONMENT_VERSION,
};

async function retainBindingLease(tabId: number): Promise<void> {
  if (!bindingLeases.has(tabId)) {
    const pending = acquireDebuggerLease(tabId, { consumer: 'browser-enhancement' });
    bindingLeases.set(tabId, pending);
    void pending.catch(() => { if (bindingLeases.get(tabId) === pending) bindingLeases.delete(tabId); });
  }
  await bindingLeases.get(tabId);
}

function canonicalTimezone(timezone?: string | null): string {
  return new Intl.DateTimeFormat('en', timezone ? { timeZone: timezone } : {}).resolvedOptions().timeZone;
}

function view(record: BindingRecord): BrowserEnhancementBinding {
  const { bindingId, generation, tabId, mainFrameId, targetId, actions } = record;
  return { bindingId, generation, tabId, mainFrameId, ...(targetId ? { targetId } : {}), actions: [...actions] };
}

async function targetId(tabId: number): Promise<string> {
  const targets = await chrome.debugger.getTargets();
  const matches = targets.filter(target => target.tabId === tabId && target.type === 'page');
  if (matches.length !== 1 || !matches[0]?.id) throw new Error('PAGE_IDENTITY_UNAVAILABLE');
  return matches[0].id;
}

async function mainFrameId(tabId: number): Promise<string> {
  const result = await handlePageFrames({ tabId }, () => null);
  const main = result.frames.find(frame => frame.isMainFrame);
  if (!main?.frameId) throw new Error('PAGE_IDENTITY_UNAVAILABLE');
  return main.frameId;
}

async function readTimezone(tabId: number, observe?: (timezone: string, revision: number) => void) {
  const settings = await getTabPageOverrides(tabId);
  hydrateRecordedTimezoneSettings(tabId, settings.customTimezone || undefined);
  const revision = await getEnvironmentRevision(tabId, 'timezone');
  const lease = await acquireDebuggerLease(tabId, { consumer: 'environment-observation', domains: ['Page', 'Runtime'] });
  try {
    const frame = await mainFrameId(tabId);
    const world = await chrome.debugger.sendCommand({ tabId }, 'Page.createIsolatedWorld', {
      frameId: frame, worldName: '__mearl_environment_observation__',
    }) as { executionContextId?: number };
    if (!Number.isSafeInteger(world.executionContextId)) throw new Error('ENVIRONMENT_OBSERVATION_UNAVAILABLE');
    const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: 'Intl.DateTimeFormat().resolvedOptions().timeZone', contextId: world.executionContextId, returnByValue: true,
    }) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (result.exceptionDetails || typeof result.result?.value !== 'string')
      throw new Error('ENVIRONMENT_OBSERVATION_UNAVAILABLE');
    observe?.(result.result.value, revision);
    const value = { agent: getTabState(tabId)?.timezoneOverrides.agent ?? null, observed: result.result.value };
    return { revision, value, fingerprint: JSON.stringify(value) };
  } finally { await lease.release(); }
}

function timezoneHost(record: BindingRecord): EnvironmentChangeHost<TimezoneState> {
  return {
    read: async () => {
      const snapshot = await readTimezone(record.tabId);
      if (!record.timezone) {
        const known = snapshot.value.agent ?? getTabState(record.tabId)?.timezoneOverrides.settings;
        if (snapshot.value.observed !== canonicalTimezone(known))
          throw new Error('ENVIRONMENT_BASELINE_UNSUPPORTED: an external timezone override cannot be restored safely');
      }
      return snapshot;
    },
    save: async change => {
      const next = { ...record, timezone: structuredClone(change) };
      await chrome.storage.session.set({ [storageKey(record.tabId)]: next });
      record.timezone = next.timezone;
    },
    restore: async baseline => {
      await handleSetTimezone({ tabId: record.tabId, timezone: baseline.agent ?? '' }, () => null);
    },
    matchesRestored: (baseline, current) => {
      const expected = baseline.value.agent
        ? baseline.value.observed
        : canonicalTimezone(getTabState(record.tabId)?.timezoneOverrides.settings);
      return current.value.agent === baseline.value.agent && current.value.observed === expected;
    },
  };
}

function validSnapshot(value: any): boolean {
  return value && Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    value.value && (value.value.agent === null || typeof value.value.agent === 'string') &&
    typeof value.value.observed === 'string' && value.fingerprint === JSON.stringify(value.value);
}

function validStoredBinding(value: any, tabId: number): value is BindingRecord {
  const validChange = (change: any, component: 'device' | 'app') => !change || (
    change.owner === value.bindingId && change.component === component &&
    ['pending', 'active', 'restoring', 'conflict', 'restored'].includes(change.phase) &&
    [change.baseline, ...(change.applied ? [change.applied] : [])].every(snapshot => {
      if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || typeof snapshot.fingerprint !== 'string') return false;
      try { return appDeviceEnvironmentFingerprint(JSON.parse(snapshot.fingerprint)) === appDeviceEnvironmentFingerprint(snapshot.value); }
      catch { return false; }
    })
  );
  return value && value.tabId === tabId && typeof value.bindingId === 'string' && Boolean(value.bindingId) &&
    typeof value.owner === 'string' && Boolean(value.owner) &&
    typeof value.mainFrameId === 'string' && typeof value.epoch === 'string' &&
    (value.targetId === undefined || (typeof value.targetId === 'string' && Boolean(value.targetId) && value.targetId.length <= 256)) &&
    Number.isSafeInteger(value.generation) && value.generation >= 1 && value.generation < Number.MAX_SAFE_INTEGER &&
    Array.isArray(value.actions) && value.actions.every((action: any) => capabilities.actions.includes(action)) &&
    (value.initialEnvironment === undefined || isProviderInitialEnvironment(value.initialEnvironment)) &&
    (value.appDeviceObservation === undefined || isDeviceEnvironmentObservation(value.appDeviceObservation)) &&
    (value.navigationOrigin === undefined || isEnhancementNavigationOrigin(value.navigationOrigin)) &&
    validChange(value.device, 'device') && validChange(value.app, 'app') &&
    ((!value.device && !value.app) || Boolean(value.initialEnvironment)) &&
    (!value.timezone || (value.timezone.owner === value.bindingId && value.timezone.component === 'timezone' &&
      ['pending', 'active', 'restoring', 'conflict', 'restored'].includes(value.timezone.phase) &&
      validSnapshot(value.timezone.baseline) && (!value.timezone.applied || validSnapshot(value.timezone.applied))));
}

async function storedBinding(tabId: number): Promise<BindingRecord | undefined> {
  const key = storageKey(tabId);
  const value = (await chrome.storage.session.get(key))[key];
  if (value === undefined) return undefined;
  if (!validStoredBinding(value, tabId)) throw new Error('ENVIRONMENT_BINDING_RECOVERY_REQUIRED: invalid persisted binding');
  if (JSON.stringify(value).length > 512 * 1024) throw new Error('ENVIRONMENT_BINDING_RECOVERY_REQUIRED: oversized persisted binding');
  if (value.timezone && value.timezone.phase !== 'restored') await retainBindingLease(tabId);
  return value;
}

async function recoverBinding(stored: BindingRecord): Promise<BindingRecord> {
  if (stored.device || stored.app) throw new Error('ENVIRONMENT_BINDING_RECOVERY_REQUIRED: App/device resources must be reverified before replacing their owning worker');
  const change = stored.timezone;
  let alreadyRestored = false;
  if (change && change.phase !== 'restored') {
    if (change.phase !== 'active' || !change.applied?.value.agent)
      throw new Error('ENVIRONMENT_BINDING_RECOVERY_REQUIRED: the previous effect is unconfirmed; explicitly reset Mearl environments to discard it');
    await readTimezone(stored.tabId, (observed, revision) => {
      if (revision !== change.applied!.revision)
        throw new Error('ENVIRONMENT_BINDING_RECOVERY_REQUIRED: the observed environment changed');
      if (observed === change.applied!.value.observed) {
        restoreRecordedTimezoneOwnership(stored.tabId, change.applied!.value.agent!);
      } else if (observed === change.baseline.value.observed && !getTabState(stored.tabId)?.timezoneOverrides.agent) {
        if (change.baseline.value.agent) restoreRecordedTimezoneOwnership(stored.tabId, change.baseline.value.agent);
        alreadyRestored = true;
      } else {
        throw new Error('ENVIRONMENT_BINDING_RECOVERY_REQUIRED: the observed environment changed');
      }
    });
  }
  const recovered = { ...stored, epoch, generation: stored.generation + 1,
    ...(alreadyRestored || change?.phase === 'restored' ? { timezone: undefined } : {}) };
  await retainBindingLease(stored.tabId);
  await chrome.storage.session.set({ [storageKey(stored.tabId)]: recovered });
  bindings.set(recovered.bindingId, recovered);
  return recovered;
}

/** Called only after a confirmed page removal or an explicit, completed Mearl environment reset. */
export async function cleanupBrowserEnhancements(tabId: number, options: { closed?: boolean } = {}): Promise<void> {
  const storage = chrome.storage?.session;
  if (!storage) return;
  const key = storageKey(tabId);
  if (!bindingLeases.has(tabId) && !(await storage.get(key) ?? {})[key]) return;
  const lease = bindingLeases.get(tabId);
  if (lease) {
    try { await (await lease).release(); } catch (error) { if (!options.closed) throw error; }
  }
  await storage.remove(key);
  bindingLeases.delete(tabId);
  for (const [id, binding] of bindings) if (binding.tabId === tabId) bindings.delete(id);
}

function validateRequest(value: BrowserEnhancementRequest): void {
  if (!value || typeof value !== 'object' || !['inspect', 'probe', 'bind', 'invoke', 'release'].includes(value.operation))
    throw new Error('Invalid browser enhancement request');
  if (value.operation === 'inspect' || value.operation === 'probe' || value.operation === 'bind') {
    if (!Number.isSafeInteger(value.tabId) || value.tabId < 0) throw new Error('A valid tabId is required');
  }
  if (value.operation !== 'probe' && (typeof value.owner !== 'string' || !value.owner || value.owner.length > 512))
    throw new Error('An accepted enhancement owner is required');
  if (value.operation === 'inspect' || value.operation === 'bind') {
    if (value.navigationOrigin !== undefined && !isEnhancementNavigationOrigin(value.navigationOrigin)) throw new Error('Invalid enhancement navigation origin');
    if (value.operation === 'inspect' && (value.navigationOrigin === undefined || typeof value.targetId !== 'string' || !value.targetId || value.targetId.length > 256))
      throw new Error('Inspection requires a physical target and navigation origin');
    if (!Array.isArray(value.actions) || !value.actions.length || new Set(value.actions).size !== value.actions.length ||
      value.actions.some(action => !capabilities.actions.includes(action))) throw new Error('BROWSER_ENHANCEMENT_UNSUPPORTED');
  }
  if (value.operation === 'bind') {
    if (value.initialEnvironment !== undefined && !isProviderInitialEnvironment(value.initialEnvironment)) throw new Error('Invalid enhancement initial environment');
    if (typeof value.mainFrameId !== 'string' || !value.mainFrameId || value.mainFrameId.length > 256)
      throw new Error('A verified main frame ID is required');
    if (value.targetId !== undefined && (typeof value.targetId !== 'string' || !value.targetId || value.targetId.length > 256))
      throw new Error('A verified target ID is required');
  }
  if (value.operation === 'invoke' || value.operation === 'release') {
    if (typeof value.bindingId !== 'string' || !value.bindingId || !Number.isSafeInteger(value.generation) || value.generation < 1)
      throw new Error('A valid enhancement binding and generation are required');
  }
}

function assertDeadline(request: BrowserEnhancementRequest): void {
  if (request.deadline !== undefined && (!Number.isSafeInteger(request.deadline) || Date.now() >= request.deadline))
    throw new Error('Browser enhancement deadline exceeded');
}

function assertPageIdle(tabId: number): void {
  if (isQuickSimulationUpdatePending(tabId)) throw new Error('BROWSER_ENHANCEMENT_BUSY');
}

/** Only AgentBridge's trusted native-host branch can call this internal entry. */
export async function handleBrowserEnhancement(
  request: BrowserEnhancementRequest,
  authorize: (tabId: number, action: BrowserEnhancementAction, navigationOrigin?: string) => Promise<void>,
): Promise<BrowserEnhancementResponse> {
  validateRequest(request);
  assertDeadline(request);
  if (request.operation === 'inspect') {
    if (await targetId(request.tabId) !== request.targetId) throw new Error('PAGE_IDENTITY_CHANGED');
    for (const action of request.actions) await authorize(request.tabId, action, request.navigationOrigin);
    assertDeadline(request);
    if (await targetId(request.tabId) !== request.targetId) throw new Error('PAGE_IDENTITY_CHANGED');
    return { preparation: { tabId: request.tabId, targetId: request.targetId,
      url: chrome.runtime.getURL(BROWSER_ENHANCEMENT_PREPARATION_PATH), capabilities: { ...capabilities, actions: [...capabilities.actions] } } };
  }
  if (request.operation === 'probe') {
    await authorize(request.tabId, 'set_timezone');
    await storedBinding(request.tabId);
    return { capabilities: { ...capabilities, actions: [...capabilities.actions] }, tabId: request.tabId,
      mainFrameId: await mainFrameId(request.tabId), targetId: await targetId(request.tabId) };
  }
  if (request.operation === 'bind') {
    assertPageIdle(request.tabId);
    return runSerializedQuickSimulationUpdate(request.tabId, async () => {
      assertDeadline(request);
      for (const action of request.actions) await authorize(request.tabId, action, request.navigationOrigin);
      if (await mainFrameId(request.tabId) !== request.mainFrameId) throw new Error('PAGE_IDENTITY_CHANGED');
      if (request.targetId !== undefined && await targetId(request.tabId) !== request.targetId) throw new Error('PAGE_IDENTITY_CHANGED');
      const key = storageKey(request.tabId);
      const stored = await storedBinding(request.tabId);
      if (stored) {
        if (Boolean(stored.initialEnvironment?.preserveHostPlatform) !== Boolean(request.initialEnvironment?.preserveHostPlatform) ||
          Boolean(stored.initialEnvironment?.preserveHostInput) !== Boolean(request.initialEnvironment?.preserveHostInput))
          throw new Error('ENVIRONMENT_BINDING_RECOVERY_REQUIRED: release the previous host environment policy before rebinding');
        if (stored.owner !== request.owner || stored.mainFrameId !== request.mainFrameId ||
          (stored.targetId !== undefined && stored.targetId !== request.targetId) ||
          (stored.navigationOrigin !== undefined && request.navigationOrigin !== undefined && stored.navigationOrigin !== request.navigationOrigin))
          throw new Error('ENVIRONMENT_OWNER_CONFLICT');
        const current = bindings.get(stored.bindingId) ?? await recoverBinding(stored);
        if ((current.targetId === undefined && request.targetId !== undefined) || request.actions.some(action => !current.actions.includes(action)) ||
          (current.navigationOrigin === undefined && request.navigationOrigin !== undefined)) {
          if (current.generation >= Number.MAX_SAFE_INTEGER) throw new Error('ENVIRONMENT_BINDING_RECOVERY_REQUIRED: generation exhausted');
          const upgraded: BindingRecord = { ...current, targetId: request.targetId ?? current.targetId, generation: current.generation + 1,
            actions: [...new Set([...current.actions, ...request.actions])],
            initialEnvironment: current.initialEnvironment ?? request.initialEnvironment,
            navigationOrigin: current.navigationOrigin ?? request.navigationOrigin,
          };
          if (upgraded.actions.some(action => action !== 'set_timezone')) await appDeviceEnvironmentHost(upgraded, async () => {}).read();
          await chrome.storage.session.set({ [key]: upgraded });
          bindings.set(upgraded.bindingId, upgraded);
          return { binding: view(upgraded) };
        }
        if (current.actions.some(action => action !== 'set_timezone')) await appDeviceEnvironmentHost(current, async () => {}).read();
        return { binding: view(current) };
      }
      if (bindings.size >= 128) throw new Error('Browser enhancement binding limit reached');
      const record: BindingRecord = {
        bindingId: crypto.randomUUID(), generation: 1, epoch, owner: request.owner,
        tabId: request.tabId, mainFrameId: request.mainFrameId, actions: [...request.actions],
        ...(request.targetId ? { targetId: request.targetId } : {}),
        ...(request.initialEnvironment ? { initialEnvironment: structuredClone(request.initialEnvironment) } : {}),
        ...(request.navigationOrigin ? { navigationOrigin: request.navigationOrigin } : {}),
      };
      await retainBindingLease(request.tabId);
      try {
        if (record.actions.some(action => action !== 'set_timezone')) await appDeviceEnvironmentHost(record, async () => {}).read();
        await chrome.storage.session.set({ [key]: record });
      } catch (error) {
        const lease = bindingLeases.get(request.tabId);
        bindingLeases.delete(request.tabId);
        if (lease) await (await lease).release();
        throw error;
      }
      bindings.set(record.bindingId, record);
      return { binding: view(record) };
    });
  }

  const record = bindings.get(request.bindingId);
  if (!record || record.owner !== request.owner || record.generation !== request.generation)
    throw new Error('ENVIRONMENT_BINDING_NOT_FOUND');
  assertPageIdle(record.tabId);
  return runSerializedQuickSimulationUpdate(record.tabId, async () => {
    assertDeadline(request);
    if (bindings.get(record.bindingId) !== record) throw new Error('ENVIRONMENT_BINDING_NOT_FOUND');
    if (request.operation === 'invoke' && request.action !== 'set_timezone' && request.data?.enabled === true && !record.navigationOrigin) {
      const url = await getEnhancementTabUrl(record.tabId);
      if (!/^https?:\/\//.test(url)) throw new Error('BROWSER_ENHANCEMENT_NAVIGATION_ORIGIN_REQUIRED: authorize the first business origin before preparing this page');
    }
    const requestedActions = request.operation === 'invoke' ? requiredBrowserEnhancementActions(request) : record.actions;
    if (requestedActions.some(action => !record.actions.includes(action))) throw new Error('BROWSER_ENHANCEMENT_SCOPE_MISMATCH');
    for (const action of requestedActions) await authorize(record.tabId, action, record.navigationOrigin);
    if (await mainFrameId(record.tabId) !== record.mainFrameId) throw new Error('PAGE_IDENTITY_CHANGED');
    if (record.targetId !== undefined && await targetId(record.tabId) !== record.targetId) throw new Error('PAGE_IDENTITY_CHANGED');
    if (request.operation === 'invoke') {
      if (!record.actions.includes(request.action))
        throw new Error('BROWSER_ENHANCEMENT_UNSUPPORTED');
      if (!request.data || typeof request.data !== 'object' || Array.isArray(request.data) ||
        (request.data.tabId !== undefined && request.data.tabId !== record.tabId))
        throw new Error('Enhancement payload cannot change its bound page');
      const saveEnvironment = async (fields: EnhancementEnvironmentState) => {
        const next = { ...record, ...fields };
        if (JSON.stringify(next).length > 512 * 1024) throw new Error('Enhancement environment exceeds its record limit');
        await chrome.storage.session.set({ [storageKey(record.tabId)]: next });
        Object.assign(record, fields);
      };
      if (request.action !== 'set_timezone') return { result: await invokeAppDeviceEnvironment(record, request, saveEnvironment, () => assertDeadline(request)) };
      const result = await applyEnvironmentChange(record.bindingId, 'timezone', record.timezone, timezoneHost(record), () => {
        assertDeadline(request);
        return handleSetTimezone({ ...request.data, tabId: record.tabId }, () => null);
      });
      return { result };
    }
    if (record.timezone) {
      const host = timezoneHost(record);
      const restore = host.restore;
      host.restore = value => { assertDeadline(request); return restore(value); };
      const result = await restoreEnvironmentChange(record.bindingId, record.timezone, host);
      if (!result.restored) return { released: false, conflicts: [`timezone:${result.reason}`] };
    }
    for (const component of ['app', 'device'] as const) if (record[component]) {
      try {
        await invokeAppDeviceEnvironment(record, { action: component === 'app' ? 'set_app_profile' : 'set_device_emulation',
          data: { tabId: record.tabId, enabled: false } }, async fields => {
          const next = { ...record, ...fields };
          await chrome.storage.session.set({ [storageKey(record.tabId)]: next }); Object.assign(record, fields);
        }, () => assertDeadline(request));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith('ENVIRONMENT_STATE_CONFLICT:')) return { released: false, conflicts: [`${component}:changed`] };
        if (message.startsWith('ENVIRONMENT_UNCONFIRMED')) return { released: false, conflicts: [`${component}:unconfirmed`] };
        throw error;
      }
    }
    await cleanupBrowserEnhancements(record.tabId);
    return { released: true };
  });
}
