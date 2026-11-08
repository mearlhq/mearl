import { execFileSync } from 'node:child_process';

const MAC_BROWSER_NAMES: Readonly<Record<string, string>> = {
  'com.citrolabs.ego.lite': 'EgoLite',
  'com.google.Chrome': 'Chrome',
  'com.google.Chrome.beta': 'Chrome Beta',
  'com.google.Chrome.dev': 'Chrome Dev',
  'com.google.Chrome.canary': 'Chrome Canary',
  'com.microsoft.edgemac': 'Edge',
  'com.microsoft.edgemac.Beta': 'Edge Beta',
  'com.microsoft.edgemac.Dev': 'Edge Dev',
  'com.microsoft.edgemac.Canary': 'Edge Canary',
};

interface BrowserIdentityProbe {
  platform: NodeJS.Platform;
  parentPid: number;
  executable(pid: number): string;
  bundleIdentifier(plist: string): string;
}

const commandOptions = { encoding: 'utf8', timeout: 300, maxBuffer: 8192 } as const;
const nativeProbe: BrowserIdentityProbe = {
  platform: process.platform,
  parentPid: process.ppid,
  executable: pid => execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], commandOptions).trim(),
  bundleIdentifier: plist =>
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], commandOptions).trim(),
};

/** Inspect only the Native Messaging host's direct parent, never all running browsers. */
export function detectNativeBrowserName(probe: BrowserIdentityProbe = nativeProbe): string | undefined {
  if (probe.platform !== 'darwin' || !Number.isSafeInteger(probe.parentPid) || probe.parentPid <= 1)
    return undefined;
  try {
    const executable = probe.executable(probe.parentPid);
    const marker = '.app/Contents/MacOS/';
    const index = executable.lastIndexOf(marker);
    if (!executable.startsWith('/') || index < 0 || /[\r\n\0]/.test(executable)) return undefined;
    const plist = `${executable.slice(0, index + '.app'.length)}/Contents/Info.plist`;
    const identifier = probe.bundleIdentifier(plist);
    return Object.hasOwn(MAC_BROWSER_NAMES, identifier) ? MAC_BROWSER_NAMES[identifier] : undefined;
  } catch {
    // Missing permissions, an unknown app or an exited parent must not break the handshake.
    return undefined;
  }
}

/** Cache the bounded probe across extension reconnects; keep the reported name as fallback. */
export function createExtensionBrowserNameResolver(detect = detectNativeBrowserName) {
  let inspected = false;
  let nativeName: string | undefined;
  return (reportedName: string): string => {
    if (!inspected) {
      inspected = true;
      nativeName = detect();
    }
    return nativeName ?? reportedName;
  };
}
