import { grantPresetOrigins } from '../../shared/presetPermissions';
import { openBrowserRequestLogin, closeBrowserRequestLogin } from './browserRequestLogin';
import { browserCapabilityRegistry } from './browserCapabilityRegistry';
import { prepareBrowserCapability } from './browserCapabilities';
import { isExtensionUiSender } from './extensionMessageTrust';
import { isExternalServiceEnabled } from './externalServices';
import { BROWSER_UI_OPERATION_PORT } from '../../shared/browserCapabilityMessages';
import { parseAppProfileMenu } from '../../shared/appProfileMenu';

export function initializeBrowserUiOperations() {
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== BROWSER_UI_OPERATION_PORT) return;
    if (!port.sender || !isExtensionUiSender(port.sender, chrome.runtime.id)) {
      port.disconnect();
      return;
    }
    const controller = new AbortController();
    let accepted = false;
    port.onDisconnect.addListener(() => controller.abort());
    port.onMessage.addListener(input => {
      if (accepted || controller.signal.aborted) return;
      accepted = true;
      void handleBrowserUiService(input, port.sender!, controller.signal).then(result => {
        if (!controller.signal.aborted) {
          try {
            port.postMessage(result);
          } catch {
            controller.abort();
          }
        }
      });
    });
  });
}

/** UI operations can call only the handlers selected by the installed preset. */
export async function handleBrowserUiService(
  input: unknown,
  sender: chrome.runtime.MessageSender,
  signal?: AbortSignal,
) {
  if (!isExtensionUiSender(sender, chrome.runtime.id))
    return { success: false, error: 'Extension UI required' };
  try {
    signal?.throwIfAborted();
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Expected a browser UI operation');
    const value = input as Record<string, unknown>;
    if (value.operation === 'loginClose') {
      if (typeof value.id !== 'string') throw new Error('Expected a login lease');
      await closeBrowserRequestLogin(value.id, sender);
      return { success: true };
    }
    if (value.operation === 'authorizeAccounts') {
      if (typeof value.origin !== 'string') throw new Error('Expected an account origin');
      const url = new URL(value.origin);
      if (
        url.origin !== value.origin ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.hostname.includes('*')
      )
        throw new Error('Expected an HTTP(S) account origin');
      const origins = [`${url.origin}/*`];
      // Start in the message's click gesture and finish in the worker if the popup closes.
      if (!(await chrome.permissions.request({ origins }))) return { success: false };
      const { extension } = await browserCapabilityRegistry().settings();
      const login = extension?.logins?.accounts;
      if (!login || new URL(login.url).origin !== url.origin)
        throw new Error('Account service changed');
      await grantPresetOrigins(origins);
      return { success: true };
    }
    if (value.operation === 'presetPermissions' || value.operation === 'authorizePreset') {
      const status = await browserCapabilityRegistry().installationStatus();
      const revision = status.installationRevision ?? status.browserRevision;
      if (value.operation === 'authorizePreset') {
        if (!revision || value.revision !== revision || value.presetId !== status.presetId)
          throw new Error('INSTALLATION_SELECTION_CHANGED');
        await grantPresetOrigins(status.requiredOrigins);
      }
      const current =
        value.operation === 'authorizePreset'
          ? await browserCapabilityRegistry().installationStatus()
          : status;
      return {
        success: true,
        data: {
          presetId: current.presetId,
          revision: current.installationRevision ?? current.browserRevision,
          origins: current.requiredOrigins,
          pending: current.permissionPending,
        },
      };
    }
    if (value.operation === 'invoke' && typeof value.name === 'string')
      return {
        success: true,
        ...(await invokeConfiguredBrowserOperation(value.name, value.input, {
          provider: value.provider,
          signal,
        })),
      };
    const settings = await browserCapabilityRegistry().settings();
    if (value.operation === 'loginOpen') {
      if (typeof value.name !== 'string' || typeof value.id !== 'string')
        throw new Error('Expected a configured login');
      const logins = settings.extension?.logins;
      const definition =
        logins && Object.hasOwn(logins, value.name) ? logins[value.name] : undefined;
      if (!definition) throw new Error('CAPABILITY_NOT_INSTALLED');
      const id = await openBrowserRequestLogin(definition.url, sender, value.id);
      return { success: true, data: { id, definition } };
    }
    if (value.operation === 'settings') {
      const { operations, logins, ...data } = settings.extension ?? {};
      return {
        success: true,
        data,
        contributions: {
          schemaVersion: 1,
          ...(operations ? { operations } : {}),
          ...(logins ? { logins } : {}),
        },
        cacheScope: settings.cacheScope,
        appProfiles: parseAppProfileMenu(settings.appProfiles ?? []),
        browserControl: settings.browserControl,
      };
    }
    throw new Error('Expected a browser UI operation name');
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Background controllers share the selected operation and permission checks with extension UI. */
export async function prepareConfiguredBrowserOperation(name: string, provider?: unknown) {
  const registry = browserCapabilityRegistry();
  const selection = await registry.captureSelection();
  const settings = await registry.settings(selection);
  const operations = settings.extension?.operations;
  const declaration = operations && Object.hasOwn(operations, name) ? operations[name] : undefined;
  if (!declaration) throw new Error('CAPABILITY_NOT_INSTALLED');
  if (declaration.setting && !(await isExternalServiceEnabled(declaration.setting, settings)))
    throw new Error('SERVICE_DISABLED');
  let expected: { bundleId: string; revision: string } | undefined;
  if (provider !== undefined) {
    const candidate = provider as Record<string, unknown>;
    if (
      !candidate ||
      typeof candidate.bundleId !== 'string' ||
      typeof candidate.revision !== 'string'
    )
      throw new Error('Expected a browser UI provider');
    expected = { bundleId: candidate.bundleId as string, revision: candidate.revision as string };
  }
  const accepted = await prepareBrowserCapability(declaration.hook, expected, selection);
  if (!accepted) throw new Error('CAPABILITY_UNAVAILABLE');
  return accepted;
}

export async function invokeConfiguredBrowserOperation(
  name: string,
  input?: unknown,
  { provider, signal }: { provider?: unknown; signal?: AbortSignal } = {},
) {
  const accepted = await prepareConfiguredBrowserOperation(name, provider);
  signal?.throwIfAborted();
  const data = await accepted.invoke(input, signal);
  return { data, provider: { bundleId: accepted.bundleId, revision: accepted.revision } };
}
