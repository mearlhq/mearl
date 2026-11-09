/**
 * CDP action registry.
 *
 * Each handler sub-module registers its actions here. The registry replaces
 * the giant switch/case in handleViaCdp with a data-driven lookup.
 *
 * Two session levels:
 * - `browser`: handler receives CdpSession for tab and page management
 * - `page`:    handler receives PageSession (for most page-level actions)
 */

import {
  validateRequiredActionTabId,
  type BrowserCommandAction,
  type ControlSource,
} from '@mearl/browser-core';
import type { CdpSession, PageSession } from './cdp-session.js';
import { ensureControlledIndicator } from './controlled-indicator.js';
import { getCdpPageDialogs, pressCdpPageDialog, snapshotCdpPageDialog } from './page-dialogs.js';
import { watchCdpWebMcp } from './webmcp-handlers.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BrowserAction {
  name: BrowserCommandAction;
  session: 'browser';
  handler: (session: CdpSession, data: any, controlSource: ControlSource) => Promise<any>;
}

export interface PageAction {
  name: BrowserCommandAction;
  session: 'page';
  handler: (session: PageSession, data: any, controlSource: ControlSource) => Promise<any>;
}

export type CdpAction = BrowserAction | PageAction;

// ─── Registry ─────────────────────────────────────────────────────────────────

const actionMap = new Map<string, CdpAction>();

/** Register one or more CDP actions. Called by each handler sub-module. */
export function registerActions(actions: CdpAction[]): void {
  for (const action of actions) {
    if (actionMap.has(action.name)) {
      throw new Error(`CDP action "${action.name}" is already registered`);
    }
    actionMap.set(action.name, action);
  }
}

/** Look up a registered action by name. Returns undefined if not found. */
export function getAction(name: string): CdpAction | undefined {
  return actionMap.get(name);
}

/** Get all registered action names (useful for diagnostics). */
export function getRegisteredActionNames(): string[] {
  return [...actionMap.keys()];
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Dispatch an action by name.
 *
 * Resolves the appropriate session level and calls the handler.
 * Throws if the action is unknown or CDP is not available.
 */
export async function dispatchCdpAction(
  cdpSession: CdpSession,
  action: string,
  data: any,
  controlSource: ControlSource = 'local',
): Promise<any> {
  validateRequiredActionTabId(action, data);
  const entry = actionMap.get(action);
  if (!entry) {
    throw new Error(`Action "${action}" is not supported in CDP mode`);
  }

  if (entry.session === 'browser') {
    return entry.handler(cdpSession, data, controlSource);
  }

  // page-level: resolve PageSession from tabId in data
  const tabId: number | undefined = typeof data?.tabId === 'number' ? data.tabId : undefined;
  const pageSession = await cdpSession.getPageSession(tabId);
  if (action === 'page_snapshot') {
    const dialog = snapshotCdpPageDialog(pageSession, data);
    if (dialog) return dialog;
  }
  if (action === 'page_press' && data?.dialogId !== undefined)
    return pressCdpPageDialog(pageSession, data);
  if (action === 'page_press' && data?.promptText !== undefined)
    throw new Error('page_press: promptText requires dialogId.');
  // 任何页面级动作都视为对页面的操控，同步受控标识（favicon 替换）
  const dialogs = getCdpPageDialogs(pageSession);
  return dialogs.execute(async () => {
    await dialogs.command(() => ensureControlledIndicator(pageSession, controlSource));
    if (action === 'page_snapshot' || action === 'page_navigate') {
      const observation = watchCdpWebMcp(pageSession);
      const snapshot = action === 'page_snapshot';
      const full = snapshot && data.includeWebMcp === 'full';
      if (!snapshot) observation.reset();
      const refresh = snapshot ? observation.refreshCatalog(full) : undefined;
      const result = await entry.handler(pageSession, data, controlSource);
      if (full) await refresh;
      if (snapshot) return { ...result, ...observation.fields(result.url, full) };
      void observation.refreshCatalog();
      return { ...result, ...observation.navigationFields(result.url) };
    }
    return entry.handler(pageSession, data, controlSource);
  });
}
