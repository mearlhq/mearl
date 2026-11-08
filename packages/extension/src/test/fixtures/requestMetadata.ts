/** A fake installed protocol annotates dotted operation IDs, independent of any vendor. */
export function requestMetadataFixture(input: { url: string }) {
  let name: string | undefined;
  try { name = new URL(input.url).pathname.split('/').find(segment => segment.split('.').length >= 3); } catch {}
  return name ? { apiName: name, namespace: name.split('.')[2], isProxy: false, proxyRequestUrl: null } : null;
}
