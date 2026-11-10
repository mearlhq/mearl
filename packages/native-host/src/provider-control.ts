import {
  describeBrowserCapabilities,
  findMatchingTabs,
  parseExternalBrowserControl,
  type ControlSessionInfo,
} from '@mearl/browser-core';
import { ControlSessionManager } from './control-session-manager.js';
import type { BrowserRecord } from './browser-registry.js';
import { assertProviderProtocolVersion, type ProviderHostContextData } from '@mearl/provider';
import { isAbsolute } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { providerRequestTimeoutMs } from './provider-request-timeout.js';

interface Dependencies {
  browsers: () => BrowserRecord[];
  request: (
    browser: BrowserRecord,
    action: string,
    data: any,
    origin: string,
    host?: ProviderHostContextData,
    deadline?: number,
  ) => Promise<any>;
  notify: () => void;
}

interface BrowserControl {
  identity: string;
  manager: ControlSessionManager;
}

function identity(browser: BrowserRecord): string {
  return `${browser.pid}:${browser.startedAt}:${browser.socketPath}:${browser.capabilities?.controlSessionMode ?? 'mearl'}`;
}

/** Mearl sessions are the default; externally controlled Providers keep their own lifecycle. */
export class ProviderControlService {
  private readonly deadlines = new AsyncLocalStorage<number | undefined>();
  private readonly controls = new Map<string, BrowserControl>();
  private readonly retired = new Set<Promise<void>>();

  constructor(private readonly dependencies: Dependencies) {}

  private retire(manager: ControlSessionManager) {
    const cleanup = Promise.all(
      manager.registry.list().map(session => manager.registry.waitForIdle(session.sessionId)),
    ).then(() => manager.artifacts.dispose());
    this.retired.add(cleanup);
    void cleanup.finally(() => this.retired.delete(cleanup)).catch(() => {});
  }

  private reap() {
    const browsers = this.dependencies.browsers();
    for (const [browserId, control] of this.controls) {
      const browser = browsers.find(item => item.browserId === browserId);
      if (!browser || identity(browser) !== control.identity) {
        this.controls.delete(browserId);
        this.retire(control.manager);
      }
    }
  }

  private browser(browserId: string): BrowserRecord {
    const browser = this.dependencies.browsers().find(item => item.browserId === browserId);
    if (browser?.transport !== 'provider' || !browser.providerBrowserId)
      throw new Error('CONTROL_SESSION_NOT_FOUND: Provider browser is unavailable');
    assertProviderProtocolVersion(
      browser.provider?.protocolVersion,
      browser.provider?.id ?? 'Provider',
    );
    const mode = browser.capabilities?.controlSessionMode;
    if (mode !== undefined && mode !== 'mearl' && mode !== 'external')
      throw new Error('Provider browser has invalid control session mode');
    return browser;
  }

  list(): ControlSessionInfo[] {
    this.reap();
    return [...this.controls.values()].flatMap(control => control.manager.registry.list());
  }

  find(sessionId: string): ControlSessionInfo | undefined {
    this.reap();
    const sessions = [...this.controls.values()]
      .map(control => control.manager.registry.find(sessionId))
      .filter((session): session is ControlSessionInfo => session !== undefined);
    if (sessions.length > 1)
      throw new Error('CONTROL_SESSION_AMBIGUOUS: multiple browsers own this id');
    return sessions[0];
  }

  async userControl(sessionId: string, operation: 'handoff' | 'resume' | 'release') {
    this.reap();
    for (const [browserId, control] of this.controls) {
      try {
        control.manager.registry.info(sessionId);
      } catch {
        continue;
      }
      if (identity(this.browser(browserId)) !== control.identity)
        throw new Error('CONTROL_SESSION_NOT_FOUND');
      return control.manager.userControl(sessionId, operation);
    }
    throw new Error('CONTROL_SESSION_NOT_FOUND');
  }

  private getControl(browser: BrowserRecord): BrowserControl {
    const previous = this.controls.get(browser.browserId);
    if (previous?.identity === identity(browser)) return previous;
    if (previous) this.retire(previous.manager);
    const control: BrowserControl = {
      identity: identity(browser),
      manager: new ControlSessionManager({
        browserId: () => browser.browserId,
        transport: () => 'provider',
        invoke: async (action, payload) => {
          const current = this.browser(browser.browserId);
          if (identity(current) !== control.identity) throw new Error('CONTROL_SESSION_NOT_FOUND');
          const {
            __mearlControlSource: origin = 'local',
            __mearlBlockedTabIds: blocked,
            ...data
          } = payload;
          if (action === 'tab_open' && blocked?.length && data.reuse !== 'never') {
            const result = await this.request(current, 'tab_list', {}, origin);
            if (!Array.isArray(result.tabs))
              throw new Error('Provider did not return its current pages');
            const candidates = findMatchingTabs(result.tabs, data.url, data.match);
            if (candidates.some((tab: any) => blocked.includes(tab.tabId ?? tab.id)))
              throw new Error('TAB_CONTROLLED_BY_SESSION');
          }
          return this.request(current, action, data, origin);
        },
        cleanup: async (tabs, _transport, preserveEnvironment) => {
          if (!preserveEnvironment) await this.clearEnvironment(browser.browserId, tabs);
        },
        download: async (data, _transport, origin) => {
          const current = this.browser(browser.browserId);
          if (identity(current) !== control.identity) throw new Error('CONTROL_SESSION_NOT_FOUND');
          const result = await this.request(current, 'page_download', data, origin);
          if (
            !result ||
            typeof result.filename !== 'string' ||
            !result.filename ||
            typeof result.filePath !== 'string' ||
            !isAbsolute(result.filePath) ||
            !Object.hasOwn(result, 'action') ||
            (result.owned !== undefined && typeof result.owned !== 'boolean')
          )
            throw new Error(
              'Provider page_download must return a completed file with filename, absolute filePath and action',
            );
          return {
            filename: result.filename,
            filePath: result.filePath,
            action: result.action,
            owned: result.owned === true,
          };
        },
        notify: this.dependencies.notify,
      }),
    };
    this.controls.set(browser.browserId, control);
    return control;
  }

  private async request(
    browser: BrowserRecord,
    action: string,
    data: any,
    origin: string,
    host?: ProviderHostContextData,
  ) {
    const nativeDialogPress = (action: string, payload: any) =>
      action === 'page_press' &&
      (payload?.dialogId !== undefined || payload?.promptText !== undefined);
    if (
      nativeDialogPress(action, data) ||
      (action === 'run_actions' &&
        Array.isArray(data?.actions) &&
        data.actions.some((step: any) => nativeDialogPress(step?.action, step?.data)))
    ) {
      throw new Error(
        'Provider native dialog handling is not negotiated. Use the built-in CDP or extension transport.',
      );
    }
    if (
      action === 'get_capabilities' &&
      !browser.capabilities?.actions.includes('get_capabilities')
    ) {
      return describeBrowserCapabilities(
        ['get_capabilities', ...(browser.capabilities?.actions ?? [])],
        undefined,
        data,
      );
    }
    if (action === 'browser_release') {
      action = 'browser_instances';
      data = { operation: 'detach' };
    }
    const lifecycle =
      action === 'browser_control'
        ? data.operation
        : action === 'browser_close'
          ? data.deleteProfile === true
            ? 'deleteData'
            : 'close'
          : action === 'get_browser_access_url'
            ? 'access'
            : action === 'browser_instances'
              ? data.operation === 'sync_cookies'
                ? 'syncCookies'
                : data.operation
              : undefined;
    if (lifecycle && !browser.operations?.includes(lifecycle))
      throw new Error(`Provider browser does not support ${lifecycle}`);
    if (!lifecycle && action !== 'get_versions') {
      if (browser.status !== 'connected') throw new Error('Provider browser is not connected');
      if (!browser.capabilities?.actions.some(capability => capability === action))
        throw new Error(`Provider browser does not support ${action}`);
    }
    const deadline = this.deadlines.getStore();
    if (deadline !== undefined) {
      providerRequestTimeoutMs(action, data, deadline);
      return this.dependencies.request(browser, action, data, origin, host, deadline);
    }
    return this.dependencies.request(browser, action, data, origin, host);
  }

  private async clearEnvironment(browserId: string, tabs: number[]) {
    const browser = this.browser(browserId);
    const actions = new Set<string>(browser.capabilities?.actions ?? []);
    if (actions.has('set_mock') && !actions.has('get_mocks'))
      throw new Error('Provider cannot enumerate Mock state for cleanup');
    const clear = async (action: string, data: any) => {
      const result = await this.request(browser, action, data, 'local');
      if (result?.success === false || result?.action?.success === false)
        throw new Error(
          result.error ?? result.action?.error ?? 'Provider environment cleanup failed',
        );
    };
    for (const tabId of tabs) {
      if (actions.has('set_mock')) {
        const result = await this.request(browser, 'get_mocks', { tabId }, 'local');
        if (!Array.isArray(result.mocks)) throw new Error('Provider did not return its Mock state');
        const names = new Set<string>(result.mocks.map((mock: any) => mock.apiName));
        for (const apiName of names) await clear('set_mock', { tabId, apiName, enabled: false });
      }
      for (const [action, data] of [
        ['set_app_profile', { tabId, enabled: false, networkControl: null }],
        ['set_device_emulation', { tabId, enabled: false }],
        ['set_timezone', { tabId, timezone: '' }],
      ] as const) {
        if (actions.has(action)) await clear(action, data);
      }
    }
  }

  async invoke(
    browserId: string,
    action: string,
    data: any = {},
    sessionId?: string,
    origin = 'local',
    host?: ProviderHostContextData,
    deadline?: number,
  ) {
    return this.deadlines.run(deadline, async () => {
      if (deadline !== undefined) providerRequestTimeoutMs(action, data, deadline);
      this.reap();
      const browser = this.browser(browserId);
      if (browser.capabilities?.controlSessionMode === 'external' && sessionId !== undefined) {
        throw new Error(
          'CONTROL_SESSION_UNSUPPORTED: this Provider manages task control externally; use browser_control without --session.',
        );
      }
      if (browser.capabilities?.controlSessionMode === 'external' && action === 'browser_control') {
        const params = parseExternalBrowserControl(data);
        return this.request(browser, action, params, origin);
      }
      const { manager } = this.getControl(browser);
      if (action === 'get_versions' || action === 'get_browser_access_url')
        return this.request(browser, action, data, origin);
      if (action === 'browser_instances') {
        if (!['start', 'detach', 'sync_cookies'].includes(data.operation))
          throw new Error('Invalid browser instance operation');
        return manager.registry.releaseBrowser(() =>
          this.request(browser, action, data, origin, host),
        );
      }
      return manager.invoke(action, data, sessionId, undefined, origin);
    });
  }

  async dispose() {
    await Promise.all([
      ...this.retired,
      ...[...this.controls.values()].map(async ({ manager }) => {
        await Promise.all(
          manager.registry.list().map(session => manager.registry.waitForIdle(session.sessionId)),
        );
        await manager.artifacts.dispose();
      }),
    ]);
  }
}
