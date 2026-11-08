export type McpCliMode = 'server' | 'configure' | 'uninstall' | 'help' | 'version';

export interface ParsedMcpArgs {
  forwardedArgs: string[];
  mode: McpCliMode;
}

export async function parseMcpArgs(argv: string[]): Promise<ParsedMcpArgs> {
  if (argv.length === 0) return { forwardedArgs: [], mode: 'server' };
  const { Command, CommanderError } = await import('commander');
  const configureAlias = argv.includes('--configure');
  const uninstallAlias = argv.includes('--uninstall');
  if (configureAlias && uninstallAlias) {
    throw new Error('--configure and --uninstall cannot be used together');
  }
  const compatibilityMode = configureAlias ? 'configure' : uninstallAlias ? 'uninstall' : undefined;
  const normalizedArgv = compatibilityMode
    ? [compatibilityMode, ...argv.filter(arg => arg !== '--configure' && arg !== '--uninstall')]
    : argv;
  const program = new Command()
    .name('mearl-mcp-server')
    .helpOption(false)
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} })
    .argument('[command]')
    .option('--extension-id <id>')
    .option('--id <id>')
    .option('--skip-mcp')
    .option('--get')
    .option('--global-install')
    .option('--managed-by-setup')
    .option('-y, --yes')
    .option('--non-interactive')
    .option('-h, --help')
    .option('-v, --version');
  try {
    program.parse(['node', 'mearl-mcp-server', ...normalizedArgv]);
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new Error(error.message.replace(/^error:\s*/i, ''), { cause: error });
    }
    throw error;
  }
  const options = program.opts<{
    extensionId?: string;
    get?: boolean;
    globalInstall?: boolean;
    help?: boolean;
    id?: string;
    managedBySetup?: boolean;
    nonInteractive?: boolean;
    skipMcp?: boolean;
    version?: boolean;
    yes?: boolean;
  }>();
  if (options.help) return { forwardedArgs: [], mode: 'help' };
  if (options.version) return { forwardedArgs: [], mode: 'version' };
  const command = program.processedArgs[0] as string | undefined;
  if (command !== 'configure' && command !== 'uninstall') {
    throw new Error(command ? `Unknown command: ${command}` : 'configure or uninstall is required');
  }
  const configureOnly = [
    ['extensionId', '--extension-id'],
    ['id', '--id'],
    ['skipMcp', '--skip-mcp'],
    ['get', '--get'],
    ['globalInstall', '--global-install'],
  ] as const;
  const uninstallOnly = [['managedBySetup', '--managed-by-setup']] as const;
  const disallowed = command === 'configure' ? uninstallOnly : configureOnly;
  for (const [name, flag] of disallowed) {
    if (program.getOptionValueSource(name) === 'cli') {
      throw new Error(`${flag} is not available for ${command}`);
    }
  }
  if (options.extensionId && options.id && options.extensionId !== options.id) {
    throw new Error('--extension-id and --id cannot specify different values');
  }
  const forwardedArgs: string[] = [];
  if (command === 'configure') {
    const extensionId = options.extensionId ?? options.id;
    if (extensionId) forwardedArgs.push('--extension-id', extensionId);
    if (options.skipMcp) forwardedArgs.push('--skip-mcp');
    if (options.get) forwardedArgs.push('--get');
    if (options.globalInstall) forwardedArgs.push('--global-install');
  } else if (options.managedBySetup) {
    forwardedArgs.push('--managed-by-setup');
  }
  if (options.yes || options.nonInteractive) forwardedArgs.push('--yes');
  return { forwardedArgs, mode: command };
}
