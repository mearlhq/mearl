import { StringDecoder } from 'node:string_decoder';
import type { Socket } from 'node:net';
import type { PluginTaskWireMessage } from './pluginTaskProtocol.js';

const MAX_MESSAGE_BYTES = 96 * 1024 * 1024;

export function readPluginTaskMessages(
  socket: Socket,
  receive: (message: PluginTaskWireMessage) => void,
): void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  socket.on('data', chunk => {
    try {
      buffer += decoder.write(chunk);
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES)
          throw new Error('Plugin host message is too large');
        const message = JSON.parse(line);
        if (!message || typeof message !== 'object' || !Number.isSafeInteger(message.id))
          throw new Error('Invalid plugin host message');
        receive(message);
      }
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES)
        throw new Error('Plugin host message buffer exceeded its limit');
    } catch (error) {
      socket.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function writePluginTaskMessage(
  socket: Socket,
  message: PluginTaskWireMessage,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const text = JSON.stringify(message) + '\n';
      if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES)
        throw new Error('Plugin host message is too large');
      if (socket.destroyed) throw new Error('Plugin host connection is closed');
      socket.write(text, error => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error);
    }
  });
}
