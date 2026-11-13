import type {
  BrowserAccessResult,
  BrowserLaunchParams,
  ManagedBrowserInfo,
  BrowserProviderDefinition,
  BrowserProviderListResult,
} from '@mearl/browser-core';
import { providerBrowserInfo, providerIdentity } from './browser-inventory.js';
import type {
  JsonObject,
  ProviderBrowser,
  ProviderHostContextData,
  ProviderRuntime,
  ProviderLaunchFormRequest,
} from '@mearl/provider';
import { resolveCookieCopyPlan, type TransferableCookie } from './browser-cookie-copy.js';
import {
  accessProviderBrowser,
  closeProviderBrowser,
  configureProvider,
  getProviderLaunchForm,
  detachProviderBrowser,
  findProviderBrowser,
  launchProviderBrowser,
  listExternalBrowserProviders,
  startProviderBrowser,
  syncProviderBrowserCookies,
} from './browser-provider.js';

interface RuntimeBrowser {
  runtime: ProviderRuntime;
  browser: ProviderBrowser;
}

export class BrowserProviderCoordinator {
  constructor(
    private readonly runtimes: ProviderRuntime[],
    private readonly hostServices?: {
      exportCookies: (domains: string[]) => Promise<TransferableCookie[]>;
      getBrowserUserAgent: () => Promise<string>;
    },
  ) {}

  private async hostContext(options: JsonObject): Promise<ProviderHostContextData | undefined> {
    if (!this.hostServices) return undefined;
    const result: ProviderHostContextData = {};
    if (options.copyCookieDomains !== undefined) {
      const plan = resolveCookieCopyPlan(options.copyCookieDomains as any);
      result.cookies = plan.select(
        await this.hostServices.exportCookies(plan.domains),
      ) as unknown as JsonObject[];
    }
    if (options.userAgentMode === 'desktop') {
      result.userAgent = await this.hostServices.getBrowserUserAgent();
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  definitions(): BrowserProviderListResult {
    const builtins = this.runtimes.map<BrowserProviderDefinition>(runtime => {
      const descriptor = runtime.definition.descriptor;
      return {
        provider: providerIdentity(descriptor),
        browserType: runtime.definition.browserType,
      };
    });
    return {
      providers: [...builtins, ...listExternalBrowserProviders()],
    };
  }

  get providerRuntimes(): ProviderRuntime[] {
    return this.runtimes;
  }

  async launch(
    input: BrowserLaunchParams,
    deadline?: number,
    operation: 'launch' | 'attach' = 'launch',
  ): Promise<ManagedBrowserInfo> {
    const providerId = input.provider?.trim() || 'local';
    const runtime = this.runtimes.find(
      item => item.definition.descriptor.providerId === providerId,
    );
    const builtinOptions = { ...input };
    delete builtinOptions.provider;
    delete builtinOptions.providerOptions;
    if (input.providerOptions && Object.keys(builtinOptions).length > 0) {
      throw new Error('Use either providerOptions or flat launch options, not both');
    }
    const external = runtime
      ? undefined
      : listExternalBrowserProviders().find(provider => provider.provider.id === providerId);
    if (!runtime && !external) throw new Error(`Provider is not registered: ${providerId}`);
    const browserType = runtime?.definition.browserType ?? external?.browserType;
    const acceptedOperation = browserType?.openOperation ?? 'launch';
    if (operation !== acceptedOperation)
      throw new Error(`Provider ${providerId} requires operation "${acceptedOperation}"`);
    if (runtime) {
      const descriptor = runtime.definition.descriptor;
      const options = { ...(input.providerOptions ?? builtinOptions) } as JsonObject;
      if (Array.isArray(options.copyCookieDomains))
        options.copyCookieDomains = { domains: options.copyCookieDomains };
      if (options.copyCookieDomains === 'mearl-services')
        options.copyCookieDomains = { presets: ['mearl-services'] };
      return providerBrowserInfo({
        provider: providerIdentity(descriptor),
        browser: await runtime.launch(options, { deadline }),
      });
    }
    if (Object.keys(builtinOptions).length > 0) {
      throw new Error('External Provider launch options must be supplied in providerOptions');
    }
    const host = await this.hostContext((input.providerOptions ?? {}) as JsonObject);
    return providerBrowserInfo({
      provider: external!.provider,
      browser: await launchProviderBrowser({
        provider: providerId,
        providerOptions: (input.providerOptions ?? {}) as JsonObject,
        ...(host ? { host } : {}),
      }),
    });
  }

  async close(
    selector: string,
    deleteProfile = false,
    withClose?: (close: () => Promise<unknown>, localBrowserId?: string) => Promise<unknown>,
  ): Promise<unknown> {
    const match = await this.requireOne(selector);
    if ('external' in match) {
      const close = () => closeProviderBrowser(match.external, { deleteProfile });
      return withClose ? withClose(close) : close();
    }
    const { browserId } = match.browser;
    const close = () => match.runtime.close({ browserId, deleteData: deleteProfile });
    const localBrowserId =
      match.runtime.definition.descriptor.providerId === 'local' ? browserId : undefined;
    return withClose ? withClose(close, localBrowserId) : close();
  }

  async start(selector: string): Promise<ManagedBrowserInfo> {
    const match = await this.requireOne(selector);
    if ('external' in match) {
      if (!match.external.provider) throw new Error('Provider identity is missing');
      return providerBrowserInfo({
        provider: match.external.provider,
        browser: await startProviderBrowser(match.external),
      });
    }
    const descriptor = match.runtime.definition.descriptor;
    return providerBrowserInfo({
      provider: providerIdentity(descriptor),
      browser: await match.runtime.start({ browserId: match.browser.browserId }),
    });
  }

  async syncCookies(selector: string, scope: JsonObject): Promise<unknown> {
    const match = await this.requireOne(selector);
    if ('external' in match) {
      const host = await this.hostContext({ copyCookieDomains: scope });
      return host
        ? syncProviderBrowserCookies(match.external, scope, host)
        : syncProviderBrowserCookies(match.external, scope);
    }
    return match.runtime.syncCookies({ browserId: match.browser.browserId, scope });
  }

  async access(selector: string): Promise<BrowserAccessResult> {
    const match = await this.requireOne(selector);
    const browserAccess =
      'runtime' in match
        ? await match.runtime.getAccess({ browserId: match.browser.browserId })
        : await accessProviderBrowser(match.external);
    return { browserAccess };
  }

  async detach(selector: string): Promise<unknown> {
    const match = await this.requireOne(selector);
    if ('runtime' in match) {
      return match.runtime.detach({ browserId: match.browser.browserId });
    }
    return detachProviderBrowser(match.external);
  }

  async configure(providerId: string, options: JsonObject): Promise<unknown> {
    const runtime = this.runtimes.find(
      item => item.definition.descriptor.providerId === providerId,
    );
    if (runtime) return runtime.configure(options);
    return configureProvider(providerId, options);
  }

  async getLaunchForm(providerId: string, request: ProviderLaunchFormRequest) {
    const runtime = this.runtimes.find(
      item => item.definition.descriptor.providerId === providerId,
    );
    return runtime ? runtime.getLaunchForm(request) : getProviderLaunchForm(providerId, request);
  }

  private async findRuntimeBrowsers(selector: string): Promise<RuntimeBrowser[]> {
    const normalized = selector.trim().toLowerCase();
    const entries = (
      await Promise.all(
        this.runtimes.map(async runtime =>
          (await runtime.listBrowsers()).map(browser => ({ runtime, browser })),
        ),
      )
    ).flat();
    const exact = entries.filter(entry => entry.browser.browserId.toLowerCase() === normalized);
    return exact.length > 0
      ? exact
      : entries.filter(entry => entry.browser.name.toLowerCase() === normalized);
  }

  private async requireOne(
    selector: string,
  ): Promise<RuntimeBrowser | { external: NonNullable<ReturnType<typeof findProviderBrowser>> }> {
    const matches = await this.findRuntimeBrowsers(selector);
    const external = findProviderBrowser(selector);
    if (matches.length + Number(Boolean(external)) > 1) {
      throw new Error(
        `Browser name is ambiguous: ${selector}. Use the full browserId from browser_list.`,
      );
    }
    if (matches[0]) return matches[0];
    if (external) return { external };
    throw new Error(`Provider browser not found: ${selector}`);
  }
}
