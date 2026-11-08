export const BROWSER_FOLLOW_FETCH_TARGET = 'mearl-browser-follow-fetch';
export interface BrowserFrameFetchInput {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  formBody?: Record<string, string>;
  credentials: RequestCredentials;
  cache?: 'default' | 'no-store';
}

/** Two policies intersect the user's domain selection with Chrome's host grants. */
export function applyBrowserConnectionPolicies(policies: unknown, doc: Document) {
  const source = /^(?:'none'|(?:https?|wss?):|(?:https?|wss?):\/\/(?:\*|(?:\*\.)?[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\]):\*)$/;
  if (!Array.isArray(policies) || policies.length !== 2 || policies.some(policy => typeof policy !== 'string' || policy.length > 262144 || !policy.startsWith('connect-src ') || !policy.slice(12).split(' ').every(value => source.test(value)))) throw new Error('Expected two bounded browser connection policies');
  for (const policy of policies) {
    const meta = doc.createElement('meta'); meta.httpEquiv = 'Content-Security-Policy'; meta.content = policy; doc.head.append(meta);
  }
}
