import { capabilityDirectory } from '@mearl/daemon-core/page-runtimes';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import type { CloudServerOptions } from './index.js';
import {
  startDaemon,
  stopDaemon,
  restartDaemon,
  statusDaemon,
  printLogs,
  runForeground,
  isDaemonRunning,
} from './daemon.js';
import { resolveCloudServerMode } from './mode.js';
import { NodeCapabilityRegistry } from '@mearl/daemon-core/capabilities';
type CloudServerCommand = 'start' | 'stop' | 'restart' | 'status' | 'logs';

declare const __CLOUD_SERVER_VERSION__: string;

const CLOUD_SERVER_VERSION: string =
  typeof __CLOUD_SERVER_VERSION__ !== 'undefined' ? __CLOUD_SERVER_VERSION__ : 'unknown';

const COMMANDS = ['start', 'stop', 'restart', 'status', 'logs'] as const;
const START_OPTION_NAMES = new Set([
  'foreground',
  'port',
  'agentPort',
  'path',
  'token',
  'heartbeat',
  'maxConnections',
  'allowRemoteAgent',
]);

interface CloudServerCliOptions {
  agentPort?: number;
  allowRemoteAgent?: boolean;
  foreground?: boolean;
  heartbeat?: number;
  help?: boolean;
  maxConnections?: number;
  path?: string;
  port?: number;
  token?: string;
  version?: boolean;
}

export interface ParsedCloudServerArgs {
  command: CloudServerCommand;
  daemonArgs: string[];
  foreground: boolean;
  help: boolean;
  options: CloudServerOptions;
  version: boolean;
}

function showHelp(): void {
  console.log(`mearl-cloud-server v${CLOUD_SERVER_VERSION}

Usage:
  mearl-cloud-server [command] [options]

Commands:
  start                      Start the server in the background (default)
  stop                       Stop the background server
  restart                    Restart the background server
  status                     Show whether the server is running + connect info
  logs                       Print the tail of the server log

Options:
  --foreground, -f           Run start in the foreground instead of daemonizing
  --port <port>              Connector (network) port (default: 8080)
  --agent-port <port>        Agent port, bound to 127.0.0.1 only (default: port + 1)
  --path <path>              WebSocket path (default: /ws)
  --token <token>            Authentication token (auto-generated if not specified)
  --heartbeat <seconds>      Heartbeat timeout in seconds (default: 90)
  --max-connections <n>      Max concurrent connections (default: 100)
  --allow-remote-agent       Allow command-issuing agents to connect from the network
  --version, -v              Show version
  --help, -h                 Show this help message
`);
}

function integerOption(label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new InvalidArgumentError(`${label} must be an integer from ${minimum} to ${maximum}`);
    }
    return parsed;
  };
}

function optionUsed(program: Command, name: string): boolean {
  return program.getOptionValueSource(name) === 'cli';
}

function assertAllowedOptions(program: Command, command: CloudServerCommand): void {
  const allowed = command === 'start' || command === 'restart' ? START_OPTION_NAMES : new Set();
  for (const option of program.options) {
    const name = option.attributeName();
    if (optionUsed(program, name) && !allowed.has(name) && name !== 'help' && name !== 'version') {
      throw new Error(`${option.long ?? option.flags} is not available for ${command}`);
    }
  }
  if (command === 'restart' && optionUsed(program, 'foreground')) {
    throw new Error('--foreground is only available for start');
  }
}

function daemonArgs(program: Command, options: CloudServerCliOptions): string[] {
  const args: string[] = [];
  const add = (name: keyof CloudServerCliOptions, flag: string): void => {
    const value = options[name];
    if (optionUsed(program, String(name)) && value !== undefined) args.push(flag, String(value));
  };
  add('port', '--port');
  add('agentPort', '--agent-port');
  add('path', '--path');
  add('token', '--token');
  add('heartbeat', '--heartbeat');
  add('maxConnections', '--max-connections');
  if (options.allowRemoteAgent) args.push('--allow-remote-agent');
  return args;
}

export function parseCloudServerArgs(argv: string[]): ParsedCloudServerArgs {
  const program = new Command()
    .name('mearl-cloud-server')
    .helpOption(false)
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} })
    .argument('[command]')
    .option('-f, --foreground')
    .option('--port <port>', 'connector port', integerOption('port', 1, 65_535))
    .option('--agent-port <port>', 'agent port', integerOption('agent-port', 1, 65_535))
    .option('--path <path>')
    .option('--token <token>')
    .option('--heartbeat <seconds>', 'heartbeat timeout', integerOption('heartbeat', 1))
    .option('--max-connections <n>', 'connection limit', integerOption('max-connections', 1))
    .option('--allow-remote-agent')
    .option('-v, --version')
    .option('-h, --help');

  try {
    program.parse(['node', 'mearl-cloud-server', ...argv]);
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new Error(error.message.replace(/^error:\s*/i, ''), { cause: error });
    }
    throw error;
  }

  const cliOptions = program.opts<CloudServerCliOptions>();
  if (cliOptions.help || cliOptions.version) {
    return {
      command: 'start',
      daemonArgs: [],
      foreground: false,
      help: cliOptions.help === true,
      options: {},
      version: cliOptions.version === true,
    };
  }

  const commandArg = program.processedArgs[0] as string | undefined;
  if (commandArg && !(COMMANDS as readonly string[]).includes(commandArg)) {
    throw new Error(`Unknown command: ${commandArg}`);
  }
  const command = (commandArg ?? 'start') as CloudServerCommand;
  assertAllowedOptions(program, command);
  if (cliOptions.token !== undefined && cliOptions.token.length === 0) {
    throw new Error('--token requires a non-empty value');
  }
  const options: CloudServerOptions = {
    ...(cliOptions.port !== undefined ? { port: cliOptions.port } : {}),
    ...(cliOptions.agentPort !== undefined ? { agentPort: cliOptions.agentPort } : {}),
    ...(cliOptions.path !== undefined ? { path: cliOptions.path } : {}),
    ...(cliOptions.token !== undefined
      ? { token: cliOptions.token }
      : process.env.MEARL_TOKEN
        ? { token: process.env.MEARL_TOKEN }
        : {}),
    ...(cliOptions.heartbeat !== undefined ? { heartbeatTimeout: cliOptions.heartbeat } : {}),
    ...(cliOptions.maxConnections !== undefined
      ? { maxConnections: cliOptions.maxConnections }
      : {}),
    ...(cliOptions.allowRemoteAgent ? { allowRemoteAgent: true } : {}),
  };
  return {
    command,
    daemonArgs: daemonArgs(program, cliOptions),
    foreground: cliOptions.foreground === true,
    help: false,
    options,
    version: false,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed: ParsedCloudServerArgs;
  try {
    parsed = parseCloudServerArgs(argv);
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
    console.log(CLOUD_SERVER_VERSION);
    return 0;
  }

  const mode = resolveCloudServerMode();
  if (mode !== 'websocket') {
    const hook = `cloud.server.${mode}`;
    const registry = new NodeCapabilityRegistry({ version: CLOUD_SERVER_VERSION }, capabilityDirectory(), { hooks: [hook] });
    await registry.refresh();
    await registry.require(hook)(parsed.command, {
      isServerRunning: isDaemonRunning,
      stopServer: stopDaemon,
      printStatus: statusDaemon,
      printLogs,
    });
    return 0;
  }
  if (parsed.foreground) {
    await runForeground(parsed.options);
    return 0;
  }
  switch (parsed.command) {
    case 'start':
      await startDaemon(parsed.daemonArgs);
      break;
    case 'stop':
      await stopDaemon();
      break;
    case 'restart':
      await restartDaemon(parsed.daemonArgs);
      break;
    case 'status':
      statusDaemon();
      break;
    case 'logs':
      printLogs();
      break;
  }
  return 0;
}
