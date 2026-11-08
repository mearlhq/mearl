/**
 * mearl-mcp-uninstall - 卸载清理脚本
 *
 * 使用方式：
 *   npx @mearl/mcp-server --uninstall
 *   或 mearl-mcp-uninstall (如果全局安装)
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { platform } from 'os';
import { execFileSync } from 'child_process';
import prompts from 'prompts';
import { Command, CommanderError } from 'commander';
import { MCP_CLIENTS, MCPClientConfig } from './mcp-clients.js';
import { uninstallNativeHost } from '@mearl/native-host';

// 检查是否全局安装
function isGloballyInstalled(): boolean {
  try {
    const cmd = platform() === 'win32' ? 'where' : 'which';
    execFileSync(cmd, ['mearl-mcp-server'], { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export type MCPConfigCleanupResult = 'removed' | 'not-found' | 'failed';

function removeTomlMCPSection(content: string): string | null {
  const lines = content.split('\n');
  const sectionStart = lines.findIndex(line => line.trim() === '[mcp_servers.mearl]');
  if (sectionStart === -1) return null;

  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (lines[index].trim().startsWith('[')) {
      sectionEnd = index;
      break;
    }
  }
  return [...lines.slice(0, sectionStart), ...lines.slice(sectionEnd)].join('\n');
}

// 清理 MCP 配置文件中的 mearl
export function cleanMCPConfig(
  configPath: string,
  clientConfig: MCPClientConfig,
): MCPConfigCleanupResult {
  try {
    if (!existsSync(configPath)) {
      return 'not-found';
    }

    const content = readFileSync(configPath, 'utf-8');
    if (!content.trim()) return 'not-found';
    if (clientConfig.useTomlFormat) {
      const updated = removeTomlMCPSection(content);
      if (updated === null) return 'not-found';
      writeFileSync(configPath, updated);
      return 'removed';
    }

    const config = JSON.parse(content);

    const useServersFormat = clientConfig.useServersFormat;
    let hasConfig = false;

    if (useServersFormat) {
      // VS Code 格式：检查 servers
      if (config.servers && config.servers['mearl']) {
        delete config.servers['mearl'];
        hasConfig = true;
      }
    } else {
      // Claude Code/Cursor 格式：检查 mcpServers
      if (config.mcpServers && config.mcpServers['mearl']) {
        delete config.mcpServers['mearl'];
        hasConfig = true;
      }
    }

    if (!hasConfig) {
      return 'not-found';
    }

    // 写回文件
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    return 'removed';
  } catch (error) {
    console.error(
      `   ⚠️  清理配置失败 (${configPath}): ${error instanceof Error ? error.message : String(error)}`,
    );
    return 'failed';
  }
}

export interface MCPUninstallDependencies {
  cleanConfig?: typeof cleanMCPConfig;
  clients?: Record<string, MCPClientConfig>;
  exists?: typeof existsSync;
  globalInstallationDetected?: () => boolean;
  log?: (message: string) => void;
  logError?: (message: string) => void;
  prompt?: (options: {
    type: 'multiselect';
    name: 'clients';
    message: string;
    choices: Array<{ title: string; value: string }>;
    instructions: boolean;
    hint: string;
  }) => Promise<{ clients?: string[] }>;
  removeNativeHost?: typeof uninstallNativeHost;
}

export interface ParsedUninstallArgs {
  help: boolean;
  managedBySetup: boolean;
  yes: boolean;
}

export function parseUninstallArgs(argv: string[]): ParsedUninstallArgs {
  const program = new Command()
    .name('mearl-mcp-uninstall')
    .helpOption(false)
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} })
    .option('--managed-by-setup')
    .option('-y, --yes')
    .option('--non-interactive')
    .option('-h, --help');
  try {
    program.parse(['node', 'mearl-mcp-uninstall', ...argv]);
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new Error(error.message.replace(/^error:\s*/i, ''), { cause: error });
    }
    throw error;
  }
  const options = program.opts<{
    help?: boolean;
    managedBySetup?: boolean;
    nonInteractive?: boolean;
    yes?: boolean;
  }>();
  return {
    help: options.help === true,
    managedBySetup: options.managedBySetup === true,
    yes: options.yes === true || options.nonInteractive === true,
  };
}

// 卸载主函数
export async function runUninstall(
  argv: string[] = process.argv.slice(2),
  dependencies: MCPUninstallDependencies = {},
): Promise<boolean> {
  const parsed = parseUninstallArgs(argv);
  const log = dependencies.log ?? (message => console.log(message));
  const logError = dependencies.logError ?? (message => console.error(message));
  const removeNativeHost = dependencies.removeNativeHost ?? uninstallNativeHost;
  const detectGlobalInstallation = dependencies.globalInstallationDetected ?? isGloballyInstalled;
  const fileExists = dependencies.exists ?? existsSync;
  const clients = dependencies.clients ?? MCP_CLIENTS;
  const prompt = dependencies.prompt ?? prompts;
  const cleanConfig = dependencies.cleanConfig ?? cleanMCPConfig;
  if (parsed.help) {
    log(`Usage: mearl-mcp-uninstall [options]

Options:
  --managed-by-setup  Suppress global uninstall guidance
  --yes, -y           Clean every discovered client without prompting
  --non-interactive   Alias for --yes
  --help, -h          Show this help`);
    return true;
  }
  const { managedBySetup, yes } = parsed;

  log('🗑️  Mearl MCP 卸载\n');

  try {
    let completed = true;

    // 1. 清理 Native Messaging Host 配置
    log('清理 Native Messaging Host...');
    const nativeHostRemoved = await removeNativeHost({ mode: 'mcp', silent: true });
    log(
      nativeHostRemoved ? '✅ Native Messaging Host 已清理' : '⚠️  Native Messaging Host 清理失败',
    );
    completed = nativeHostRemoved;

    // 2. 检查全局安装
    if (!managedBySetup) {
      log('\n检查 npm 全局安装...');
      if (detectGlobalInstallation()) {
        log('⚠️  请手动卸载: npm uninstall -g @mearl/mcp-server');
      } else {
        log('✅ 未检测到全局安装');
      }
    }

    // 3. 清理 MCP 客户端配置
    log('\n清理 MCP 客户端配置...');

    // 检测哪些客户端有配置文件
    const availableClients = Object.entries(clients)
      .filter(([_, client]) => fileExists(client.configPath))
      .map(([key, client]) => ({
        title: client.name,
        value: key,
      }));

    if (availableClients.length === 0) {
      log('未找到 MCP 配置');
    } else {
      const selectedClients = yes
        ? availableClients.map(client => client.value)
        : (
            await prompt({
              type: 'multiselect',
              name: 'clients',
              message: '选择要清理的客户端:',
              choices: availableClients,
              instructions: false,
              hint: '空格选择，回车确认',
            })
          ).clients;

      if (selectedClients && selectedClients.length > 0) {
        for (const clientKey of selectedClients) {
          const client = clients[clientKey as keyof typeof clients];
          const result = cleanConfig(client.configPath, client);

          if (result === 'removed') {
            log(`✅ 已清理 ${client.name}`);
          } else if (result === 'not-found') {
            log(`未找到 ${client.name} 配置`);
          } else {
            completed = false;
          }
        }
      } else {
        log('已取消');
      }
    }

    if (completed) {
      log('\n✅ 卸载完成！');
    } else {
      logError('\n❌ 卸载未完整完成，请检查上述错误');
    }
    return completed;
  } catch (error: unknown) {
    logError(`\n❌ 卸载失败: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    return (await runUninstall(argv)) ? 0 : 1;
  } catch (error) {
    console.error(`Uninstall failed: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}
