export interface NetworkHostRoute { id?: string; fromHost: string; toHost: string }
export interface NetworkRoutePlan { routes: NetworkHostRoute[] }

/** Shared by Node, the extension host and the self-contained document-start runtime. */
export function parseNetworkRoutePlan(input: unknown): NetworkRoutePlan {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'routes') throw new Error('Invalid network route plan');
  const routes = (input as NetworkRoutePlan).routes;
  if (!Array.isArray(routes) || routes.length > 32) throw new Error('Invalid network routes');
  const sources = new Set<string>();
  const ids = new Set<string>();
  const hostname = (value: unknown): value is string => typeof value === 'string' && value.length <= 253 && value.includes('.') && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  for (const route of routes) {
    if (!route || typeof route !== 'object' || Array.isArray(route) || Object.keys(route).some(key => !['id', 'fromHost', 'toHost'].includes(key)) || route.id !== undefined && (typeof route.id !== 'string' || !/^[a-z][a-zA-Z0-9_.-]{0,79}$/.test(route.id)) || !hostname(route.fromHost) || !hostname(route.toHost) || route.fromHost === route.toHost || sources.has(route.fromHost) || route.id !== undefined && ids.has(route.id)) throw new Error('Invalid or ambiguous network route');
    sources.add(route.fromHost);
    if (route.id) ids.add(route.id);
  }
  if (routes.reduce((size, route) => size + route.toHost.length, 0) > 1024) throw new Error('Network route plan is too large');
  const plan = { routes: routes.map(({ id, fromHost, toHost }) => ({ ...(id ? { id } : {}), fromHost, toHost })) };
  if (JSON.stringify(plan).length > 12288) throw new Error('Network route header is too large');
  return plan;
}

export function encodeNetworkRoutePlan(input: NetworkRoutePlan): string {
  return btoa(JSON.stringify(parseNetworkRoutePlan(input)));
}
export function decodeNetworkRoutePlan(value: string): NetworkRoutePlan {
  if (value.length > 16384) throw new Error('Network route header is too large');
  return parseNetworkRoutePlan(JSON.parse(atob(value)));
}
