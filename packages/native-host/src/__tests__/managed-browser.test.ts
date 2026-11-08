import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildManagedChromeArgs,
  chromeExecutableCandidates,
  desktopChromeUserAgent,
  isManagedProcess,
  managedBrowserId,
  resolveChromeExecutable,
  resolveUserAgentMode,
} from '../managed-browser.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('managed Chrome discovery', () => {
  it('uses a case-insensitive browser identity', () => {
    expect(managedBrowserId('Account-A')).toBe('managed:account-a');
    expect(managedBrowserId('account-a')).toBe('managed:account-a');
  });

  it('contains platform-specific Chrome locations', () => {
    expect(chromeExecutableCandidates('darwin')).toContain(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );
    expect(chromeExecutableCandidates('linux')).toContain('/usr/bin/google-chrome');
    expect(chromeExecutableCandidates('win32').some(path => path.endsWith('chrome.exe'))).toBe(
      true,
    );
  });

  it('accepts an explicit executable path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mearl-chrome-'));
    dirs.push(dir);
    const executable = join(dir, 'chrome');
    writeFileSync(executable, '');
    expect(resolveChromeExecutable(executable)).toBe(executable);
  });

  it('rejects a missing explicit executable', () => {
    expect(() => resolveChromeExecutable('/definitely/missing/chrome')).toThrow(
      'Chrome executable not found',
    );
  });

  it('verifies a live process using an instance-specific command marker', () => {
    if (process.platform === 'win32') return;
    expect(isManagedProcess(process.pid, 'vitest')).toBe(true);
    expect(isManagedProcess(process.pid, 'definitely-not-this-process-marker')).toBe(false);
  });

  it('builds a WebGL-capable headless launch with an optional desktop user agent', () => {
    const userAgent = desktopChromeUserAgent('150.0.7871.129', 'darwin');
    const args = buildManagedChromeArgs({
      userDataDir: '/tmp/managed-browser-test',
      headless: true,
      userAgent,
    });

    expect(userAgent).toContain('Chrome/150.0.7871.129');
    expect(userAgent).not.toContain('HeadlessChrome');
    expect(args).toContain('--headless=new');
    expect(args).toContain('--remote-allow-origins=devtools://devtools');
    expect(args).toContain(`--user-agent=${userAgent}`);
    expect(args).not.toContain('--disable-gpu');
  });

  it('resolves managed browser user agent modes', () => {
    expect(resolveUserAgentMode(undefined)).toBe('default');
    expect(resolveUserAgentMode('default')).toBe('default');
    expect(resolveUserAgentMode('desktop')).toBe('desktop');
    expect(() => resolveUserAgentMode('mobile')).toThrow(
      'userAgentMode must be "default" or "desktop"',
    );
  });
});
