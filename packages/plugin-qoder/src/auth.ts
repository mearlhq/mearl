import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const QODER_TOKEN_KEY = 'QODER_PERSONAL_ACCESS_TOKEN';
const QODER_KEYCHAIN_SERVICE = 'ai.mearl.qoder.pat';

export function qoderAuthenticationHint(platform: NodeJS.Platform = process.platform): string {
  const lines = [
    'Configure QODER_PERSONAL_ACCESS_TOKEN on the browser machine, then restart the connector.',
    'Lookup order: process environment > MEARL_ENV_FILE > ~/.mearl/.env' +
      (platform === 'darwin' ? ` > macOS Keychain (${QODER_KEYCHAIN_SERVICE}).` : '.'),
  ];
  if (platform === 'darwin') {
    lines.push(
      `Enter the PAT interactively in a local terminal: security add-generic-password -U -a "$USER" -s ${QODER_KEYCHAIN_SERVICE} -w`,
    );
  }
  lines.push('Keep the PAT out of pairing URLs, chat messages and logs.');
  return lines.join('\n');
}

interface QoderTokenResolverOptions {
  token?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  readFile?: (file: string) => string;
  readKeychainToken?: () => string | undefined;
}

function normalizeToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  if (!token || /[\r\n\0]/.test(token)) return undefined;
  return token;
}

function envValue(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || match[1] !== key) continue;
    let value = (match[2] ?? '').trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    return normalizeToken(value);
  }
  return undefined;
}

function readMacKeychainToken(): string | undefined {
  const securityPath = '/usr/bin/security';
  if (!existsSync(securityPath)) return undefined;

  try {
    const account = userInfo().username;
    const result = spawnSync(
      securityPath,
      ['find-generic-password', '-a', account, '-s', QODER_KEYCHAIN_SERVICE, '-w'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
        windowsHide: true,
      },
    );
    return result.status === 0 ? normalizeToken(result.stdout) : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a PAT without putting it in a pairing URL, process argument, registry, or log. */
export function resolveQoderPersonalAccessToken(
  options: QoderTokenResolverOptions = {},
): string | undefined {
  const direct = normalizeToken(options.token);
  if (direct) return direct;

  const env = options.env ?? process.env;
  const inherited = normalizeToken(env[QODER_TOKEN_KEY]);
  if (inherited) return inherited;

  const homeDirectory = options.homeDirectory ?? homedir();
  const envFiles = [
    ...(env.MEARL_ENV_FILE?.trim() ? [resolve(env.MEARL_ENV_FILE)] : []),
    resolve(homeDirectory, '.mearl', '.env'),
  ];
  const readFile = options.readFile ?? (file => readFileSync(file, 'utf8'));
  for (const file of new Set(envFiles)) {
    try {
      const token = envValue(readFile(file), QODER_TOKEN_KEY);
      if (token) return token;
    } catch {
      // Continue to the next credential source.
    }
  }

  if ((options.platform ?? process.platform) !== 'darwin') return undefined;
  return normalizeToken((options.readKeychainToken ?? readMacKeychainToken)());
}
