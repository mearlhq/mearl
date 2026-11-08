/**
 * Reader for the shared browser registry that native-host processes publish, so
 * the client can discover every browser that currently has the extension
 * connected and address a specific one.
 *
 * Kept dependency-free (no @mearl/daemon-core) because the client ships
 * as a standalone npm package. It only has to agree with daemon-core on the
 * registry directory and record shape; reading scans every *.json in the dir,
 * so it never needs to replicate daemon-core's filename hashing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  BrowserCapabilities,
  BrowserDetails,
  BrowserPairingInfo,
  BrowserProviderIdentity,
  BrowserProviderOperation,
  BrowserReference,
  BrowserTransport,
} from '@mearl/browser-core';

/** Must match @mearl/daemon-core's DAEMON_HOME + the native-host 'browsers' subdir. */
const BROWSERS_DIR = path.join(os.homedir(), '.mearl', 'browsers');

export interface LiveBrowser {
  pid: number;
  browserId: string;
  socketPath: string;
  browserName: string;
  extensionVersion?: string;
  nativeHostVersion?: string;
  transport?: BrowserTransport;
  providerBrowserId?: string;
  provider?: BrowserProviderIdentity;
  capabilities?: BrowserCapabilities;
  status?: 'connected' | 'pairing' | 'running_disconnected' | 'stopped';
  ownership?: 'owned' | 'attached';
  persistence?: 'ephemeral' | 'persistent';
  operations?: BrowserProviderOperation[];
  pairing?: BrowserPairingInfo;
  references?: BrowserReference[];
  details?: BrowserDetails;
  lastFocusedAt?: number;
  updatedAt?: number;
}

function isAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Every live browser record, most-recently-focused first.
 *
 * Read-only: dead records are filtered out but never deleted here. Deleting is
 * left to the native-hosts (they overwrite their own record on reconnect and
 * reconcile when serving browser_list). Otherwise many concurrent clients pruning at once
 * could, in a narrow window, delete a record a browser just re-published on
 * reconnect — making a live browser briefly vanish from the registry.
 */
export function listLiveBrowsers(): LiveBrowser[] {
  let files: string[];
  try {
    files = fs.readdirSync(BROWSERS_DIR).filter(name => name.endsWith('.json'));
  } catch {
    return [];
  }

  const out: LiveBrowser[] = [];
  for (const name of files) {
    let rec: LiveBrowser;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(BROWSERS_DIR, name), 'utf-8')) as LiveBrowser;
    } catch {
      // Corrupt or mid-write (a writer may be renaming it in); skip.
      continue;
    }
    if (rec && typeof rec.pid === 'number' && rec.socketPath && isAlive(rec.pid)) {
      out.push(rec);
    }
  }

  return out.sort((a, b) => (b.lastFocusedAt ?? 0) - (a.lastFocusedAt ?? 0));
}

/**
 * Find the browser matching a user selector: exact browserId first, then an
 * exact (case-insensitive) name, then a substring of id/name.
 */
export function findBrowser(browsers: LiveBrowser[], selector: string): LiveBrowser | null {
  const sel = selector.trim().toLowerCase();
  if (!sel) return null;

  const byId = browsers.find(b => b.browserId.toLowerCase() === sel);
  if (byId) return byId;

  const exactNameMatches = browsers.filter(b => b.browserName.toLowerCase() === sel);
  if (exactNameMatches.length > 1) {
    throw new Error(
      `Browser name "${selector.trim()}" is ambiguous. Use a full browserId: ${exactNameMatches
        .map(browser => browser.browserId)
        .join(', ')}`,
    );
  }
  if (exactNameMatches[0]) return exactNameMatches[0];

  return (
    browsers.find(
      b => b.browserId.toLowerCase().includes(sel) || b.browserName.toLowerCase().includes(sel),
    ) ?? null
  );
}

/** Human-readable one-line label for a browser, used in listings and errors. */
export function describeBrowser(b: LiveBrowser): string {
  const idShort = b.browserId.length > 12 ? `${b.browserId.slice(0, 8)}…` : b.browserId;
  return `${b.browserName} [${idShort}]`;
}
