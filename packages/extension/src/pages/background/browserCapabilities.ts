import { fetchWithBrowserRedirects } from './browserFollowFetch';
import { browserCapabilityCatalog, type BrowserBundleSelection } from './browserCapabilityCatalog';
export type { BrowserBundleSelection } from './browserCapabilityCatalog';
import type { JsonObject } from '@mearl/preset';
import {
  BrowserBundleStore,
  BundleError,
  buildBrowserCapabilityPage,
  prepareBrowserBundleSnapshot,
  bundleDigest,
  type BrowserCapabilityHost,
  type BrowserCapabilityInvocation,
  type BrowserCapabilityRequest,
  type PreparedBundle,
} from '@mearl/preset/bundles';
import { isAgentDomainAuthorized } from '../../shared/proxyPermissions';
import {
  BROWSER_CAPABILITY_HOST_TARGET,
  BROWSER_CAPABILITY_OFFSCREEN_TARGET,
  BROWSER_CAPABILITY_OWNER_PORT,
} from '../../shared/browserCapabilityMessages';
import { withOffscreenDocument } from './offscreenDocument';
import { buildCookieHeader, buildDnrHeaders, collectCookies, fetchWithDnr } from './utils/dnr';

const store = new BrowserBundleStore({ mearlApiVersion: '1.0.0' });
const calls = new Map<string, BrowserCapabilityHost>();
const owners = new Map<string, { controller: AbortController; port?: chrome.runtime.Port }>();
let initialized = false;

export async function authorizeBrowserCapabilityUrl(input: unknown): Promise<URL> {
  if (typeof input !== 'string') throw new Error('Browser capability request requires a URL');
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Browser capability request requires an HTTP(S) URL without credentials');
  if (!(await isAgentDomainAuthorized(url.hostname)))
    throw Object.assign(new Error(`Browser domain permission required: ${url.hostname}`), {
      code: 'BROWSER_PERMISSION_REQUIRED',
    });
  if (!(await chrome.permissions.contains({ origins: [`${url.origin}/*`] })))
    throw Object.assign(new Error(`Browser host permission required: ${url.origin}`), {
      code: 'BROWSER_PERMISSION_REQUIRED',
    });
  return url;
}

function headerRecord(input: unknown): Record<string, string> {
  if (input === undefined) return {};
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.values(input).some(value => typeof value !== 'string')
  )
    throw new Error('Browser request headers must be strings');
  return Object.fromEntries(new Headers(input as Record<string, string>));
}

function createBrowserHost(signal: AbortSignal): BrowserCapabilityHost {
  return {
    async request(input: BrowserCapabilityRequest) {
      const url = await authorizeBrowserCapabilityUrl(input?.url);
      const headers = headerRecord(input.headers);
      let body: BodyInit | undefined = input.body;
      if (input.formBody !== undefined) {
        if (input.body !== undefined)
          throw new Error('Browser request body and formBody are mutually exclusive');
        if (
          !input.formBody ||
          typeof input.formBody !== 'object' ||
          Array.isArray(input.formBody) ||
          Object.values(input.formBody).some(value => typeof value !== 'string')
        )
          throw new Error('Browser request form fields must be strings');
        const form = new FormData();
        for (const [name, value] of Object.entries(input.formBody)) form.append(name, value);
        body = form;
      }
      const injected: chrome.declarativeNetRequest.ModifyHeaderInfo[] = Object.entries(
        headerRecord(input.injectedHeaders),
      ).map(([header, value]) => ({
        header,
        value,
        operation: chrome.declarativeNetRequest.HeaderOperation.SET,
      }));
      const cookieHeaders = Object.entries(headerRecord(input.cookieHeaders));
      if (cookieHeaders.length && !input.withCookies)
        throw new Error('Cookie header mappings require withCookies');
      const collected = cookieHeaders.length ? await collectCookies(url) : undefined;
      for (const [header, name] of cookieHeaders) {
        const value = collected?.find(cookie => cookie.name === name)?.value;
        if (value && !injected.some(entry => entry.header.toLowerCase() === header.toLowerCase()))
          injected.push({
            header,
            value,
            operation: chrome.declarativeNetRequest.HeaderOperation.SET,
          });
      }
      if (input.withSourceHeaders) {
        const defaults = buildDnrHeaders(
          url,
          input.withCookies ? (collected ?? (await collectCookies(url))) : undefined,
          input.withXsrf === false,
        );
        const explicit = new Set(injected.map(value => value.header.toLowerCase()));
        injected.unshift(...defaults.filter(value => !explicit.has(value.header.toLowerCase())));
      } else if (input.withCookies) {
        const cookie = collected
          ? await buildCookieHeader(url, collected)
          : await buildCookieHeader(url);
        if (cookie) injected.push(cookie);
      }
      if (input.redirect !== undefined && !['manual', 'follow'].includes(input.redirect))
        throw new Error('Invalid browser request redirect mode');
      if (input.cache !== undefined && !['default', 'no-store'].includes(input.cache))
        throw new Error('Invalid browser request cache mode');
      const fetchResponse = async () => {
        if (input.redirect === 'follow')
          return fetchWithBrowserRedirects(
            {
              url: url.href,
              method: input.method ?? 'GET',
              headers,
              ...(input.formBody ? { formBody: input.formBody } : { body: input.body }),
              credentials: input.credentials ?? (input.withCookies ? 'include' : 'omit'),
              ...(input.cache ? { cache: input.cache } : {}),
            },
            signal,
          );
        const response = await fetch(url.href, {
          method: input.method ?? 'GET',
          headers,
          body,
          credentials: input.credentials ?? (input.withCookies ? 'include' : 'omit'),
          redirect: 'manual',
          ...(input.cache ? { cache: input.cache } : {}),
          signal,
        });
        const redirected =
          response.type === 'opaqueredirect' || [301, 302, 303, 307, 308].includes(response.status);
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(
            [...response.headers].map(([name, value]) => [name.toLowerCase(), value]),
          ),
          body: await response.text(),
          ...(redirected && { redirected: true }),
        };
      };
      return injected.length ? fetchWithDnr(url, injected, fetchResponse) : fetchResponse();
    },
    async cookie(input) {
      const url = await authorizeBrowserCapabilityUrl(input?.url);
      if (typeof input.name !== 'string' || !input.name)
        throw new Error('Browser cookie lookup requires a name');
      if (input.domain !== undefined && typeof input.domain !== 'boolean')
        throw new Error('Invalid browser cookie domain scope');
      let partitionKey: chrome.cookies.CookiePartitionKey | undefined;
      if (input.partitionKey !== undefined) {
        if (
          !input.partitionKey ||
          typeof input.partitionKey !== 'object' ||
          Object.keys(input.partitionKey).some(key => key !== 'topLevelSite')
        )
          throw new Error('Invalid browser cookie partition');
        const site = await authorizeBrowserCapabilityUrl(input.partitionKey.topLevelSite);
        if (site.pathname !== '/' || site.search || site.hash)
          throw new Error('Cookie partition requires an origin');
        partitionKey = { topLevelSite: site.origin };
      }
      if (input.withRelatedCookies) {
        if (input.domain || partitionKey)
          throw new Error('Related cookie lookup cannot override its scope');
        return (await collectCookies(url)).find(cookie => cookie.name === input.name)?.value;
      }
      const lookup = chrome.cookies.getAll({
        ...(input.domain ? { domain: url.hostname } : { url: url.href }),
        ...(partitionKey ? { partitionKey } : {}),
      });
      const cookies =
        input.domain || partitionKey
          ? await lookup
          : await lookup.catch(() => [] as chrome.cookies.Cookie[]);
      for (const cookie of cookies) {
        if (cookie.name !== input.name) continue;
        if (input.domain) {
          const domain = cookie.domain?.replace(/^\./, '');
          if (!domain || !(await isAgentDomainAuthorized(domain))) continue;
        }
        return cookie.value;
      }
      return undefined;
    },
  };
}

export function initializeBrowserCapabilities(): void {
  if (initialized) return;
  initialized = true;
  chrome.runtime.onConnect.addListener(port => {
    if (!port.name.startsWith(BROWSER_CAPABILITY_OWNER_PORT)) return;
    const id = port.name.slice(BROWSER_CAPABILITY_OWNER_PORT.length);
    const owner = owners.get(id);
    const sender = port.sender;
    if (
      !owner ||
      owner.port ||
      owner.controller.signal.aborted ||
      sender?.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL('src/pages/offscreen/index.html') ||
      sender.tab !== undefined
    ) {
      port.disconnect();
      return;
    }
    owner.port = port;
    port.onDisconnect.addListener(() => {
      if (owners.get(id) === owner) owner.controller.abort();
    });
    port.postMessage({ type: 'ready', id });
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== BROWSER_CAPABILITY_HOST_TARGET) return;
    const host = calls.get(message.id);
    if (
      !host ||
      sender.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL('src/pages/offscreen/index.html') ||
      sender.tab !== undefined
    ) {
      sendResponse({ success: false, error: 'Browser capability call is no longer active' });
      return;
    }
    const operation =
      message.method === 'request'
        ? host.request(message.input)
        : message.method === 'cookie'
          ? host.cookie(message.input)
          : Promise.reject(new Error('Unsupported browser capability host method'));
    void operation.then(
      value => sendResponse({ success: true, value }),
      error =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return true;
  });
}

export async function runAcceptedBrowserCapability(
  input: BrowserCapabilityInvocation,
  validate = false,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  initializeBrowserCapabilities();
  const html = await buildBrowserCapabilityPage(input);
  signal?.throwIfAborted();
  const id = crypto.randomUUID();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const owner = { controller, port: undefined as chrome.runtime.Port | undefined };
  const disconnectOwner = () => owner.port?.disconnect();
  controller.signal.addEventListener('abort', disconnectOwner, { once: true });
  owners.set(id, owner);
  const unavailable = () =>
    Promise.reject(new Error('Browser factories must defer browser operations to their handlers'));
  calls.set(
    id,
    validate ? { request: unavailable, cookie: unavailable } : createBrowserHost(controller.signal),
  );
  try {
    return await withOffscreenDocument(async () => {
      controller.signal.throwIfAborted();
      const response = await new Promise<any>((resolve, reject) => {
        const aborted = () => reject(new Error('Browser capability aborted'));
        controller.signal.addEventListener('abort', aborted, { once: true });
        void chrome.runtime
          .sendMessage({
            target: BROWSER_CAPABILITY_OFFSCREEN_TARGET,
            id,
            html,
            timeoutMs: validate ? 30000 : 120000,
          })
          .then(resolve, reject)
          .finally(() => controller.signal.removeEventListener('abort', aborted));
      });
      if (response?.success !== true)
        throw new Error(response?.error || 'Browser capability returned no result');
      return response.value;
    });
  } finally {
    calls.delete(id);
    owners.delete(id);
    controller.signal.removeEventListener('abort', disconnectOwner);
    if (!controller.signal.aborted) owner.port?.disconnect();
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}

export async function validateBrowserCapabilities(
  bundles: PreparedBundle[],
  replacing: string[],
  config: Record<string, JsonObject> = {},
): Promise<void> {
  const prepared = await prepareBrowserBundleSnapshot(bundles, 'extension', '1.0.0', config);
  for (const [id, entry] of Object.entries(prepared.snapshot.modules)) {
    if (!replacing.includes(id)) continue;
    const handlers = [
      ...new Set(
        Object.values(prepared.snapshot.bindings)
          .filter(binding => binding.module === id)
          .map(binding => binding.handler),
      ),
    ];
    await runAcceptedBrowserCapability(
      {
        code: prepared.resources[entry.sha256],
        sha256: entry.sha256,
        handlers,
        config: entry.config,
      },
      true,
    );
  }
}

type BrowserCapabilityExpectation = { bundleId: string } & (
  { revision: string; bundleRevision?: never } | { bundleRevision: string; revision?: never }
);

export async function prepareBrowserCapabilities(
  hooks: string[],
  expected?: BrowserCapabilityExpectation,
  selection?: BrowserBundleSelection,
): Promise<
  Record<
    string,
    {
      bundleId: string;
      revision: string;
      invocation: Omit<BrowserCapabilityInvocation, 'input'>;
      invoke(input: unknown, signal?: AbortSignal): Promise<unknown>;
    }
  >
> {
  const current = selection ?? (await store.list());
  if (
    current.activationError ||
    current.installationError ||
    current.errors.some(error =>
      Object.hasOwn(current.activation?.snapshot.bundleRevisions ?? {}, error.id),
    )
  )
    throw new BundleError(
      'BUNDLE_INTEGRITY',
      'The selected browser capability graph is unavailable',
    );
  const prepared = await browserCapabilityCatalog(current).runtimes();
  const revisions = Object.fromEntries(
    await Promise.all(
      Object.entries(prepared.snapshot.modules).map(async ([id, entry]) => [
        id,
        entry.config && Object.keys(entry.config).length
          ? await bundleDigest(
              new TextEncoder().encode(JSON.stringify([current.revisions[id], entry.config])),
            )
          : current.revisions[id],
      ]),
    ),
  );
  return Object.fromEntries(
    hooks.flatMap(hook => {
      const binding = prepared.snapshot.bindings[hook];
      if (
        expected &&
        (binding?.module !== expected.bundleId ||
          (expected.bundleRevision !== undefined
            ? current.revisions[expected.bundleId] !== expected.bundleRevision
            : revisions[expected.bundleId] !== expected.revision))
      )
        throw new BundleError('BUNDLE_CONFLICT', 'The selected browser handler changed');
      if (!binding) return [];
      const entry = prepared.snapshot.modules[binding.module];
      const handlers = [
        ...new Set(
          Object.values(prepared.snapshot.bindings)
            .filter(value => value.module === binding.module)
            .map(value => value.handler),
        ),
      ];
      const accepted = {
        code: Uint8Array.from(prepared.resources[entry.sha256]),
        sha256: entry.sha256,
        handlers,
        handler: binding.handler,
        config: structuredClone(entry.config),
      };
      return [
        [
          hook,
          {
            bundleId: binding.module,
            revision: revisions[binding.module],
            invocation: accepted,
            invoke: (input: unknown, signal?: AbortSignal) =>
              runAcceptedBrowserCapability({ ...accepted, input }, false, signal),
          },
        ],
      ];
    }),
  );
}

export async function prepareBrowserCapability(
  hook: string,
  expected?: { bundleId: string; revision: string },
  selection?: BrowserBundleSelection,
): Promise<{
  bundleId: string;
  revision: string;
  invoke(input: unknown, signal?: AbortSignal): Promise<unknown>;
} | null> {
  const accepted = (await prepareBrowserCapabilities([hook], expected, selection))[hook];
  return accepted
    ? { bundleId: accepted.bundleId, revision: accepted.revision, invoke: accepted.invoke }
    : null;
}

export async function invokeBrowserCapability(
  hook: string,
  input: unknown,
  expected?: { bundleId: string; revision: string },
): Promise<{ available: false } | { available: true; value: unknown }> {
  const accepted = await prepareBrowserCapability(hook, expected);
  return accepted ? { available: true, value: await accepted.invoke(input) } : { available: false };
}
