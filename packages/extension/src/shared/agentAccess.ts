export const AGENT_ACCESS_PREFERENCE = 'agent-access-preference';
export const AGENT_ACCESS_PROVIDERS = 'agent-access-providers';

export function resolveAgentAccess(
  preference: unknown,
  providers: unknown,
  legacy: unknown,
): boolean {
  if (typeof preference === 'boolean') return preference;
  if (Array.isArray(providers) && providers.length) return false;
  return legacy !== false;
}

/** Assignment is local and sticky: disappearance is not authorization to take over. */
export async function readAgentAccess(providerIds?: string[], legacy?: boolean): Promise<boolean> {
  const [local, sync] = await Promise.all([
    chrome.storage.local.get([AGENT_ACCESS_PREFERENCE, AGENT_ACCESS_PROVIDERS]),
    legacy === undefined
      ? chrome.storage.sync.get('agentEnabled')
      : Promise.resolve({ agentEnabled: legacy }),
  ]);
  let providers = local?.[AGENT_ACCESS_PROVIDERS];
  if (providerIds?.length && JSON.stringify(providerIds) !== JSON.stringify(providers)) {
    providers = providerIds;
    await chrome.storage.local.set({ [AGENT_ACCESS_PROVIDERS]: providerIds });
  }
  return resolveAgentAccess(local?.[AGENT_ACCESS_PREFERENCE], providers, sync?.agentEnabled);
}
