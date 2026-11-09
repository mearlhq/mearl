#!/usr/bin/env node

import { Command, CommanderError } from 'commander';
import { invoke, listLiveBrowsers } from '@mearl/client/local';
import { parseProfileSource } from '@mearl/preset/bundles';
import {
  downloadMearlBrowserExtension,
  installMearlBrowserExtension,
  isUnsupportedCdpMethodError,
} from './browserExtension.js';
import {
  runMearlLifecycle,
  type MearlLifecycleOperation,
  type MearlLifecycleOptions,
} from './lifecycle.js';
import type { MearlProfile } from './profiles.js';
import { isMearlReleaseLine } from './version.js';
import { ensureOfficialPlugin, installPlugins, setupPlugin, uninstallPlugin } from './plugin.js';
import {
  installProviderPackage,
  uninstallProviderPackage,
  updateProviderPackage,
} from './provider.js';
import { runPresetCommand } from './preset.js';
import { prepareSetupPreset } from './setupPreset.js';

import { SETUP_VERSION, SETUP_COMMAND } from './setupVersion.js';
export { SETUP_VERSION } from './setupVersion.js';

interface ParsedArgs {
  cloudMode?: string;
  extract?: boolean;
  force?: boolean;
  full?: boolean;
  help: boolean;
  operation?: MearlLifecycleOperation | 'extension' | 'plugin' | 'provider' | 'preset' | 'profile';
  profileSource?: string;
  profileBrowser?: string;
  presetCommand?: Exclude<Parameters<typeof runPresetCommand>[0], 'repair'>;
  presetSource?: string;
  presetReplaceSkills?: string[];
  pluginName?: string;
  pluginPath?: string;
  pluginInstallArgs?: string[];
  pluginEnsureName?: string;
  pluginUninstallName?: string;
  providerCommand?: 'install' | 'uninstall' | 'update';
  providerTarget?: string;
  profiles?: MearlProfile[];
  skipSkill: boolean;
  targetLine?: string;
  version?: boolean;
  yes: boolean;
}

export interface SetupCliDependencies {
  installProfile?: typeof installProfile;
  preparePreset?: typeof prepareSetupPreset;
  runPreset?: typeof runPresetCommand;
  registerPlugin?: typeof setupPlugin;
  ensureOfficialPlugin?: typeof ensureOfficialPlugin;
  installPlugins?: typeof installPlugins;
  uninstallPlugin?: typeof uninstallPlugin;
  downloadBrowserExtension?: typeof downloadMearlBrowserExtension;
  installBrowserExtension?: typeof installMearlBrowserExtension;
  installProvider?: typeof installProviderPackage;
  runLifecycle?: typeof runMearlLifecycle;
  uninstallProvider?: typeof uninstallProviderPackage;
  updateProvider?: typeof updateProviderPackage;
}

interface LifecycleCommandOptions {
  cloud?: boolean;
  full?: boolean;
  local?: boolean;
  mcp?: boolean;
  nonInteractive?: boolean;
  cloudMode?: string;
  skipSkill?: boolean;
  preset?: string;
  targetLine?: string;
  yes?: boolean;
}

const baseParsedArgs = (): ParsedArgs => ({
  help: false,
  skipSkill: false,
  yes: false,
});

function commanderError(error: CommanderError): Error {
  const message = error.message.replace(/^error:\s*/i, '');
  if (error.code === 'commander.unknownCommand') {
    return new Error(message.replace(/^unknown command/i, 'Unknown operation'));
  }
  if (error.code === 'commander.unknownOption') {
    return new Error(message.replace(/^unknown option/i, 'Unknown option'));
  }
  return new Error(message);
}

export function parseSetupArgs(argv: string[]): ParsedArgs {
  if (argv[0] === 'profile') {
    if (argv.length === 2 && (argv[1] === '--help' || argv[1] === '-h'))
      return { ...baseParsedArgs(), help: true };
    if (
      argv[1] !== 'install' ||
      !argv[2] ||
      (argv.length !== 3 && !(argv.length === 5 && argv[3] === '--browser' && argv[4]))
    ) {
      throw new Error(
        'profile requires install <GitHub owner/repo[@ref] or HTTPS bundle URL> [--browser <id-or-name>]',
      );
    }
    parseProfileSource(argv[2]);
    return {
      ...baseParsedArgs(),
      operation: 'profile',
      profileSource: argv[2],
      profileBrowser: argv[4],
    };
  }
  if (argv[0] === 'preset') {
    if (argv.length === 2 && (argv[1] === '--help' || argv[1] === '-h'))
      return { ...baseParsedArgs(), help: true };
    if (argv[1] === 'apply') {
      const command = new Command('preset apply')
        .exitOverride()
        .configureOutput({ writeErr: () => {}, writeOut: () => {} })
        .allowExcessArguments(false)
        .argument('[source]')
        .option(
          '--replace-skill <name>',
          'Replace the named Skill source or conflicting plugin registration',
          (name: string, previous: string[]) => [...previous, name],
          [],
        );
      try {
        command.parse(argv.slice(2), { from: 'user' });
      } catch (error) {
        if (error instanceof CommanderError) {
          if (error.code === 'commander.helpDisplayed') return { ...baseParsedArgs(), help: true };
          throw commanderError(error);
        }
        throw error;
      }
      const names = command.opts<{ replaceSkill: string[] }>().replaceSkill;
      if (
        names.length > 256 ||
        new Set(names).size !== names.length ||
        names.some(name => !/^[a-z][a-z0-9-]{0,79}$/.test(name))
      )
        throw new Error('--replace-skill requires unique valid Skill names (up to 256)');
      const source = command.args[0];
      if (source !== undefined && !source.trim())
        throw new Error('Expected a preset source URL or path');
      if (source !== undefined && names.length)
        throw new Error('--replace-skill requires preset apply without a source');
      return {
        ...baseParsedArgs(),
        operation: 'preset',
        presetCommand: 'apply',
        presetSource: source,
        ...(names.length ? { presetReplaceSkills: names } : {}),
      };
    }
    if (
      (argv[1] === 'update' || argv[1] === 'status' || argv[1] === 'uninstall') &&
      argv.length === 2
    )
      return { ...baseParsedArgs(), operation: 'preset', presetCommand: argv[1] };
    throw new Error('preset requires apply [source-url-or-path], update, status, or uninstall');
  }
  if (argv[0] === 'provider') {
    const command = argv[1];
    if (
      (command === 'install' || command === 'update' || command === 'uninstall') &&
      argv.length === 3 &&
      argv[2]
    ) {
      return {
        ...baseParsedArgs(),
        operation: 'provider',
        providerCommand: command,
        providerTarget: argv[2],
      };
    }
    throw new Error('provider requires install <package>, update <id>, or uninstall <id>');
  }
  if (argv[0] === 'plugin' && argv[1] === 'install') {
    return { ...baseParsedArgs(), operation: 'plugin', pluginInstallArgs: argv.slice(2) };
  }
  if (argv[0] === 'plugin' && argv[1] === 'ensure') {
    if (argv.length !== 3 || !argv[2]) {
      throw new Error('plugin ensure requires exactly one official plugin name');
    }
    return { ...baseParsedArgs(), operation: 'plugin', pluginEnsureName: argv[2] };
  }
  if (argv[0] === 'plugin' && argv[1] === 'uninstall') {
    if (argv.length !== 3 || !argv[2]) {
      throw new Error('plugin uninstall requires exactly one plugin name');
    }
    return { ...baseParsedArgs(), operation: 'plugin', pluginUninstallName: argv[2] };
  }
  if (argv[0] === 'plugin') {
    if (argv.length === 2 && argv[1]) {
      return { ...baseParsedArgs(), operation: 'plugin', pluginPath: argv[1] };
    }
    if (argv.length === 3 && argv[1] && argv[2]) {
      return {
        ...baseParsedArgs(),
        operation: 'plugin',
        pluginName: argv[1],
        pluginPath: argv[2],
      };
    }
    throw new Error('plugin requires <path> or <name> <path>');
  }
  let parsed: ParsedArgs | undefined;
  const program = new Command()
    .name('mearl-setup')
    .version(SETUP_VERSION, '-v, --version')
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });

  const addLifecycleCommand = (operation: MearlLifecycleOperation): void => {
    const command = new Command(operation)
      .exitOverride()
      .configureOutput({ writeErr: () => {}, writeOut: () => {} })
      .option('--local')
      .option('--cloud')
      .option('--cloud-mode <id>')
      .option('--mcp')
      .option('--target-line <major.minor.x>')
      .option('--skip-skill')
      .option('--preset <source>')
      .option('-y, --yes')
      .option('--non-interactive');
    if (operation === 'uninstall') command.option('--full');
    command.action(() => {
      const options = command.opts<LifecycleCommandOptions>();

      if (options.cloudMode !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(options.cloudMode))
        throw new Error('--cloud-mode requires a valid installed mode ID');
      if (options.targetLine && !isMearlReleaseLine(options.targetLine)) {
        throw new Error('--target-line requires a valid Mearl release line such as 2.3.x');
      }
      if (operation === 'uninstall' && options.preset)
        throw new Error('--preset is not available for uninstall');
      if (options.preset !== undefined && !options.preset.trim())
        throw new Error('--preset requires a source');
      if (operation === 'uninstall' && options.targetLine) {
        throw new Error('--target-line is not available for uninstall');
      }
      const profiles: MearlProfile[] = [];
      if (options.local) profiles.push('local');
      if (options.cloud || options.cloudMode) profiles.push('cloud');
      if (options.mcp) profiles.push('mcp');
      parsed = {
        ...baseParsedArgs(),
        operation,
        ...(options.cloud || options.cloudMode
          ? { cloudMode: options.cloudMode ?? 'websocket' }
          : {}),
        ...(profiles.length > 0 ? { profiles } : {}),
        ...(options.full ? { full: true } : {}),
        skipSkill: options.skipSkill === true,
        targetLine: options.targetLine,
        ...(options.preset ? { presetSource: options.preset } : {}),
        yes: options.yes === true || options.nonInteractive === true,
      };
    });
    program.addCommand(command);
  };

  addLifecycleCommand('install');
  addLifecycleCommand('update');
  addLifecycleCommand('uninstall');

  const extension = new Command('extension')
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} })
    .option('--full')
    .option('--force')
    .option('--extract')
    .option('-y, --yes')
    .option('--non-interactive')
    .action(() => {
      const options = extension.opts<{
        extract?: boolean;
        force?: boolean;
        full?: boolean;
        nonInteractive?: boolean;
        yes?: boolean;
      }>();
      if (options.extract && (options.full || options.force)) {
        throw new Error('--extract cannot be combined with --full or --force');
      }
      parsed = {
        ...baseParsedArgs(),
        ...(options.extract ? { extract: true } : {}),
        ...(options.force ? { force: true } : {}),
        ...(options.full ? { full: true } : {}),
        operation: 'extension',
        yes: options.yes === true || options.nonInteractive === true,
      };
    });
  program.addCommand(extension);

  const normalizedArgv =
    argv[0] === undefined || argv[0].startsWith('-') ? ['install', ...argv] : argv;
  try {
    program.parse(['node', 'mearl-setup', ...normalizedArgv]);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === 'commander.helpDisplayed') return { ...baseParsedArgs(), help: true };
      if (error.code === 'commander.version') return { ...baseParsedArgs(), version: true };
      throw commanderError(error);
    }
    throw error;
  }
  if (!parsed) throw new Error('No setup operation was selected');
  return parsed;
}

function printHelp(): void {
  const output = `Mearl Setup v${SETUP_VERSION}

Usage:
  npx @mearl/setup [command] [options]

Environment commands:
  install [options]               Install an environment (default command; target: local)
  update [options]                Update detected or selected environments
  uninstall [options]             Uninstall detected or selected environments

Integration commands:
  profile install <source>       Install one App profile bundle in a connected extension
  preset apply [source]          Apply a URL or local file, or retry the saved snapshot
  preset update                  Update the selected preset, preserving user overrides
  preset status                  Report actual readiness (exit 3 when synchronization is pending)
  preset uninstall               Remove the preset from the local host and connected extensions
  plugin install <arguments...>   Install Skills and register their CLI plugins
  plugin uninstall <name>        Uninstall one CLI plugin
  plugin [name] <path>            Register an existing plugin; name overrides metadata
  provider install <package>      Install and register a Provider package
  provider update <id|package>    Update a registered Provider package
  provider uninstall <id|package> Uninstall a Provider package and registration

Browser extension:
  extension [--full] [--force]    Install or update the browser extension
  extension --extract            Download and unpack the extension for manual loading

Environment options:
  --local                         Manage @mearl/native-host and @mearl/client
  --cloud                         Manage cloud packages in WebSocket server mode
  --cloud-mode <id>                Manage cloud packages using an installed mode
  --mcp                           Manage @mearl/mcp-server and its configuration
  --target-line <major.minor.x>   Use the latest packages in one release line
  --preset <source>               Apply a preset after installing or updating the environment
  --skip-skill                    Keep the independently managed Mearl Skill unchanged

Uninstall options:
  --full                          Remove all CLI plugins and Provider packages/registrations

Extension options:
  --full                          Install the extension and complete local environment
  --force                         Replace an extension managed by another source

Preset apply options (without a source):
  --replace-skill <name>           Replace one Skill source or conflicting registration; repeat for more

General options:
  --yes, -y                       Accept prompts and detected defaults
  --non-interactive               Alias for --yes, intended for Agents and CI
  --version, -v                   Show version
  --help, -h                      Show this help

Examples:
  npx @mearl/setup
  npx @mearl/setup --cloud
  npx @mearl/setup --local --cloud
  npx @mearl/setup update
  npx @mearl/setup uninstall --full
  npx @mearl/setup plugin uninstall tabs
  npx @mearl/setup provider install @example/mearl-provider-device
  npx @mearl/setup preset apply --replace-skill example-skill
  npx @mearl/setup extension --full`;
  console.log(output.replaceAll('npx @mearl/setup', SETUP_COMMAND));
}

async function runSetupLifecycle(
  options: MearlLifecycleOptions,
  dependencies: SetupCliDependencies,
): Promise<number> {
  let preset: Awaited<ReturnType<typeof runPresetCommand>> | undefined;
  const callback =
    options.operation === 'uninstall'
      ? undefined
      : {
          onPresetStatus: (status: NonNullable<typeof preset>) => {
            preset = status;
          },
        };
  const lifecycle = dependencies.runLifecycle ?? runMearlLifecycle;
  const defaultPresetSource = process.env.MEARL_SETUP_DEFAULT_PRESET;
  const configured = defaultPresetSource ? { ...options, defaultPresetSource } : options;
  const ok = callback ? await lifecycle(configured, callback) : await lifecycle(configured);
  if (!ok) return 1;
  if (!preset) {
    if (options.presetSource) throw new Error('Preset preparation did not complete');
    return 0;
  }
  const actual = await (dependencies.runPreset ?? runPresetCommand)('status');
  if (actual.revision !== preset.revision)
    throw new Error('The selected preset changed while setup was running');
  const warnings = [...new Set([...(preset.warnings ?? []), ...(actual.warnings ?? [])])];
  if (process.env.MEARL_SETUP_STATUS_FORMAT === 'text') {
    for (const warning of warnings) console.error(warning);
    if (!actual.ready)
      console.error('Preset setup is pending. Run the installer with "preset status" for details.');
  } else {
    console.log(JSON.stringify({ ...actual, warnings }, null, 2));
  }
  return actual.ready ? 0 : 3;
}

async function installProfile(source: string, browser?: string): Promise<unknown> {
  if (!browser) {
    const extensions = listLiveBrowsers().filter(
      target =>
        target.transport === 'extension' &&
        (target.status === undefined || target.status === 'connected'),
    );
    if (extensions.length !== 1)
      throw new Error(
        extensions.length
          ? 'Multiple extensions are connected. Select one with --browser <id-or-name>.'
          : 'Connect a Mearl extension before installing App profiles.',
      );
    browser = extensions[0]!.browserId;
  }
  console.error('If the bundle source needs permission, confirm it in the browser.');
  return invoke('profile_install', { source }, { browser, timeoutSec: 150 });
}

export async function main(
  argv: string[] = process.argv.slice(2),
  interactiveTerminal = process.stdin.isTTY === true && process.stdout.isTTY === true,
  dependencies: SetupCliDependencies = {},
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseSetupArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`Run "${SETUP_COMMAND} --help" for usage.`);
    return 2;
  }
  if (parsed.help) {
    printHelp();
    return 0;
  }
  if (parsed.version) {
    console.log(SETUP_VERSION);
    return 0;
  }
  if (parsed.operation === 'profile') {
    try {
      const result = await (dependencies.installProfile ?? installProfile)(
        parsed.profileSource!,
        parsed.profileBrowser,
      );
      console.log(JSON.stringify(result, null, 2));
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (parsed.operation === 'preset') {
    try {
      const run = dependencies.runPreset ?? runPresetCommand;
      const result = parsed.presetReplaceSkills
        ? await run(parsed.presetCommand!, parsed.presetSource, {
            replaceSkills: parsed.presetReplaceSkills,
          })
        : await run(parsed.presetCommand!, parsed.presetSource);
      console.log(JSON.stringify(result, null, 2));
      return result.ready ? 0 : 3;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (parsed.operation === 'plugin') {
    try {
      if (parsed.pluginInstallArgs) {
        return await (dependencies.installPlugins ?? installPlugins)(parsed.pluginInstallArgs);
      }
      if (parsed.pluginEnsureName) {
        const result = await (dependencies.ensureOfficialPlugin ?? ensureOfficialPlugin)(
          parsed.pluginEnsureName,
        );
        console.error(
          result === 'installed'
            ? `Official plugin ${parsed.pluginEnsureName} installed.`
            : `Official plugin ${parsed.pluginEnsureName} is already registered.`,
        );
        return 0;
      }
      if (parsed.pluginUninstallName) {
        const result = await (dependencies.uninstallPlugin ?? uninstallPlugin)(
          parsed.pluginUninstallName,
        );
        if (!result.removed) {
          console.error(`Plugin ${parsed.pluginUninstallName} is not registered.`);
        } else if (result.skillName) {
          console.error(
            result.entryMissing
              ? `Plugin ${parsed.pluginUninstallName} had a missing entry; skills cleanup completed for ${result.skillName}.`
              : `Plugin ${parsed.pluginUninstallName} uninstalled with skills skill ${result.skillName}.`,
          );
          if (result.unregisteredNames.length > 1) {
            console.error(`Removed registrations: ${result.unregisteredNames.join(', ')}`);
          }
        } else {
          console.error(
            result.entryMissing
              ? `Plugin ${parsed.pluginUninstallName} stale registration removed; the external entry was already missing.`
              : `Plugin ${parsed.pluginUninstallName} unregistered; external skill files were kept.`,
          );
        }
        return 0;
      }
      const register = dependencies.registerPlugin ?? setupPlugin;
      const registration = parsed.pluginName
        ? await register(parsed.pluginPath!, parsed.pluginName)
        : await register(parsed.pluginPath!);
      console.error(`Plugin ${registration.name} registered: ${registration.entry}`);
      console.error(`Run: mearl ${registration.name} --help`);
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (parsed.operation === 'provider') {
    try {
      const target = parsed.providerTarget!;
      const result =
        parsed.providerCommand === 'install'
          ? await (dependencies.installProvider ?? installProviderPackage)(target)
          : parsed.providerCommand === 'update'
            ? await (dependencies.updateProvider ?? updateProviderPackage)(target)
            : await (dependencies.uninstallProvider ?? uninstallProviderPackage)(target);
      const verb =
        parsed.providerCommand === 'uninstall'
          ? 'uninstalled'
          : parsed.providerCommand === 'update'
            ? 'updated'
            : 'installed';
      console.error(
        `Provider ${result.manifest.providerId} ${verb}: ${result.manifest.packageName}@${result.manifest.version} (${result.manager})`,
      );
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (parsed.operation === 'extension') {
    if (parsed.extract) {
      try {
        const result = await (
          dependencies.downloadBrowserExtension ?? downloadMearlBrowserExtension
        )();
        console.log(`Mearl v${result.version} is ready to load from ${result.path}`);
        console.log(
          'Open chrome://extensions/, enable Developer mode, click Load unpacked, and select that directory.',
        );
        return 0;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }
    if (!interactiveTerminal && !parsed.yes) {
      console.error('Non-interactive input detected. Re-run with --yes or --non-interactive.');
      return 2;
    }
    if (parsed.full) {
      try {
        await (dependencies.preparePreset ?? prepareSetupPreset)({});
      } catch (error) {
        console.error(
          `Preset preparation: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 1;
      }
    }
    let extensionInstalled = false;
    let extensionFailureIsTerminal = false;
    try {
      const result = await (dependencies.installBrowserExtension ?? installMearlBrowserExtension)({
        force: parsed.force,
        waitForCdpMs: interactiveTerminal && !parsed.yes ? 120_000 : 0,
        writeLine: line => console.error(line),
      });
      if (result.loaded) {
        console.error(
          result.activation === 'native-host'
            ? `Browser extension v${result.version} updated and reloaded without CDP.`
            : `Browser extension v${result.version} installed or reloaded through CDP.`,
        );
        console.error(`Extension ID: ${result.extensionId}`);
        console.error(`Extension directory: ${result.path}`);
        extensionInstalled = true;
      } else {
        console.error(
          result.filesUpdated
            ? `Browser extension v${result.version} files were updated, but the extension was not reloaded.`
            : `Browser extension v${result.version} was not installed.`,
        );
        if (result.cdpError) {
          console.error(`CDP installation failed: ${result.cdpError}`);
          console.error(
            `To load the extension manually, run: ${SETUP_COMMAND} extension --extract`,
          );
          if (isUnsupportedCdpMethodError(result.cdpError)) {
            console.error(
              `This Chrome version does not support installing extensions through CDP. Update Chrome to version 145 or later, then rerun: ${SETUP_COMMAND} extension`,
            );
            extensionFailureIsTerminal = true;
          } else {
            console.error(
              `Open chrome://inspect/#remote-debugging, enable remote debugging, approve the connection, then rerun: ${SETUP_COMMAND} extension`,
            );
            extensionFailureIsTerminal = parsed.yes;
          }
        }
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    if (!parsed.full || extensionFailureIsTerminal) return extensionInstalled ? 0 : 1;

    let localStatus = 1;
    try {
      localStatus = await runSetupLifecycle(
        {
          operation: 'install',
          profiles: ['local'],
          skipSkill: false,
          yes: parsed.yes,
        },
        dependencies,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    return extensionInstalled ? localStatus : 1;
  }
  if (!interactiveTerminal && !parsed.yes && parsed.operation !== 'update') {
    console.error('Non-interactive input detected. Re-run with --yes or --non-interactive.');
    return 2;
  }
  try {
    const options = {
      operation: parsed.operation as MearlLifecycleOperation,
      profiles: parsed.profiles,
      cloudMode: parsed.cloudMode,
      full: parsed.full,
      skipSkill: parsed.skipSkill,
      targetLine: parsed.targetLine,
      yes: parsed.yes,
      ...(parsed.presetSource ? { presetSource: parsed.presetSource } : {}),
    };
    return await runSetupLifecycle(options, dependencies);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
