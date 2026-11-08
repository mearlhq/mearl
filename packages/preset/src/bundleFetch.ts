import { BundleError, type BundleLoader } from './bundle.js';

/** Source trust and browser host permission checks belong to the caller's fetch implementation. */
export function createBundleFetchLoader(options: {
  fetch?: typeof fetch;
  credentials?: RequestCredentials;
} = {}): BundleLoader {
  return async (source, { maxBytes, signal }) => {
    const response = await (options.fetch ?? fetch)(source, {
      credentials: options.credentials ?? 'omit', redirect: 'error', cache: 'no-store', signal,
    });
    if (!response.ok || response.redirected) throw new BundleError('BUNDLE_INVALID', 'Bundle download failed or redirected');
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new BundleError('BUNDLE_QUOTA', 'Download exceeds its declared size limit');
        chunks.push(value.slice());
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  };
}
