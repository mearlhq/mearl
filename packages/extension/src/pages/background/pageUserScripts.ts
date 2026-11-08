import { validatePageUserScriptParams, type PageUserScriptParams } from '@mearl/browser-core';
import { getChromiumMajorVersion } from '../../shared/chromiumVersion';

import { resolveToolboxPageFrame } from './toolboxPageFrame';

interface UserScriptsApi {
  configureWorld(properties: { worldId: string; messaging: boolean }): Promise<void>;
  execute(injection: {
    target: { tabId: number } & ({ frameIds: number[] } | { documentIds: string[] });
    world: 'USER_SCRIPT';
    worldId: string;
    js: { code: string }[];
    injectImmediately: boolean;
  }): Promise<{
    result?: { ok?: boolean; value?: unknown; error?: string };
    error?: string;
    frameId?: number;
    documentId?: string;
  }[]>;
}

export async function configurePageUserScripts(
  worldId: string,
  messaging: boolean,
): Promise<UserScriptsApi> {
  const chromeMajor = getChromiumMajorVersion();
  const unsupported = 'USER_SCRIPTS_UNSUPPORTED: Plugin page scripts require Chrome 135 or newer';
  if (chromeMajor < 135) throw new Error(unsupported);

  let api: UserScriptsApi;
  try {
    const userScripts = (chrome as unknown as { userScripts?: UserScriptsApi }).userScripts;
    if (!userScripts) throw new Error('User Scripts API unavailable');
    api = userScripts;
    await api.configureWorld({ worldId, messaging });
  } catch {
    const hint =
      chromeMajor < 138
        ? 'Enable Developer mode on chrome://extensions'
        : 'Enable "Allow User Scripts" in the Mearl extension details';
    throw new Error(`USER_SCRIPTS_DISABLED: ${hint}`);
  }
  if (typeof api.execute !== 'function') throw new Error(unsupported);
  return api;
}

export async function executePageUserScript(
  params: PageUserScriptParams,
): Promise<{ result: unknown }> {
  validatePageUserScriptParams(params);
  const worldId = `mearl-eval-${params.worldId}`;
  const api = await configurePageUserScripts(worldId, false);
  const frameId = await resolveToolboxPageFrame(params.tabId);
  const [execution] = await api.execute({
    target: { tabId: params.tabId, frameIds: [frameId] },
    world: 'USER_SCRIPT',
    worldId,
    js: [
      {
        code: `(async () => { try { return { ok: true, value: await (${params.code}\n) }; } catch (error) { return { ok: false, error: String(error?.message ?? error) }; } })()`,
      },
    ],
    injectImmediately: true,
  });
  if (!execution) throw new Error('User script execution returned no result');
  if (execution.error) throw new Error(execution.error);
  const result = execution.result;
  if (result?.ok === false) throw new Error(result.error || 'User script execution failed');
  if (result?.ok !== true)
    throw new Error(
      'User script returned no execution result; check the JavaScript expression syntax',
    );
  return { result: result.value ?? null };
}
