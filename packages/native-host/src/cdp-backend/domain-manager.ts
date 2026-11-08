import type { CdpChildSession, CdpClient } from './client.js';

type DomainClient = CdpClient | CdpChildSession;

const enabledDomains = new WeakMap<DomainClient, Map<string, Promise<void>>>();

export function ensureCdpDomain(
  client: DomainClient,
  domain: string,
  params: Record<string, unknown> = {},
): Promise<void> {
  let domains = enabledDomains.get(client);
  if (!domains) {
    domains = new Map();
    enabledDomains.set(client, domains);
  }

  const existing = domains.get(domain);
  if (existing) return existing;

  const enabling = client
    .sendCommand(`${domain}.enable`, params)
    .then(() => undefined)
    .catch(error => {
      if (domains?.get(domain) === enabling) domains.delete(domain);
      throw error;
    });
  domains.set(domain, enabling);
  return enabling;
}
