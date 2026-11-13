/**
 * CDP target discovery.
 *
 * Strategy (in order):
 * 1. Read Chrome's DevToolsActivePort file — written by Chrome when remote
 *    debugging is enabled (including via chrome://inspect/#remote-debugging).
 *    Contains the actual port and browser WebSocket path.
 * 2. Fall back to HTTP /json REST API on the given port (requires Chrome
 *    launched with --remote-debugging-port).
 * Chrome's approval-mode server also accepts /devtools/browser directly.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export interface CdpTarget {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
  faviconUrl?: string;
}

// ---------------------------------------------------------------------------
// DevToolsActivePort — written by Chrome when remote debugging is active
// ---------------------------------------------------------------------------

export function chromeUserDataDir(): string {
  const platform = process.platform;
  const home = os.homedir();
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  if (platform === 'win32') {
    return path.join(process.env['LOCALAPPDATA'] ?? home, 'Google', 'Chrome', 'User Data');
  }
  return path.join(home, '.config', 'google-chrome');
}

/**
 * Read Chrome's DevToolsActivePort file.
 * Returns { port, browserWsPath } or null if unavailable. Reports read failures
 * other than a missing file to callers that need discovery diagnostics.
 */
export function readDevToolsActivePort(
  userDataDir = chromeUserDataDir(),
  onError?: (error: Error) => void,
): { port: number; browserWsPath: string } | null {
  try {
    const filePath = path.join(userDataDir, 'DevToolsActivePort');
    const content = fs.readFileSync(filePath, 'utf8').trim();
    const lines = content.split('\n').map(l => l.trim());
    const port = parseInt(lines[0]!, 10);
    const browserWsPath = lines[1] ?? '/devtools/browser';
    if (isNaN(port)) return null;
    return { port, browserWsPath };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR')
      onError?.(error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP-based discovery (/json REST API)
// ---------------------------------------------------------------------------

export async function discoverTargets(port = 9222): Promise<CdpTarget[]> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${port}/json`, res => {
      let data = '';
      res.on('data', (chunk: string) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as CdpTarget[]);
        } catch (e) {
          reject(new Error(`Failed to parse CDP targets: ${e}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error('CDP discover timeout'));
    });
  });
}
