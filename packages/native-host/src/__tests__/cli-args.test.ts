import { describe, expect, it } from 'vitest';
import { parseNativeHostInstallArgs } from '../install.js';
import { parseNativeHostRuntimeArgs } from '../runtimeArgs.js';

describe('parseNativeHostRuntimeArgs', () => {
  it('records whether the hosted browser is headless', async () => {
    await expect(
      parseNativeHostRuntimeArgs(['--daemon', '--browser-headless']),
    ).resolves.toMatchObject({
      browserHeadless: true,
      daemon: true,
    });
    await expect(parseNativeHostRuntimeArgs(['--daemon'])).resolves.toMatchObject({
      browserHeadless: false,
    });
  });

  it('parses strict daemon and CDP options', async () => {
    await expect(
      parseNativeHostRuntimeArgs([
        '--daemon',
        '--attach-cdp',
        '--cdp-port=9333',
        '--cdp-endpoint-file',
        '/tmp/private-cdp.url',
        '--browser-id',
        'chrome-a',
      ]),
    ).resolves.toMatchObject({
      browserId: 'chrome-a',
      cdpEndpointFile: '/tmp/private-cdp.url',
      cdpPort: 9333,
      daemon: true,
      attachCdp: true,
    });
  });

  it('keeps daemon options process-local and uses built-in defaults when omitted', async () => {
    await expect(parseNativeHostRuntimeArgs(['--daemon'])).resolves.toMatchObject({
      browserHeadless: false,
      browserId: 'cdp',
      browserName: 'CDP',
      cdpPort: 9222,
    });
    await expect(
      parseNativeHostRuntimeArgs([
        '--daemon',
        '--cdp-port',
        '9333',
        '--browser-id',
        'sandbox',
        '--browser-name',
        'sandbox-chromium',
      ]),
    ).resolves.toMatchObject({
      browserId: 'sandbox',
      browserName: 'sandbox-chromium',
      cdpPort: 9333,
    });
  });

  it('uses built-in defaults for Native Messaging launches', async () => {
    const extensionOrigin = `chrome-extension://${'a'.repeat(32)}/`;
    await expect(parseNativeHostRuntimeArgs([extensionOrigin])).resolves.toMatchObject({
      browserHeadless: false,
      browserId: 'cdp',
      browserName: 'CDP',
      cdpPort: 9222,
    });
  });

  it('accepts Chrome Native Messaging launch arguments', async () => {
    const extensionOrigin = `chrome-extension://${'a'.repeat(32)}/`;

    await expect(parseNativeHostRuntimeArgs([extensionOrigin])).resolves.toMatchObject({
      daemon: false,
      cdpPort: 9222,
      attachCdp: false,
    });
    await expect(
      parseNativeHostRuntimeArgs([extensionOrigin, '--parent-window=12345']),
    ).resolves.toMatchObject({
      daemon: false,
      cdpPort: 9222,
      attachCdp: false,
    });
  });

  it('rejects unknown options, missing values, and malformed numbers', async () => {
    await expect(parseNativeHostRuntimeArgs(['--unknown'])).rejects.toThrow('unknown option');
    await expect(parseNativeHostRuntimeArgs(['--cdp-port'])).rejects.toThrow('argument missing');
    await expect(parseNativeHostRuntimeArgs(['--cdp-port', '9222x'])).rejects.toThrow(
      'cdp-port must',
    );
  });
});

describe('parseNativeHostInstallArgs', () => {
  it('supports lifecycle commands and the established flag aliases', async () => {
    await expect(parseNativeHostInstallArgs(['--init', '--mode=skills'])).resolves.toMatchObject({
      mode: 'skills',
      uninstall: false,
    });
    await expect(parseNativeHostInstallArgs(['uninstall', '--mode', 'mcp'])).resolves.toMatchObject(
      {
        mode: 'mcp',
        uninstall: true,
      },
    );
  });

  it('rejects invalid modes, unknown options, and init-only uninstall options', async () => {
    await expect(parseNativeHostInstallArgs(['init', '--mode', 'other'])).rejects.toThrow(
      'Allowed choices',
    );
    await expect(parseNativeHostInstallArgs(['init', '--unknown'])).rejects.toThrow(
      'unknown option',
    );
    await expect(
      parseNativeHostInstallArgs(['uninstall', '--extension-id', 'a'.repeat(32)]),
    ).rejects.toThrow('only available for init');
  });
});
