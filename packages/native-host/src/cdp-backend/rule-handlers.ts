/** CDP request-header rules, scoped to the current browser control session. */

import type { AddRuleParams, RulesResult, SetRuleParams } from '@mearl/browser-core';
import { registerActions } from './action-registry.js';
import type { CdpSession, PageSession } from './cdp-session.js';
import {
  registerCdpFetchPauseHandler,
  unregisterCdpFetchPauseHandler,
  type CdpFetchPauseContext,
} from './fetch-interceptor.js';

const RESOURCE_TYPES = new Set(['main_frame', 'sub_frame', 'xmlhttprequest']);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

interface HeaderRule {
  ruleId: number;
  actionType: 'modifyHeaders';
  filter: string;
  regex: RegExp;
  requestHeaders: Array<{ header: string; operation: 'set'; value: string }>;
  resourceTypes: string[];
  priority: number;
  description: string;
  enabled: true;
}

interface RuleState {
  active: boolean;
  rules: HeaderRule[];
  nextRuleId: number;
  mainFrameIds: WeakMap<PageSession, string>;
  attachedPages: WeakSet<PageSession>;
  frameListeners: Map<PageSession, () => void>;
  disposeInitializer?: () => void;
  disposeTargetListener?: () => void;
  disposeDestroyedListener?: () => void;
  disposeConnectionListener?: () => void;
  setupPromise?: Promise<void>;
}

const stores = new WeakMap<CdpSession, RuleState>();

function validateRule(data: AddRuleParams): Omit<HeaderRule, 'ruleId' | 'enabled'> {
  if (data?.actionType !== 'modifyHeaders') {
    throw new Error('CDP set_rule supports modifyHeaders request headers only');
  }
  if (typeof data.filter !== 'string' || !data.filter.trim() || data.filter.length > 2048) {
    throw new Error('CDP set_rule requires a non-empty regex filter (max 2048 characters)');
  }
  let regex: RegExp;
  try {
    regex = new RegExp(data.filter);
  } catch {
    throw new Error('CDP set_rule filter is not a valid regex');
  }
  if (data.responseHeaders?.length || data.initiatorDomains) {
    throw new Error('CDP set_rule does not support responseHeaders or initiatorDomains');
  }
  if (!Array.isArray(data.requestHeaders) || data.requestHeaders.length === 0) {
    throw new Error('CDP set_rule requires requestHeaders');
  }
  const requestHeaders = data.requestHeaders.map(header => {
    if (
      !header ||
      typeof header.header !== 'string' ||
      !HEADER_NAME.test(header.header) ||
      header.operation !== 'set' ||
      typeof header.value !== 'string' ||
      /[\r\n\0]/.test(header.value)
    ) {
      throw new Error(
        'CDP set_rule supports request header set operations with valid names and values',
      );
    }
    return { header: header.header, operation: 'set' as const, value: header.value };
  });
  const resourceTypes = data.resourceTypes ?? ['main_frame', 'sub_frame', 'xmlhttprequest'];
  if (
    !Array.isArray(resourceTypes) ||
    resourceTypes.length === 0 ||
    resourceTypes.some(type => !RESOURCE_TYPES.has(type))
  ) {
    throw new Error(
      'CDP set_rule supports main_frame, sub_frame, and xmlhttprequest resource types',
    );
  }
  const priority = data.priority ?? 1;
  if (!Number.isInteger(priority) || priority < 1) {
    throw new Error('CDP set_rule priority must be a positive integer');
  }
  return {
    actionType: 'modifyHeaders',
    filter: data.filter,
    regex,
    requestHeaders,
    resourceTypes: [...resourceTypes],
    priority,
    description: data.description ?? 'Rule added via MCP/Skill',
  };
}

function matchesResourceType(
  rule: HeaderRule,
  session: PageSession,
  params: any,
  state: RuleState,
): boolean {
  const type = params.resourceType;
  if (type === 'XHR' || type === 'Fetch') return rule.resourceTypes.includes('xmlhttprequest');
  if (type !== 'Document') return false;
  const mainFrameId = state.mainFrameIds.get(session);
  const requestType =
    mainFrameId && params.frameId
      ? params.frameId === mainFrameId
        ? 'main_frame'
        : 'sub_frame'
      : undefined;
  return requestType
    ? rule.resourceTypes.includes(requestType)
    : rule.resourceTypes.includes('main_frame') && rule.resourceTypes.includes('sub_frame');
}

function headerHandler(
  state: RuleState,
  context: CdpFetchPauseContext,
): Promise<boolean> | boolean {
  const { session, params, isResponseStage } = context;
  if (!state.active || isResponseStage || !params.request?.url) return false;
  const matched = state.rules
    .filter(
      rule =>
        rule.regex.test(params.request.url) && matchesResourceType(rule, session, params, state),
    )
    .sort((a, b) => a.priority - b.priority || a.ruleId - b.ruleId);
  if (!matched.length) return false;

  const headers = new Map<string, { name: string; value: string }>();
  for (const [name, value] of Object.entries(params.request.headers ?? {})) {
    headers.set(name.toLowerCase(), { name, value: String(value) });
  }
  for (const rule of matched) {
    for (const header of rule.requestHeaders) {
      headers.set(header.header.toLowerCase(), { name: header.header, value: header.value });
    }
  }
  return session.client
    .sendCommand('Fetch.continueRequest', {
      requestId: params.requestId,
      headers: [...headers.values()],
    })
    .then(() => true);
}

async function attachRuleHandler(page: PageSession, state: RuleState): Promise<void> {
  if (!state.active || state.attachedPages.has(page)) return;
  state.attachedPages.add(page);
  try {
    const frameTree = await page.client.sendCommand('Page.getFrameTree', {});
    const frameId = frameTree.frameTree?.frame?.id;
    if (typeof frameId === 'string') state.mainFrameIds.set(page, frameId);
  } catch {
    // A rule covering both document resource types can still match without a frame tree.
  }
  if (!state.active) return;
  const dispose = page.client.on('Page.frameNavigated', (params: any) => {
    if (!params.frame?.parentId && typeof params.frame?.id === 'string') {
      state.mainFrameIds.set(page, params.frame.id);
    }
  });
  state.frameListeners.set(page, dispose);
  try {
    await registerCdpFetchPauseHandler(page, 'request-header-rules', 75, context =>
      headerHandler(state, context),
    );
    if (!state.active) await unregisterCdpFetchPauseHandler(page, 'request-header-rules');
  } catch (error) {
    state.attachedPages.delete(page);
    state.frameListeners.delete(page);
    dispose();
    throw error;
  }
}

async function initializeRuleState(session: CdpSession, state: RuleState): Promise<void> {
  state.disposeInitializer = session.addPageSessionInitializer(page =>
    attachRuleHandler(page, state),
  );
  const browser = await session.getBrowserClient();
  state.disposeConnectionListener = session.onBrowserConnected(() => clearCdpRuleState(session));
  state.disposeTargetListener = browser.on('Target.targetCreated', (params: any) => {
    const target = params.targetInfo;
    if (
      !state.active ||
      target?.type !== 'page' ||
      /^(?:chrome:|chrome-extension:)/.test(target.url ?? '')
    )
      return;
    void session
      .ensureTargetRegistered(target.targetId)
      .then(tabId => (state.active ? session.getPageSession(tabId) : undefined))
      .catch(() => {});
  });
  state.disposeDestroyedListener = browser.on('Target.targetDestroyed', (params: any) => {
    for (const [page, dispose] of state.frameListeners) {
      if (page.targetId !== params.targetId) continue;
      dispose();
      state.frameListeners.delete(page);
      state.attachedPages.delete(page);
    }
  });
  await browser.sendCommand('Target.setDiscoverTargets', { discover: true });
  // Discovery handles future tabs; enumeration arms current tabs before set_rule succeeds.
  await session.attachOpenPageTargets();
  for (const page of session.listOpenPageSessions()) {
    await attachRuleHandler(page, state);
  }
}

export async function cdpSetRule(session: CdpSession, data: SetRuleParams) {
  if (data?.enabled === false) {
    const { ruleId } = data;
    if (!Number.isSafeInteger(ruleId) || ruleId < 1) {
      throw new Error('CDP set_rule requires a positive integer ruleId when enabled is false');
    }
    await session.getBrowserClient();
    const state = stores.get(session);
    const index = state?.rules.findIndex(rule => rule.ruleId === ruleId) ?? -1;
    if (!state || index < 0) {
      return { success: true, ruleId, affectedCount: 0, message: `Rule #${ruleId} not found.` };
    }
    state.rules.splice(index, 1);
    if (state.rules.length === 0) {
      clearCdpRuleState(session);
      await Promise.all(
        session
          .listOpenPageSessions()
          .map(page => unregisterCdpFetchPauseHandler(page, 'request-header-rules')),
      );
    }
    return { success: true, ruleId, affectedCount: 1, message: `Rule #${ruleId} removed.` };
  }

  const validated = validateRule(data);
  await session.getBrowserClient();
  let state = stores.get(session);
  if (!state) {
    state = {
      active: true,
      rules: [],
      nextRuleId: 1,
      mainFrameIds: new WeakMap(),
      attachedPages: new WeakSet(),
      frameListeners: new Map(),
    };
    stores.set(session, state);
  }
  const rule: HeaderRule = { ...validated, ruleId: state.nextRuleId++, enabled: true };
  state.rules.push(rule);
  if (!state.setupPromise) state.setupPromise = initializeRuleState(session, state);
  try {
    await state.setupPromise;
    if (!state.active || stores.get(session) !== state) {
      throw new Error('CDP browser connection changed while installing the rule; retry');
    }
  } catch (error) {
    const index = state.rules.indexOf(rule);
    if (index >= 0) state.rules.splice(index, 1);
    if (state.rules.length === 0 && stores.get(session) === state) {
      clearCdpRuleState(session);
      await Promise.all(
        session
          .listOpenPageSessions()
          .map(page => unregisterCdpFetchPauseHandler(page, 'request-header-rules')),
      );
    }
    throw error;
  }
  return {
    success: true,
    ruleId: rule.ruleId,
    affectedCount: 1,
    message: `Rule #${rule.ruleId} added for the current CDP browser session.`,
  };
}

export async function cdpGetRules(session: CdpSession): Promise<RulesResult> {
  await session.getBrowserClient();
  const state = stores.get(session);
  return {
    enabled: true,
    rules: (state?.rules ?? []).map(({ regex: _regex, ...rule }) => ({ ...rule })),
  };
}

export function clearCdpRuleState(session: CdpSession): void {
  const state = stores.get(session);
  if (!state) return;
  state.active = false;
  state.disposeInitializer?.();
  state.disposeTargetListener?.();
  state.disposeDestroyedListener?.();
  state.disposeConnectionListener?.();
  for (const dispose of state.frameListeners.values()) dispose();
  state.frameListeners.clear();
  stores.delete(session);
}

registerActions([
  { name: 'set_rule', session: 'browser', handler: cdpSetRule },
  { name: 'get_rules', session: 'browser', handler: cdpGetRules },
]);
