import { BundleError } from './bundle.js';
import type { BrowserViewTransport } from './browserViews.js';

/** WebSocket permissions use their HTTP counterpart; native sockets reject redirects. */
export function browserTransportUrl(input: unknown, kind: BrowserViewTransport['kind']) {
  if (typeof input !== 'string' || input.length > 16384) throw new BundleError('BUNDLE_INVALID', 'Expected a browser transport URL');
  const url = new URL(input);
  const protocols = kind === 'websocket' ? ['ws:', 'wss:'] : kind === 'eventSource' ? ['http:', 'https:'] : [];
  if (!protocols.includes(url.protocol) || url.username || url.password || url.hash) throw new BundleError('BUNDLE_INVALID', 'Invalid browser transport URL');
  const permission = new URL(url);
  if (permission.protocol === 'ws:') permission.protocol = 'http:';
  if (permission.protocol === 'wss:') permission.protocol = 'https:';
  return { url: url.href, permissionUrl: permission.href };
}

interface OriginRule { scheme: string; host: string }
function rules(origins: string[], domainOnly: boolean): OriginRule[] {
  return origins.flatMap(origin => {
    if (origin === '<all_urls>' && !domainOnly) return [{ scheme: '*', host: '*' }];
    const match = /^(\*|https?):\/\/(\*|(?:\*\.)?[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])\/\*$/.exec(origin);
    return !match || domainOnly && (match[1] !== '*' || match[2] === '*') ? [] : [{ scheme: match[1], host: match[2].toLowerCase() }];
  });
}
function intersection(a: string, b: string): string | undefined {
  const covers = (outer: string, inner: string) => outer === '*' || outer === inner || outer.startsWith('*.') && (inner.replace(/^\*\./, '') === outer.slice(2) || inner.replace(/^\*\./, '').endsWith('.' + outer.slice(2)));
  return covers(a, b) ? b : covers(b, a) ? a : undefined;
}
function sources(origins: string[], domainOnly: boolean, kind: BrowserViewTransport['kind']): string {
  const values = new Set<string>();
  const add = (scheme: string, host: string) => {
    for (const name of host.startsWith('*.') ? [host.slice(2), host] : [host]) values.add(name === '*' ? `${scheme}:` : `${scheme}://${name}:*`);
  };
  const accepted = rules(origins, domainOnly);
  for (const { scheme, host } of accepted) {
    if (domainOnly || kind === 'websocket') {
      for (const name of scheme === '*' ? ['http', 'https', 'ws', 'wss'] : scheme === 'https' ? ['https', 'wss'] : ['http', 'ws']) add(name, host);
    } else if (scheme === '*' || scheme === 'https') { add('https', host); }
  }
  if (!domainOnly && kind === 'eventSource') {
    // CSP http sources also permit https. Only their shared grant scope can be represented.
    const http = accepted.filter(rule => rule.scheme !== 'https');
    const https = accepted.filter(rule => rule.scheme !== 'http');
    for (const a of http) for (const b of https) {
      const host = intersection(a.host, b.host);
      if (host) add('http', host);
    }
  }
  return [...values].join(' ') || "'none'";
}

/** Native SSE redirects remain inside the intersecting domain and Chrome host policies. */
export function browserTransportPolicies(domains: string[], chromeOrigins: string[], allowAllDomains: boolean, kind: BrowserViewTransport['kind']): string[] {
  return [
    `connect-src ${allowAllDomains ? 'http: https: ws: wss:' : sources(domains, true, kind)}`,
    `connect-src ${sources(chromeOrigins, false, kind)}`,
  ];
}
