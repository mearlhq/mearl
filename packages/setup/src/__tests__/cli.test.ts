import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETUP_COMMAND } from '../setupVersion.js';
import { main, parseSetupArgs, SETUP_VERSION } from '../cli.js';
import { prepareSetupPreset } from '../setupPreset.js';

vi.mock('../setupPreset.js', () => ({ prepareSetupPreset: vi.fn(async () => undefined) }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('parseSetupArgs', () => {
  it('installs a profile bundle in the selected browser without applying a preset', async () => {
    const installProfile = vi.fn().mockResolvedValue({ id: 'profiles' });
    const runPreset = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(
      await main(['profile', 'install', 'example/profiles@v1.0.0', '--browser', 'local'], false, {
        installProfile,
        runPreset,
      }),
    ).toBe(0);
    expect(installProfile).toHaveBeenCalledWith('example/profiles@v1.0.0', 'local');
    expect(runPreset).not.toHaveBeenCalled();
  });
  it('forwards a distribution fallback without overriding explicit preset arguments', async () => {
    vi.stubEnv('MEARL_SETUP_DEFAULT_PRESET', 'https://default.example.test/preset.json');
    const runLifecycle = vi.fn(async () => true);
    expect(await main(['--yes'], false, { runLifecycle })).toBe(0);
    expect(runLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPresetSource: 'https://default.example.test/preset.json',
        operation: 'install',
      }),
      expect.any(Object),
    );
  });
  it('prepares full setup capabilities before replacing extension files and stops if preparation fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const installBrowserExtension = vi.fn();
    const runLifecycle = vi.fn();
    vi.mocked(prepareSetupPreset).mockRejectedValueOnce(new Error('offline resources'));
    expect(
      await main(['extension', '--full', '--yes'], false, {
        installBrowserExtension,
        runLifecycle,
      }),
    ).toBe(1);
    expect(installBrowserExtension).not.toHaveBeenCalled();
    expect(runLifecycle).not.toHaveBeenCalled();
  });
  it('delegates preset operations and distinguishes pending readiness from failure', async () => {
    expect(parseSetupArgs(['preset', 'apply', './preset.json'])).toMatchObject({
      operation: 'preset',
      presetCommand: 'apply',
      presetSource: './preset.json',
    });
    expect(parseSetupArgs(['preset', 'update'])).toMatchObject({
      operation: 'preset',
      presetCommand: 'update',
    });
    expect(parseSetupArgs(['preset', 'status'])).toMatchObject({
      operation: 'preset',
      presetCommand: 'status',
    });
    expect(() => parseSetupArgs(['preset', 'status', 'extra'])).toThrow('preset requires');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runPreset = vi
      .fn()
      .mockResolvedValue({ ready: false, pending: [{ reason: 'BROWSER_SYNC_REQUIRED' }] });
    expect(await main(['preset', 'apply', './preset.json'], false, { runPreset })).toBe(3);
    expect(runPreset).toHaveBeenCalledExactlyOnceWith('apply', './preset.json');
    runPreset.mockResolvedValueOnce({ ready: true });
    expect(await main(['preset', 'status'], false, { runPreset })).toBe(0);
    runPreset.mockRejectedValueOnce(new Error('activation rejected'));
    expect(await main(['preset', 'update'], false, { runPreset })).toBe(1);
  });
  it('reapplies the saved preset and passes only explicitly listed replacements', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const runPreset = vi.fn().mockResolvedValue({ ready: true });
    const args = [
      'preset',
      'apply',
      '--replace-skill',
      'example-skill',
      '--replace-skill',
      'mearl',
    ];
    expect(parseSetupArgs(args)).toMatchObject({
      operation: 'preset',
      presetCommand: 'apply',
      presetReplaceSkills: ['example-skill', 'mearl'],
    });
    expect(await main(args, false, { runPreset })).toBe(0);
    expect(runPreset).toHaveBeenCalledExactlyOnceWith('apply', undefined, {
      replaceSkills: ['example-skill', 'mearl'],
    });
    runPreset
      .mockClear()
      .mockResolvedValue({ ready: false, pending: [{ reason: 'SKILL_NOT_INSTALLED' }] });
    expect(await main(['preset', 'apply'], false, { runPreset })).toBe(3);
    expect(runPreset).toHaveBeenCalledExactlyOnceWith('apply', undefined);
    runPreset.mockClear().mockResolvedValue({ ready: true });
    expect(await main(['preset', 'uninstall'], false, { runPreset })).toBe(0);
    expect(runPreset).toHaveBeenCalledExactlyOnceWith('uninstall', undefined);
  });
  it.each([
    ['preset', 'apply', '--replace-skill'],
    ['preset', 'apply', '--replace-skill', '../other'],
    ['preset', 'apply', '--replace-skill', 'mearl', '--replace-skill', 'mearl'],
    ['preset', 'apply', '--force'],
    ['preset', 'apply', './preset.json', '--replace-skill', 'mearl'],
    ['preset', 'apply', './preset.json', 'extra'],
    ['preset', 'uninstall', 'extra'],
    ['preset', 'repair'],
    ['preset', 'status', '--replace-skill', 'mearl'],
  ])('rejects invalid preset arguments before starting an installer: %j', async (...args) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runPreset = vi.fn();
    expect(await main(args, false, { runPreset })).toBe(2);
    expect(runPreset).not.toHaveBeenCalled();
  });
  it('documents apply options without running an installer', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const runPreset = vi.fn();
    expect(await main(['preset', 'apply', '--help'], false, { runPreset })).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('--replace-skill <name>'));
    expect(runPreset).not.toHaveBeenCalled();
  });
  it('delegates the selected preset to environment setup and checks actual readiness', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const revision = 'a'.repeat(64);
    const runLifecycle = vi.fn(async (_options, dependencies) => {
      dependencies.onPresetStatus({ revision, ready: true });
      return true;
    });
    const runPreset = vi.fn().mockResolvedValue({ revision, ready: true });
    const args = ['--preset', 'https://guide.example.test/presets/team.json', '--yes'];
    expect(parseSetupArgs(args)).toMatchObject({ operation: 'install', presetSource: args[1] });
    expect(() => parseSetupArgs(['uninstall', ...args])).toThrow('--preset is not available');
    expect(await main(args, false, { runLifecycle, runPreset })).toBe(0);
    expect(runLifecycle.mock.calls[0][0]).toMatchObject({ presetSource: args[1] });
    expect(runPreset.mock.calls).toEqual([['status']]);
    expect(runLifecycle.mock.invocationCallOrder[0]).toBeLessThan(
      runPreset.mock.invocationCallOrder[0],
    );
    runLifecycle.mockResolvedValueOnce(false);
    runPreset.mockClear();
    expect(await main(args, false, { runLifecycle, runPreset })).toBe(1);
    expect(runPreset).not.toHaveBeenCalled();
    runPreset.mockResolvedValue({ revision, ready: false });
    expect(await main(args, false, { runLifecycle, runPreset })).toBe(3);
  });
  it('parses and delegates Provider lifecycle commands', async () => {
    expect(
      parseSetupArgs(['provider', 'install', '@example/mearl-provider-device@next']),
    ).toMatchObject({
      operation: 'provider',
      providerCommand: 'install',
      providerTarget: '@example/mearl-provider-device@next',
    });
    expect(parseSetupArgs(['provider', 'update', 'example-device'])).toMatchObject({
      operation: 'provider',
      providerCommand: 'update',
      providerTarget: 'example-device',
    });
    expect(parseSetupArgs(['provider', 'uninstall', 'example-device'])).toMatchObject({
      operation: 'provider',
      providerCommand: 'uninstall',
      providerTarget: 'example-device',
    });
    expect(() => parseSetupArgs(['provider', 'install'])).toThrow('install <package>');
    expect(() => parseSetupArgs(['provider', 'list'])).toThrow(
      'provider requires install <package>, update <id>, or uninstall <id>',
    );

    const installProvider = vi.fn().mockResolvedValue({
      manager: 'npm',
      manifest: {
        providerId: 'example-device',
        packageName: '@example/mearl-provider-device',
        version: '0.2.0',
      },
    });
    const runLifecycle = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      main(['provider', 'install', '@example/mearl-provider-device@next'], false, {
        installProvider,
        runLifecycle,
      }),
    ).resolves.toBe(0);
    expect(installProvider).toHaveBeenCalledExactlyOnceWith('@example/mearl-provider-device@next');
    expect(runLifecycle).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      'Provider example-device installed: @example/mearl-provider-device@0.2.0 (npm)',
    );
  });

  it('passes plugin install arguments through, including flags owned by skills', async () => {
    const args = [
      'https://github.com/mearlhq/mearl',
      '--skill',
      'browser-tab-manager',
      '-a',
      'codex',
      '--yes',
      '--help',
    ];
    expect(parseSetupArgs(['plugin', 'install', ...args])).toMatchObject({
      operation: 'plugin',
      pluginInstallArgs: args,
      help: false,
    });
    const installPlugins = vi.fn().mockResolvedValue(7);
    expect(await main(['plugin', 'install', ...args], false, { installPlugins })).toBe(7);
    expect(installPlugins).toHaveBeenCalledExactlyOnceWith(args);
  });

  it('ensures an official plugin without entering the environment lifecycle', async () => {
    expect(parseSetupArgs(['plugin', 'ensure', 'identity'])).toMatchObject({
      operation: 'plugin',
      pluginEnsureName: 'identity',
    });
    expect(() => parseSetupArgs(['plugin', 'ensure'])).toThrow('exactly one official plugin name');
    const ensureOfficialPlugin = vi.fn().mockResolvedValue('installed');
    const runLifecycle = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      main(['plugin', 'ensure', 'identity'], false, { ensureOfficialPlugin, runLifecycle }),
    ).resolves.toBe(0);
    expect(ensureOfficialPlugin).toHaveBeenCalledExactlyOnceWith('identity');
    expect(runLifecycle).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('Official plugin identity installed.');
  });
  it('registers a plugin path with an inferred or explicit name', async () => {
    expect(parseSetupArgs(['plugin', './skill'])).toMatchObject({
      operation: 'plugin',
      pluginPath: './skill',
    });
    expect(parseSetupArgs(['plugin', 'tabs', './skill'])).toMatchObject({
      operation: 'plugin',
      pluginName: 'tabs',
      pluginPath: './skill',
    });
    expect(() => parseSetupArgs(['plugin'])).toThrow('requires <path>');
    expect(() => parseSetupArgs(['plugin', 'tabs', './skill', 'extra'])).toThrow();
    const registerPlugin = vi.fn().mockResolvedValue({
      entry: '/skills/browser-tab-manager/scripts/main.mjs',
      name: 'tabs',
    });
    const runLifecycle = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['plugin', './skill'], false, { registerPlugin, runLifecycle })).toBe(0);
    expect(registerPlugin).toHaveBeenCalledWith('./skill');
    expect(await main(['plugin', 'tabs', './skill'], false, { registerPlugin, runLifecycle })).toBe(
      0,
    );
    expect(registerPlugin).toHaveBeenCalledWith('./skill', 'tabs');
    expect(runLifecycle).not.toHaveBeenCalled();
    registerPlugin.mockRejectedValueOnce(new Error('entry missing'));
    expect(await main(['plugin', 'tabs', './skill'], false, { registerPlugin })).toBe(1);
  });
  it('uninstalls a plugin without entering the environment lifecycle', async () => {
    expect(parseSetupArgs(['plugin', 'uninstall', 'tabs'])).toMatchObject({
      operation: 'plugin',
      pluginUninstallName: 'tabs',
    });
    expect(() => parseSetupArgs(['plugin', 'uninstall'])).toThrow('exactly one plugin name');
    expect(() => parseSetupArgs(['plugin', 'uninstall', 'tabs', 'extra'])).toThrow(
      'exactly one plugin name',
    );
    const uninstallPlugin = vi.fn().mockResolvedValue({
      removed: true,
      skillName: 'browser-tab-manager',
      unregisteredNames: ['tabs'],
    });
    const runLifecycle = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await main(['plugin', 'uninstall', 'tabs'], false, { uninstallPlugin, runLifecycle }),
    ).toBe(0);
    expect(uninstallPlugin).toHaveBeenCalledExactlyOnceWith('tabs');
    expect(error).toHaveBeenCalledWith(
      'Plugin tabs uninstalled with skills skill browser-tab-manager.',
    );
    expect(runLifecycle).not.toHaveBeenCalled();
    uninstallPlugin.mockRejectedValueOnce(new Error('remove failed'));
    expect(await main(['plugin', 'uninstall', 'tabs'], false, { uninstallPlugin })).toBe(1);
  });
  it('defaults to install when the command is omitted', () => {
    expect(parseSetupArgs([])).toEqual({
      help: false,
      operation: 'install',
      skipSkill: false,
      targetLine: undefined,
      yes: false,
    });
    expect(parseSetupArgs(['--cloud', '--yes'])).toEqual({
      cloudMode: 'websocket',
      help: false,
      operation: 'install',
      profiles: ['cloud'],
      skipSkill: false,
      targetLine: undefined,
      yes: true,
    });
  });

  it('supports short and long help and version flags', () => {
    expect(parseSetupArgs(['-h'])).toMatchObject({ help: true });
    expect(parseSetupArgs(['--help'])).toMatchObject({ help: true });
    expect(parseSetupArgs(['-v'])).toMatchObject({ version: true });
    expect(parseSetupArgs(['--version'])).toMatchObject({ version: true });
  });

  it('leaves the install profile unset so lifecycle defaults it to local', () => {
    expect(parseSetupArgs(['install'])).toEqual({
      help: false,
      operation: 'install',
      skipSkill: false,
      targetLine: undefined,
      yes: false,
    });
  });

  it('accepts an explicit profile and confirmation bypass', () => {
    expect(parseSetupArgs(['uninstall', '--cloud', '--yes'])).toEqual({
      cloudMode: 'websocket',
      help: false,
      operation: 'uninstall',
      profiles: ['cloud'],
      skipSkill: false,
      targetLine: undefined,
      yes: true,
    });
  });

  it('limits lifecycle --full to uninstall', () => {
    expect(parseSetupArgs(['uninstall', '--full', '--yes'])).toEqual({
      full: true,
      help: false,
      operation: 'uninstall',
      skipSkill: false,
      targetLine: undefined,
      yes: true,
    });
    expect(() => parseSetupArgs(['install', '--full'])).toThrow('Unknown option');
    expect(() => parseSetupArgs(['update', '--full'])).toThrow('Unknown option');
  });

  it('accepts the descriptive non-interactive alias', () => {
    expect(parseSetupArgs(['install', '--non-interactive'])).toEqual({
      help: false,
      operation: 'install',
      skipSkill: false,
      targetLine: undefined,
      yes: true,
    });
  });

  it('accepts a release-line package-only local update', () => {
    expect(
      parseSetupArgs(['update', '--local', '--target-line', '2.4.x', '--skip-skill', '--yes']),
    ).toEqual({
      help: false,
      operation: 'update',
      profiles: ['local'],
      skipSkill: true,
      targetLine: '2.4.x',
      yes: true,
    });
  });

  it('parses browser extension installation as an independent command', () => {
    expect(parseSetupArgs(['extension'])).toEqual({
      help: false,
      operation: 'extension',
      skipSkill: false,
      yes: false,
    });
    expect(parseSetupArgs(['extension', '--yes'])).toMatchObject({
      operation: 'extension',
      yes: true,
    });
    expect(parseSetupArgs(['extension', '--force'])).toMatchObject({
      force: true,
      operation: 'extension',
      yes: false,
    });
    expect(parseSetupArgs(['extension', '--full', '--force'])).toMatchObject({
      force: true,
      full: true,
      operation: 'extension',
      yes: false,
    });
    expect(() => parseSetupArgs(['--force', '--yes', 'extension'])).toThrow('Unknown option');
    expect(() => parseSetupArgs(['extension', '--local'])).toThrow('Unknown option');
  });

  it('maps Qoder cloud onto the cloud profile with a mode marker', () => {
    expect(parseSetupArgs(['--cloud-mode', 'qoder'])).toEqual({
      cloudMode: 'qoder',
      help: false,
      operation: 'install',
      profiles: ['cloud'],
      skipSkill: false,
      targetLine: undefined,
      yes: false,
    });
    expect(parseSetupArgs(['--cloud-mode', 'qoder', '--yes'])).toMatchObject({
      operation: 'install',
      profiles: ['cloud'],
      cloudMode: 'qoder',
      yes: true,
    });
  });

  it('rejects malformed target versions', () => {
    expect(() => parseSetupArgs(['update', '--target-line', '2.4.0;echo unsafe'])).toThrow(
      '--target-line',
    );
  });

  it('accepts composable environment profiles', () => {
    expect(parseSetupArgs(['update', '--local', '--cloud'])).toMatchObject({
      operation: 'update',
      profiles: ['local', 'cloud'],
      cloudMode: 'websocket',
    });
  });

  it('rejects unknown operations and options', () => {
    expect(() => parseSetupArgs(['upgrade'])).toThrow('Unknown operation');
    expect(() => parseSetupArgs(['install', '--all'])).toThrow('Unknown option');
    expect(() => parseSetupArgs(['example-cloud'])).toThrow('Unknown operation');
    expect(parseSetupArgs(['--cloud-mode', 'qoder', '--cloud'])).toMatchObject({
      profiles: ['cloud'],
      cloudMode: 'qoder',
    });
    expect(() => parseSetupArgs(['qoder-cloud'])).toThrow('Unknown operation');
    expect(() => parseSetupArgs(['qoder'])).toThrow('Unknown operation');
  });

  it('fails before changing state when prompts are unavailable', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(main(['install'], false)).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith(
      'Non-interactive input detected. Re-run with --yes or --non-interactive.',
    );
  });

  it('prints help and version without running the lifecycle', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(main(['--help'], false)).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Mearl Setup'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('uninstall --full'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('extension --full'));

    log.mockClear();
    await expect(main(['-v'], false)).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(SETUP_VERSION);
  });

  it('keeps argument errors concise', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(main(['install', '--unknown'], true)).resolves.toBe(2);
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenNthCalledWith(1, expect.stringContaining('Unknown option'));
    expect(error).toHaveBeenNthCalledWith(2, `Run "${SETUP_COMMAND} --help" for usage.`);
  });

  it('passes full uninstall through to the lifecycle', async () => {
    const runLifecycle = vi.fn().mockResolvedValue(true);

    await expect(main(['uninstall', '--full', '--yes'], false, { runLifecycle })).resolves.toBe(0);
    expect(runLifecycle).toHaveBeenCalledWith({
      cloudMode: undefined,
      full: true,
      operation: 'uninstall',
      profiles: undefined,
      skipSkill: false,
      targetLine: undefined,
      yes: true,
    });
  });

  it('runs Qoder cloud through the ordinary cloud lifecycle', async () => {
    const runLifecycle = vi.fn().mockResolvedValue(true);

    await expect(main(['--cloud-mode', 'qoder', '--yes'], false, { runLifecycle })).resolves.toBe(
      0,
    );
    expect(runLifecycle).toHaveBeenCalledWith(
      {
        operation: 'install',
        profiles: ['cloud'],
        cloudMode: 'qoder',
        skipSkill: false,
        targetLine: undefined,
        yes: true,
      },
      { onPresetStatus: expect.any(Function) },
    );
  });

  it('downloads an unpacked extension in non-interactive mode for manual loading', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const path = '/home/test/.mearl/extension-downloads/mearl-v3.0.0-example';
    const downloadBrowserExtension = vi.fn().mockResolvedValue({ path, version: '3.0.0' });
    const installBrowserExtension = vi.fn();
    const runLifecycle = vi.fn();
    const dependencies = { downloadBrowserExtension, installBrowserExtension, runLifecycle };
    expect(await main(['extension', '--extract'], false, dependencies)).toBe(0);
    expect(downloadBrowserExtension).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(path));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Load unpacked'));
    expect(installBrowserExtension).not.toHaveBeenCalled();
    expect(runLifecycle).not.toHaveBeenCalled();
    for (const flag of ['--force', '--full']) {
      expect(await main(['extension', '--extract', flag], false, dependencies)).toBe(2);
    }
    expect(downloadBrowserExtension).toHaveBeenCalledOnce();
  });

  it('installs the latest browser extension through the independent command', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const installBrowserExtension = vi.fn().mockResolvedValue({
      extensionId: 'aoehhjnofngknnjefamjbplchbolghkm',
      loaded: true,
      path: '/home/test/.mearl/chrome-extension',
      version: '2.8.0',
      archiveUrl:
        'https://github.com/mearlhq/mearl/releases/download/v2.8.0/mearl-chrome-v2.8.0.zip',
    });

    await expect(main(['extension', '--force'], true, { installBrowserExtension })).resolves.toBe(
      0,
    );
    expect(installBrowserExtension).toHaveBeenCalledWith(
      expect.objectContaining({ force: true, waitForCdpMs: 120_000 }),
    );
    expect(error).toHaveBeenCalledWith(
      'Browser extension v2.8.0 installed or reloaded through CDP.',
    );

    installBrowserExtension.mockClear();
    await expect(
      main(['extension', '--force', '--yes'], false, { installBrowserExtension }),
    ).resolves.toBe(0);
    expect(installBrowserExtension).toHaveBeenCalledWith(
      expect.objectContaining({ force: true, waitForCdpMs: 0 }),
    );
  });

  it('installs the extension before the complete local environment with --full', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runLifecycle = vi.fn().mockResolvedValue(true);
    const installBrowserExtension = vi.fn().mockResolvedValue({
      extensionId: 'aoehhjnofngknnjefamjbplchbolghkm',
      loaded: true,
      path: '/home/test/.mearl/chrome-extension',
      version: '2.8.0',
      archiveUrl:
        'https://github.com/mearlhq/mearl/releases/download/v2.8.0/mearl-chrome-v2.8.0.zip',
    });

    await expect(
      main(['extension', '--full', '--yes'], false, {
        installBrowserExtension,
        runLifecycle,
      }),
    ).resolves.toBe(0);
    expect(runLifecycle).toHaveBeenCalledWith(
      {
        operation: 'install',
        profiles: ['local'],
        skipSkill: false,
        yes: true,
      },
      { onPresetStatus: expect.any(Function) },
    );
    expect(installBrowserExtension.mock.invocationCallOrder[0]).toBeLessThan(
      runLifecycle.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps the installed extension when the --full local environment step fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runLifecycle = vi.fn().mockResolvedValue(false);
    const installBrowserExtension = vi.fn().mockResolvedValue({
      extensionId: 'aoehhjnofngknnjefamjbplchbolghkm',
      loaded: true,
      path: '/home/test/.mearl/chrome-extension',
      version: '2.8.0',
      archiveUrl:
        'https://github.com/mearlhq/mearl/releases/download/v2.8.0/mearl-chrome-v2.8.0.zip',
    });

    await expect(
      main(['extension', '--full', '--yes'], false, {
        installBrowserExtension,
        runLifecycle,
      }),
    ).resolves.toBe(1);
    expect(installBrowserExtension).toHaveBeenCalledOnce();
    expect(installBrowserExtension.mock.invocationCallOrder[0]).toBeLessThan(
      runLifecycle.mock.invocationCallOrder[0]!,
    );
  });

  it('stops a non-interactive --full install when CDP is unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const runLifecycle = vi.fn().mockResolvedValue(true);
    const installBrowserExtension = vi.fn().mockResolvedValue({
      loaded: false,
      path: '/home/test/.mearl/chrome-extension',
      version: '2.8.0',
      archiveUrl:
        'https://github.com/mearlhq/mearl/releases/download/v2.8.0/mearl-chrome-v2.8.0.zip',
      cdpError: 'Chrome remote debugging is not enabled',
    });

    await expect(
      main(['extension', '--full', '--yes'], false, {
        installBrowserExtension,
        runLifecycle,
      }),
    ).resolves.toBe(1);
    expect(runLifecycle).not.toHaveBeenCalled();
  });

  it('reports the extension as not installed when CDP is unavailable', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const installBrowserExtension = vi.fn().mockResolvedValue({
      loaded: false,
      path: '/home/test/.mearl/chrome-extension',
      version: '2.8.0',
      archiveUrl:
        'https://github.com/mearlhq/mearl/releases/download/v2.8.0/mearl-chrome-v2.8.0.zip',
      cdpError: 'Chrome remote debugging is not enabled',
    });

    await expect(main(['extension', '--yes'], false, { installBrowserExtension })).resolves.toBe(1);
    expect(installBrowserExtension).toHaveBeenCalledWith(
      expect.objectContaining({ waitForCdpMs: 0 }),
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining('CDP installation failed'));
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Open chrome://inspect/#remote-debugging'),
    );
  });

  it('asks the user to update Chrome when extension installation through CDP is unsupported', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runLifecycle = vi.fn().mockResolvedValue(true);
    const installBrowserExtension = vi.fn().mockResolvedValue({
      loaded: false,
      path: '/home/test/.mearl/chrome-extension',
      version: '2.8.0',
      archiveUrl:
        'https://github.com/mearlhq/mearl/releases/download/v2.8.0/mearl-chrome-v2.8.0.zip',
      cdpError: "'Extensions.loadUnpacked' wasn't found",
    });

    await expect(
      main(['extension', '--full'], true, { installBrowserExtension, runLifecycle }),
    ).resolves.toBe(1);
    expect(runLifecycle).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Update Chrome to version 145'));
    expect(error).not.toHaveBeenCalledWith(
      expect.stringContaining('Open chrome://inspect/#remote-debugging'),
    );
  });
});

it('keeps text-mode lifecycle output concise while explicit status still returns JSON', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const revision = 'a'.repeat(64);
  const pending = { revision, ready: false, warnings: ['Browser synchronization pending'] };
  const runPreset = vi.fn().mockResolvedValue(pending);
  const runLifecycle = vi.fn(async (_options, dependencies) => {
    dependencies.onPresetStatus({ revision, ready: false });
    return true;
  });
  vi.stubEnv('MEARL_SETUP_STATUS_FORMAT', 'text');
  try {
    expect(await main(['--yes'], false, { runLifecycle, runPreset })).toBe(3);
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(pending.warnings[0]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('preset status'));
    expect(await main(['preset', 'status'], false, { runPreset })).toBe(3);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual(pending);
  } finally {
    vi.unstubAllEnvs();
  }
});

it('reports actual preset readiness after the base Skill phase and rejects a replaced selection', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const revision = 'a'.repeat(64);
  const runPreset = vi.fn().mockResolvedValueOnce({ revision, ready: false });
  const runLifecycle = vi.fn(async (_options, deps) => {
    deps.onPresetStatus({ revision, ready: true });
    return true;
  });
  expect(
    await main(['--preset', 'https://example.test/team.json', '--yes'], false, {
      runLifecycle,
      runPreset,
    }),
  ).toBe(3);
  runPreset.mockResolvedValueOnce({ revision: 'b'.repeat(64), ready: true });
  expect(
    await main(['--preset', 'https://example.test/team.json', '--yes'], false, {
      runLifecycle,
      runPreset,
    }),
  ).toBe(1);
});
