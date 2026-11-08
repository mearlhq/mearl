import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { ensureProviderControlHost, type ProviderControlHostRecord } from './control-host.js';
import { MEARL_PROVIDER_PROTOCOL_VERSION } from './protocol.js';

/** Package-private transport shared by the two closed Provider host services. */
export async function requestProviderHost<T>(
  providerTarget: string,
  action: '__provider_enhancement' | '__provider_app_resources',
  data: unknown,
  options: { deadline: number; maximumBytes: number; assertHost(host: ProviderControlHostRecord): void },
): Promise<T> {
  const remaining = () => {
    const ms = options.deadline - Date.now();
    if (!Number.isSafeInteger(options.deadline) || ms < 1 || ms > 2_147_483_647)
      throw new Error('Provider host deadline exceeded or invalid');
    return ms;
  };
  const host = await ensureProviderControlHost(Math.min(remaining(), 10_000));
  options.assertHost(host);
  const id = randomUUID();
  const line = JSON.stringify({ id, action, providerTarget, protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
    controlSource: 'local', deadline: options.deadline, data }) + '\n';
  if (Buffer.byteLength(line) > options.maximumBytes) throw new Error('Provider host request exceeded its byte limit');
  const waitMs = remaining();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(host.socketPath);
    socket.setEncoding('utf8');
    let buffer = '', settled = false;
    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); socket.removeAllListeners(); socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error('Provider host request timed out; any dispatched effect is unconfirmed')), waitMs);
    socket.on('connect', () => socket.write(line));
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > options.maximumBytes) return finish(new Error('Provider host response exceeded its byte limit'));
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let response: any;
        try { response = JSON.parse(line); } catch { return finish(new Error('Invalid Provider host response')); }
        if (response?.id !== id) continue;
        if (response.success !== true) return finish(new Error(response.error ?? 'Provider host request failed'));
        if (!response.data || typeof response.data !== 'object') return finish(new Error('Invalid Provider host response'));
        return finish(undefined, response.data);
      }
    });
    socket.on('error', error => finish(error));
    socket.on('end', () => finish(new Error('Provider host connection closed before its response')));
    socket.on('close', () => finish(new Error('Provider host connection closed before its response')));
  });
}
