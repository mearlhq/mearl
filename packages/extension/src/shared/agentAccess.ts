export const AGENT_ACCESS_PREFERENCE = 'agent-access-preference';

export function resolveAgentAccess(
  preference: unknown,
  providers: unknown,
  legacy: unknown,
): boolean {
  if (typeof preference === 'boolean') return preference;
  if (Array.isArray(providers) && providers.length) return false;
  return legacy !== false;
}

/** Provider IDs apply only to hosts that negotiate Agent access on behalf of a Provider. */
export async function readAgentAccess(providerIds?: string[], legacy?: boolean): Promise<boolean> {
  const [local, sync] = await Promise.all([
    chrome.storage.local.get(AGENT_ACCESS_PREFERENCE),
    legacy === undefined
      ? chrome.storage.sync.get('agentEnabled')
      : Promise.resolve({ agentEnabled: legacy }),
  ]);
  return resolveAgentAccess(local?.[AGENT_ACCESS_PREFERENCE], providerIds, sync?.agentEnabled);
}
