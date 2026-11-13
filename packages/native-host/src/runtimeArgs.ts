export interface NativeHostRuntimeArgs {
  browserHeadless: boolean;
  browserId: string;
  browserName: string;
  cdpEndpointFile?: string;
  cdpPort: number;
  cdpUserDataDir?: string;
  daemon: boolean;
  attachCdp: boolean;
  help: boolean;
  inventory: boolean;
  skipBrowserRegistration: boolean;
  version: boolean;
}

function stripNativeMessagingLaunchArgs(argv: string[]): string[] {
  const [origin, parentWindow, ...rest] = argv;
  if (!/^chrome-extension:\/\/[a-z]{32}\/$/.test(origin ?? '')) return argv;

  // Chrome identifies the calling extension positionally. Windows also supplies
  // its native parent window handle so hosts can attach modal UI to the browser.
  if (/^--parent-window=\d+$/.test(parentWindow ?? '')) return rest;
  return argv.slice(1);
}

export async function parseNativeHostRuntimeArgs(argv: string[]): Promise<NativeHostRuntimeArgs> {
  const args = stripNativeMessagingLaunchArgs(argv);
  const options: Partial<NativeHostRuntimeArgs> = {};

  const readValue = (index: number, name: string): { nextIndex: number; value: string } | null => {
    const argument = args[index];
    if (argument === name) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`argument missing for option '${name}'`);
      }
      return { nextIndex: index + 1, value };
    }
    if (argument?.startsWith(`${name}=`)) {
      return { nextIndex: index, value: argument.slice(name.length + 1) };
    }
    return null;
  };
  const parseInteger = (value: string, label: string, minimum: number, maximum: number): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
    }
    return parsed;
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--daemon') {
      options.daemon = true;
      continue;
    }
    if (argument === '--attach-cdp') {
      options.attachCdp = true;
      continue;
    }
    if (argument === '--inventory') {
      options.inventory = true;
      continue;
    }
    if (argument === '--skip-browser-registration') {
      options.skipBrowserRegistration = true;
      continue;
    }
    if (argument === '--browser-headless') {
      options.browserHeadless = true;
      continue;
    }
    if (argument === '--version' || argument === '-v') {
      options.version = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }

    const cdpPort = readValue(index, '--cdp-port');
    if (cdpPort) {
      options.cdpPort = parseInteger(cdpPort.value, 'cdp-port', 1, 65_535);
      index = cdpPort.nextIndex;
      continue;
    }
    const stringOptions = [
      ['--cdp-user-data-dir', 'cdpUserDataDir'],
      ['--cdp-endpoint-file', 'cdpEndpointFile'],
      ['--browser-id', 'browserId'],
      ['--browser-name', 'browserName'],
    ] as const;
    let matchedStringOption = false;
    for (const [name, property] of stringOptions) {
      const parsed = readValue(index, name);
      if (!parsed) continue;
      options[property] = parsed.value;
      index = parsed.nextIndex;
      matchedStringOption = true;
      break;
    }
    if (matchedStringOption) continue;

    throw new Error(
      argument?.startsWith('-')
        ? `unknown option '${argument}'`
        : `unexpected argument '${argument}'`,
    );
  }

  return {
    browserHeadless: options.browserHeadless ?? false,
    browserId: options.browserId ?? 'cdp',
    browserName: options.browserName ?? 'CDP',
    ...(options.cdpEndpointFile ? { cdpEndpointFile: options.cdpEndpointFile } : {}),
    cdpPort: options.cdpPort ?? 9222,
    ...(options.cdpUserDataDir ? { cdpUserDataDir: options.cdpUserDataDir } : {}),
    daemon: options.daemon === true,
    attachCdp: options.attachCdp === true,
    help: options.help === true,
    inventory: options.inventory === true,
    skipBrowserRegistration: options.skipBrowserRegistration === true,
    version: options.version === true,
  };
}
