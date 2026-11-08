/** Explicit ingress configuration supplied by the deployment host or preset installer. */
export function resolveCloudPublicEndpoint(port: number, env: NodeJS.ProcessEnv = process.env): string | null {
  const template = env.MEARL_CLOUD_PUBLIC_URL?.trim();
  if (!template) return null;
  const rendered = template.replaceAll('{port}', String(port));
  const endpoint = /^[a-z][a-z\d+.-]*:\/\//i.test(rendered) ? rendered : `https://${rendered}`;
  const parsed = new URL(endpoint);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new Error('MEARL_CLOUD_PUBLIC_URL requires an HTTP(S) or WebSocket URL without embedded credentials or a fragment');
  }
  return parsed.toString();
}


/** Keep ordinary commands portable; shell-active paths use literal POSIX quoting. */
export function formatConnectorCommand(url: string): string {
  const argument = /[$`"\\\r\n]/.test(url)
    ? "'" + url.replaceAll("'", "'\\''") + "'"
    : `"${url}"`;
  return `npx @mearl/cloud-connector start ${argument}`;
}
