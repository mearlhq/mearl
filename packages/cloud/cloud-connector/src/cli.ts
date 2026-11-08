import { Command, CommanderError, InvalidArgumentError } from 'commander';
import type { CloudConnectorOptions } from './index.js';
import { isConnectorEndpoint } from './endpoint.js';
import {
  startDaemon,
  stopDaemon,
  stopDaemonByPid,
  restartDaemon,
  statusDaemon,
  listDaemons,
  stopAllDaemons,
  printLogs,
  runForeground,
} from './daemon.js';

declare const __CLOUD_CONNECTOR_VERSION__: string;

const CLOUD_CONNECTOR_VERSION: string =
  typeof __CLOUD_CONNECTOR_VERSION__ !== 'undefined' ? __CLOUD_CONNECTOR_VERSION__ : 'unknown';

const SUBCOMMANDS = ['start', 'stop', 'restart', 'status', 'list', 'logs'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const CONNECTION_OPTION_NAMES = new Set([
  'foreground',
  'heartbeat',
  'reconnect',
  'maxReconnect',
  'connectorId',
  'name',
  'failFast',
]);

interface ConnectorCliOptions {
  all?: boolean;
  connectorId?: string;
  failFast?: boolean;
  foreground?: boolean;
  heartbeat?: number;
  help?: boolean;
  maxReconnect?: number;
  name?: string;
  reconnect?: number;
  version?: boolean;
}

export interface ParsedCloudConnectorArgs {
  command: Subcommand | null;
  daemonArgs: string[];
  foreground: boolean;
  help: boolean;
  options?: CloudConnectorOptions;
  serverUrl?: string;
  stopAll: boolean;
  stopPid?: number;
  version: boolean;
}

function showHelp(): void {
  console.error(`mearl-cloud-connector v${CLOUD_CONNECTOR_VERSION}

Usage:
  mearl-cloud-connector <server-url> [options]
  mearl-cloud-connector <command> [server-url|pid] [options]

Commands:
  start <server-url>         Start a background connector
  stop <server-url|pid>      Stop one registered background connector
  stop --all                 Stop every background connector
  restart <server-url>       Restart a background connector
  status [server-url]        Show one connector's status, or list all
  list                       List every running connector
  logs <server-url>          Print a connector's log

Options:
  --foreground, -f           Run directly instead of daemonizing
  --heartbeat <seconds>      Heartbeat interval (default: 30)
  --reconnect <ms>           Reconnect interval in ms (default: 5000)
  --max-reconnect <n>        Max reconnect attempts, -1 for unlimited
  --connector-id <id>        Override this machine's stable connector id
  --name <name>              Human-readable connector name
  --fail-fast                Exit if the first connection fails
  --version, -v              Show version
  --help, -h                 Show this help message
`);
}

function integerOption(label: string, minimum: number) {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum) {
      throw new InvalidArgumentError(`${label} must be an integer of at least ${minimum}`);
    }
    return parsed;
  };
}

function optionUsed(program: Command, name: string): boolean {
  return program.getOptionValueSource(name) === 'cli';
}

function parseConnectorPid(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

function assertAllowedOptions(program: Command, command: Subcommand | null): void {
  const allowed =
    command === null || command === 'start' || command === 'restart'
      ? CONNECTION_OPTION_NAMES
      : command === 'stop'
        ? new Set(['all'])
        : new Set<string>();
  for (const option of program.options) {
    const name = option.attributeName();
    if (optionUsed(program, name) && !allowed.has(name) && name !== 'help' && name !== 'version') {
      throw new Error(
        `${option.long ?? option.flags} is not available for ${command ?? 'foreground'}`,
      );
    }
  }
  if (command === 'restart' && optionUsed(program, 'foreground')) {
    throw new Error('--foreground is only available for start or a bare server-url');
  }
}

function connectorOptions(serverUrl: string, options: ConnectorCliOptions): CloudConnectorOptions {
  return {
    serverUrl,
    ...(options.heartbeat !== undefined ? { heartbeatInterval: options.heartbeat } : {}),
    ...(options.reconnect !== undefined ? { reconnectInterval: options.reconnect } : {}),
    ...(options.maxReconnect !== undefined ? { maxReconnectAttempts: options.maxReconnect } : {}),
    ...(options.connectorId !== undefined ? { connectorId: options.connectorId } : {}),
    ...(options.name !== undefined ? { connectorName: options.name } : {}),
    ...(options.failFast ? { failFast: true } : {}),
  };
}

function daemonArgs(program: Command, options: ConnectorCliOptions): string[] {
  const args: string[] = [];
  const add = (name: keyof ConnectorCliOptions, flag: string): void => {
    const value = options[name];
    if (optionUsed(program, String(name)) && value !== undefined) args.push(flag, String(value));
  };
  add('heartbeat', '--heartbeat');
  add('reconnect', '--reconnect');
  add('maxReconnect', '--max-reconnect');
  add('connectorId', '--connector-id');
  add('name', '--name');
  if (options.failFast) args.push('--fail-fast');
  return args;
}

export function parseCloudConnectorArgs(argv: string[]): ParsedCloudConnectorArgs {
  const program = new Command()
    .name('mearl-cloud-connector')
    .helpOption(false)
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} })
    .argument('[command-or-url]')
    .argument('[server-url]')
    .option('-f, --foreground')
    .option('--heartbeat <seconds>', 'heartbeat interval', integerOption('heartbeat', 1))
    .option('--reconnect <ms>', 'reconnect interval', integerOption('reconnect', 1))
    .option('--max-reconnect <n>', 'reconnect attempt limit', integerOption('max-reconnect', -1))
    .option('--connector-id <id>')
    .option('--name <name>')
    .option('--fail-fast')
    .option('--all')
    .option('-v, --version')
    .option('-h, --help');

  try {
    program.parse(['node', 'mearl-cloud-connector', ...argv]);
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new Error(error.message.replace(/^error:\s*/i, ''), { cause: error });
    }
    throw error;
  }

  const cliOptions = program.opts<ConnectorCliOptions>();
  if (cliOptions.help || cliOptions.version) {
    return {
      command: null,
      daemonArgs: [],
      foreground: false,
      help: cliOptions.help === true,
      stopAll: false,
      version: cliOptions.version === true,
    };
  }

  const first = program.processedArgs[0] as string | undefined;
  const second = program.processedArgs[1] as string | undefined;
  const bareEndpoint = first !== undefined && isConnectorEndpoint(first);
  if (first && !bareEndpoint && !(SUBCOMMANDS as readonly string[]).includes(first)) {
    throw new Error(`Unknown command: ${first}`);
  }
  const command = bareEndpoint || first === undefined ? null : (first as Subcommand);
  const target = bareEndpoint ? first : second;
  const stopPid = command === 'stop' && target ? parseConnectorPid(target) : undefined;
  const serverUrl = target && isConnectorEndpoint(target) ? target : undefined;
  if (target !== undefined && !serverUrl && stopPid === undefined) {
    throw new Error(
      command === 'stop'
        ? 'stop target must be a connector server-url, or a positive pid'
        : 'server-url must be a valid connector URL',
    );
  }
  assertAllowedOptions(program, command);
  if (command === null && !serverUrl) throw new Error('a command or server-url is required');
  if ((command === 'start' || command === 'restart' || command === 'logs') && !serverUrl) {
    throw new Error(`\`${command}\` requires a server-url`);
  }
  if (command === 'stop' && !serverUrl && stopPid === undefined && !cliOptions.all) {
    throw new Error('`stop` requires a server-url, pid, or --all');
  }
  if (command === 'stop' && (serverUrl || stopPid !== undefined) && cliOptions.all) {
    throw new Error('`stop` accepts either a server-url, pid, or --all, not both');
  }
  const foreground = command === null || cliOptions.foreground === true;
  return {
    command,
    daemonArgs: daemonArgs(program, cliOptions),
    foreground,
    help: false,
    ...(serverUrl ? { serverUrl } : {}),
    ...(foreground && serverUrl ? { options: connectorOptions(serverUrl, cliOptions) } : {}),
    stopAll: command === 'stop' && cliOptions.all === true,
    ...(stopPid === undefined ? {} : { stopPid }),
    version: false,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});

  if (argv.length === 0) {
    showHelp();
    return 1;
  }
  let parsed: ParsedCloudConnectorArgs;
  try {
    parsed = parseCloudConnectorArgs(argv);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    showHelp();
    return 2;
  }
  if (parsed.help) {
    showHelp();
    return 0;
  }
  if (parsed.version) {
    console.log(CLOUD_CONNECTOR_VERSION);
    return 0;
  }
  if (parsed.foreground) {
    console.log('[CloudConnector] Starting...');
    console.log(`[CloudConnector] Connecting to: ${parsed.serverUrl}`);
    runForeground(parsed.options!);
    return 0;
  }
  switch (parsed.command) {
    case 'start':
      await startDaemon(parsed.serverUrl!, parsed.daemonArgs);
      break;
    case 'stop':
      if (parsed.stopAll) await stopAllDaemons();
      else if (parsed.stopPid !== undefined) await stopDaemonByPid(parsed.stopPid);
      else await stopDaemon(parsed.serverUrl!);
      break;
    case 'restart':
      await restartDaemon(parsed.serverUrl!, parsed.daemonArgs);
      break;
    case 'status':
      statusDaemon(parsed.serverUrl);
      break;
    case 'list':
      listDaemons();
      break;
    case 'logs':
      printLogs(parsed.serverUrl!);
      break;
  }
  return 0;
}
