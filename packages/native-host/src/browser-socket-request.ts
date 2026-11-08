import net from 'node:net';
import { Utf8LineBuffer } from './socketLines.js';
import { MEARL_PROVIDER_PROTOCOL_VERSION, type ProviderHostContextData } from '@mearl/provider';

const MAX_RESPONSE_BUFFER_SIZE = 64 * 1024 * 1024;

interface SocketResponse {
  id?: string;
  success?: boolean;
  data?: any;
  error?: string;
}

export function requestBrowserSocket(
  socketPath: string,
  action: string,
  data: Record<string, any>,
  version: string,
  timeoutMs = 60_000,
  browserId?: string,
  host?: ProviderHostContextData,
  routing?: { providerTarget?: string; controlSource?: string; providerControlToken?: string; providerSourceIdentity?: string; providerPageId?: number; deadline?: number },
): Promise<any> {
  const deadline = routing?.deadline ?? Date.now() + timeoutMs;
  const remaining = deadline - Date.now();
  if (!Number.isSafeInteger(deadline) || remaining < 1)
    return Promise.reject(new Error('Browser request deadline exceeded'));
  const id = `browser_rpc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    const lines = new Utf8LineBuffer(MAX_RESPONSE_BUFFER_SIZE);
    let settled = false;

    const finish = (error?: Error, result?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeAllListeners();
      client.destroy();
      if (error) reject(error);
      else resolve(result);
    };

    const timer = setTimeout(
      () => finish(new Error(`Browser request timeout after ${timeoutMs}ms`)),
      Math.min(timeoutMs, remaining),
    );

    client.on('connect', () => {
      if (Date.now() >= deadline) return finish(new Error('Browser request deadline exceeded'));
      client.write(
        `${JSON.stringify({
          id,
          action,
          data,
          version,
          protocolVersion: MEARL_PROVIDER_PROTOCOL_VERSION,
          deadline,
          controlSource: routing?.controlSource ?? 'local',
          ...(routing?.providerTarget ? { providerTarget: routing.providerTarget } : {}),
          ...(routing?.providerControlToken ? { providerControlToken: routing.providerControlToken } : {}),
          ...(routing?.providerSourceIdentity ? { providerSourceIdentity: routing.providerSourceIdentity } : {}),
          ...(routing?.providerPageId !== undefined ? { providerPageId: routing.providerPageId } : {}),
          ...(browserId ? { browserId } : {}),
          ...(host ? { host } : {}),
        })}\n`,
      );
    });
    client.on('data', chunk => {
      const result = lines.push(chunk);
      if (result.overflow) {
        finish(new Error('Browser response exceeded the supported size'));
        return;
      }
      for (const line of result.lines) {
        let response: SocketResponse;
        try {
          response = JSON.parse(line) as SocketResponse;
        } catch {
          continue;
        }
        if (response.id !== id) continue;
        if (response.success) finish(undefined, response.data);
        else finish(new Error(response.error || 'Browser request failed'));
        return;
      }
    });
    client.on('error', error => finish(error));
    client.on('end', () => finish(new Error('Browser connection closed before responding')));
    client.on('close', () => finish(new Error('Browser connection closed before responding')));
  });
}
