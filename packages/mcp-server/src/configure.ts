/**
 * mearl-mcp-configure - 配置 Native Messaging Host 和 MCP 客户端
 *
 * 使用方式：
 *   mearl-mcp-configure                              # 交互式配置（会询问是否使用自定义 Extension ID）
 *   mearl-mcp-configure --extension-id=YOUR_ID       # 直接指定自定义 Extension ID
 *   mearl-mcp-configure --yes                        # 配置所有已检测客户端，不询问
 *   mearl-mcp-configure --skip-mcp                   # 跳过 MCP 配置
 *   mearl-mcp-configure --get                        # 查看当前配置
 */

import { installNativeHost, resolveHostDir } from '@mearl/native-host';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'node:path';
import { HOST_NAME, DEFAULT_EXTENSION_ID } from './constants.js';
import prompts from 'prompts';
import { Command, CommanderError } from 'commander';
import {
  MCP_CLIENTS,
  getMCPServerConfig,
  MCPClientConfig,
  isNpxMode,
  isClientInstalled,
} from './mcp-clients.js';

// 日志输出
const log = (...args: any[]) => {
  console.log('[Configure]', ...args);
};

export interface ConfigureArgs {
  extensionId?: string;
  get: boolean;
  globalInstall: boolean;
  help: boolean;
  skipMcp: boolean;
  yes: boolean;
}

class ConfigureUsageError extends Error {
  override name = 'ConfigureUsageError';
}

export function parseConfigureArgs(args: string[] = process.argv.slice(2)): ConfigureArgs {
  const program = new Command()
    .name('mearl-mcp-configure')
    .helpOption(false)
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} })
    .option('--extension-id <id>')
    .option('--id <id>')
    .option('--skip-mcp')
    .option('--get')
    .option('--global-install')
    .option('-y, --yes')
    .option('--non-interactive')
    .option('-h, --help');
  try {
    program.parse(['node', 'mearl-mcp-configure', ...args]);
  } catch (error) {
    if (error instanceof CommanderError) {
      throw new ConfigureUsageError(error.message.replace(/^error:\s*/i, ''), { cause: error });
    }
    throw error;
  }
  const options = program.opts<{
    extensionId?: string;
    get?: boolean;
    globalInstall?: boolean;
    help?: boolean;
    id?: string;
    nonInteractive?: boolean;
    skipMcp?: boolean;
    yes?: boolean;
  }>();
  if (options.extensionId && options.id && options.extensionId !== options.id) {
    throw new ConfigureUsageError('--extension-id and --id cannot specify different values');
  }
  return {
    extensionId: options.extensionId ?? options.id,
    get: options.get === true,
    globalInstall: options.globalInstall === true,
    help: options.help === true,
    skipMcp: options.skipMcp === true,
    yes: options.yes === true || options.nonInteractive === true,
  };
}

function printConfigureHelp(): void {
  console.log(`Usage: mearl-mcp-configure [options]

Options:
  --extension-id <id>  Configure a custom extension ID
  --skip-mcp           Skip MCP client configuration
  --get                Print current configuration
  --global-install     Use the globally installed command
  --yes, -y            Configure detected clients without prompts
  --non-interactive    Alias for --yes
  --help, -h           Show this help`);
}

// 替换或追加 TOML 中的 mcp_servers.xxx 节
function replaceTOMLSection(
  content: string,
  serverName: string,
  newSectionLines: string[],
): string {
  const header = `[mcp_servers.${serverName}]`;
  const lines = content.split('\n');

  let sectionStart = -1;
  let sectionEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === header) {
      sectionStart = i;
    } else if (sectionStart !== -1 && i > sectionStart && trimmed.startsWith('[')) {
      sectionEnd = i;
      break;
    }
  }

  if (sectionStart === -1) {
    const separator = content.length === 0 || content.endsWith('\n') ? '\n' : '\n\n';
    return content + separator + newSectionLines.join('\n') + '\n';
  }

  const before = lines.slice(0, sectionStart);
  const after = lines.slice(sectionEnd);
  return [...before, ...newSectionLines, '', ...after].join('\n');
}

// 添加或更新 Codex TOML 配置
function updateTomlMCPConfig(configPath: string, useNpx: boolean): boolean {
  try {
    const dir = dirname(configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    let content = '';
    if (existsSync(configPath)) {
      content = readFileSync(configPath, 'utf-8');
    }

    const sectionLines = ['[mcp_servers.mearl]', 'type = "stdio"'];
    if (useNpx) {
      sectionLines.push('command = "npx"');
      sectionLines.push(`args = ${JSON.stringify(getMCPServerConfig(false, true).args)}`);
    } else {
      sectionLines.push('command = "mearl-mcp-server"');
    }

    content = replaceTOMLSection(content, 'mearl', sectionLines);
    writeFileSync(configPath, content);
    return true;
  } catch (error) {
    console.error(`   ❌ 配置失败: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// 添加或更新 MCP 配置
function updateMCPConfig(
  configPath: string,
  clientConfig: MCPClientConfig,
  useNpx: boolean,
): boolean {
  if (clientConfig.useTomlFormat) {
    return updateTomlMCPConfig(configPath, useNpx);
  }
  try {
    // 确保目录存在
    const dir = dirname(configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const useServersFormat = clientConfig.useServersFormat;

    // 读取或创建配置文件
    let config: any;
    if (useServersFormat) {
      // VS Code 格式
      config = { inputs: [], servers: {} };
      if (existsSync(configPath)) {
        try {
          const content = readFileSync(configPath, 'utf-8');
          config = JSON.parse(content);
          if (!config.servers) {
            config.servers = {};
          }
          if (!config.inputs) {
            config.inputs = [];
          }
        } catch (error) {
          console.error(
            `   ⚠️  配置文件格式错误，将创建新配置: ${error instanceof Error ? error.message : String(error)}`,
          );
          config = { inputs: [], servers: {} };
        }
      }
      // 添加或更新 mearl 配置
      config.servers['mearl'] = getMCPServerConfig(true, useNpx);
    } else {
      // Claude Code/Cursor 格式
      config = { mcpServers: {} };
      if (existsSync(configPath)) {
        try {
          const content = readFileSync(configPath, 'utf-8');
          config = JSON.parse(content);
          if (!config.mcpServers) {
            config.mcpServers = {};
          }
        } catch (error) {
          console.error(
            `   ⚠️  配置文件格式错误，将创建新配置: ${error instanceof Error ? error.message : String(error)}`,
          );
          config = { mcpServers: {} };
        }
      }
      // 添加或更新 mearl 配置
      config.mcpServers['mearl'] = getMCPServerConfig(false, useNpx);
    }

    // 写回文件
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    console.error(`   ❌ 配置失败: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
// 查看当前配置
function showCurrentConfig() {
  console.log('📋 当前 Native Messaging 配置\n');

  try {
    const manifestPath = join(resolveHostDir(), `${HOST_NAME}.json`);

    if (!existsSync(manifestPath)) {
      console.log('❌ 未找到配置文件');
      console.log(`   路径: ${manifestPath}`);
      console.log('\n💡 运行 "mearl-mcp-configure" 进行配置\n');
      return;
    }

    const content = readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(content);

    console.log('✅ 配置文件已存在');
    console.log(`📍 路径: ${manifestPath}\n`);
    console.log('📝 配置内容:');
    console.log(`   Name: ${manifest.name}`);
    console.log(`   Path: ${manifest.path}`);
    console.log(`   Type: ${manifest.type}`);

    if (manifest.allowed_origins && manifest.allowed_origins.length > 0) {
      console.log('\n🔑 允许的扩展 ID:');
      manifest.allowed_origins.forEach((origin: string) => {
        const match = origin.match(/chrome-extension:\/\/([^/]+)\//);
        if (match) {
          console.log(`   ${match[1]}`);
        }
      });
    }

    // 检查 wrapper 脚本是否存在
    if (existsSync(manifest.path)) {
      console.log('\n✅ Wrapper 脚本存在');
    } else {
      console.log('\n⚠️  Wrapper 脚本不存在，需要重新配置');
    }

    console.log('');
  } catch (error) {
    console.error('❌ 读取配置失败:', error instanceof Error ? error.message : String(error));
    console.log('\n💡 运行 "mearl-mcp-configure" 重新配置\n');
  }
}

export function shouldUseNpx(
  globalInstall: boolean,
  detectNpxMode: () => boolean = isNpxMode,
): boolean {
  return !globalInstall && detectNpxMode();
}

export async function runConfigure(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { extensionId, get, globalInstall, help, skipMcp, yes } = parseConfigureArgs(argv);
  if (help) {
    printConfigureHelp();
    return;
  }

  // 如果是查看配置，显示后退出
  if (get) {
    showCurrentConfig();
    return;
  }

  console.log('🔧 Mearl MCP 配置\n');

  // 检测 npx 模式
  const useNpx = shouldUseNpx(globalInstall);
  if (useNpx) {
    log('检测到 npx 模式，将生成 npx 配置');
  } else if (globalInstall) {
    log('使用全局 mearl-mcp-server 命令生成配置');
  }

  // 配置 Native Messaging Host
  console.log('\n📦 配置 Chrome Native Messaging Host...');

  // Install both host manifests so MCP and Skills integrations can be used at
  // the same time (they share the same Unix socket and handlers).
  const nativeHostInstalled = await installNativeHost({
    mode: 'both',
    extensionId: extensionId || process.env.MEARL_EXTENSION_ID || DEFAULT_EXTENSION_ID,
    silent: true,
  });
  if (!nativeHostInstalled) {
    throw new Error('Native Messaging Host 配置失败');
  }

  console.log('✅ 配置完成\n');

  // 配置 MCP 客户端
  if (skipMcp) {
    console.log('跳过 MCP 客户端配置\n');
  } else {
    // 列出全部支持的客户端，已检测到安装的默认预选
    const allClients = Object.entries(MCP_CLIENTS).map(([key, client]) => {
      const selected = isClientInstalled(key);
      return {
        title: selected ? `${client.name} ✓` : client.name,
        value: key,
        selected,
      };
    });
    const detectedClients = allClients.filter(client => client.selected);
    const detectedNames = detectedClients.map(client => client.title);
    let selectedClients: string[] | undefined;

    if (yes) {
      if (detectedClients.length === 0) {
        throw new Error('未检测到可配置的 MCP 客户端；请交互式运行 mearl-mcp-configure 进行选择');
      }
      selectedClients = detectedClients.map(client => client.value);
      console.log(`\n将配置已检测到的客户端: ${detectedNames.join(', ')}\n`);
    } else {
      const response = await prompts({
        type: 'confirm',
        name: 'setupMcp',
        message: '配置 MCP 客户端？',
        initial: true,
      });

      if (response.setupMcp === undefined) {
        throw new Error('MCP 客户端配置已取消');
      }
      if (response.setupMcp) {
        if (detectedNames.length > 0) {
          console.log(`\n已检测到: ${detectedNames.join(', ')}\n`);
        } else {
          console.log('\n未检测到已安装的客户端，可手动选择\n');
        }

        const clientResponse = await prompts({
          type: 'multiselect',
          name: 'clients',
          message: '选择要配置的客户端:',
          choices: allClients,
          instructions: false,
          hint: '空格选择，回车确认',
        });
        selectedClients = clientResponse.clients;
        if (!selectedClients || selectedClients.length === 0) {
          throw new Error('未选择要配置的 MCP 客户端');
        }
      } else {
        console.log('跳过 MCP 客户端配置\n');
      }
    }

    if (selectedClients && selectedClients.length > 0) {
      console.log('');
      let configured = true;
      for (const clientKey of selectedClients) {
        const client = MCP_CLIENTS[clientKey as keyof typeof MCP_CLIENTS];
        if (updateMCPConfig(client.configPath, client, useNpx)) {
          console.log(`✅ ${client.name}`);
        } else {
          configured = false;
          console.log(`❌ ${client.name} 配置失败`);
        }
      }
      console.log('');
      if (!configured) {
        throw new Error('部分 MCP 客户端配置失败');
      }
    }
  }

  console.log('\n✅ 全部配置完成！');
  console.log('\n💡 后续步骤:');
  console.log('   1. 重启 MCP 客户端');
  console.log('   2. 打开需要调试的页面');
  console.log('   3. 在 AI 中测试: "获取最近 5 个请求"\n');
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    await runConfigure(argv);
    return 0;
  } catch (error) {
    console.error(
      `Configuration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return error instanceof ConfigureUsageError ? 2 : 1;
  }
}
