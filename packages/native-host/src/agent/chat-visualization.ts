import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DAEMON_HOME } from '@mearl/daemon-core';

// Leave space in the 1 MiB Native Messaging frame for the RPC envelope.
const MAX_VISUALIZATION_BYTES = 1024 * 1024 - 4096;

export function chatVisualizationOutputDirectory(): string {
  return path.join(DAEMON_HOME, 'visualizations');
}

function isWithin(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return (
    Boolean(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function resolveOutputDirectory(directory: string): Promise<string | null> {
  const parent = await realpath(path.dirname(directory));
  const root = path.join(parent, path.basename(directory));
  return (await lstat(root)).isDirectory() ? root : null;
}

export async function readChatVisualization(
  input: unknown,
  outputDirectories = [
    chatVisualizationOutputDirectory(),
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'visualizations'),
  ],
): Promise<{ html: string }> {
  if (
    typeof input !== 'string' ||
    !path.isAbsolute(input) ||
    path.extname(input).toLowerCase() !== '.html'
  ) {
    throw new Error('Expected an absolute visualization HTML path');
  }

  const candidate = path.resolve(input);
  const directories = outputDirectories.filter(directory => isWithin(directory, candidate));
  if (!directories.length) throw new Error('Visualization is outside the output directories');

  const resolved = await realpath(candidate);
  const roots = await Promise.all(
    directories.map(directory => resolveOutputDirectory(directory).catch(() => null)),
  );
  if (
    path.extname(resolved).toLowerCase() !== '.html' ||
    !roots.some(root => root !== null && isWithin(root, resolved))
  ) {
    throw new Error('Visualization is outside the output directories');
  }

  const file = await open(resolved, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Visualization must be a regular file');
    if (stat.size > MAX_VISUALIZATION_BYTES) throw new Error('Visualization is too large');
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw new Error('Visualization changed while being read');
    const result = {
      html: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)),
    };
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_VISUALIZATION_BYTES) {
      throw new Error('Visualization is too large');
    }
    return result;
  } finally {
    await file.close();
  }
}
