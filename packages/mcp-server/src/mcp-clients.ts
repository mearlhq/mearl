/**
 * MCP 客户端配置定义
 */

import { join, dirname } from 'path';
import { homedir, platform } from 'os';
import { existsSync } from 'fs';
import { OFFICIAL_NPM_REGISTRY } from '@mearl/setup/npm-registry';

export interface MCPClientConfig {
  name: string;
  configPath: string;
  // VS Code 使用 servers 格式，其他使用 mcpServers 格式
  useServersFormat?: boolean;
  // Codex 使用 TOML 格式
  useTomlFormat?: boolean;
}

/**
 * 获取跨平台的配置文件路径
 * @param paths 不同平台的路径配置
 * @returns 当前平台对应的完整路径
 */
function getPlatformConfigPath(paths: { win32?: string; darwin?: string; linux?: string }): string {
  const os = platform();
  const basePath = homedir();

  if (os === 'win32' && paths.win32) {
    return join(basePath, paths.win32);
  } else if (os === 'darwin' && paths.darwin) {
    return join(basePath, paths.darwin);
  } else if (paths.linux) {
    return join(basePath, paths.linux);
  }

  // Fallback: 使用 darwin 路径作为默认
  return join(basePath, paths.darwin || paths.linux || paths.win32 || '');
}

export const MCP_CLIENTS: Record<string, MCPClientConfig> = {
  'vscode-copilot': {
    name: 'VSCode Copilot',
    configPath: getPlatformConfigPath({
      win32: join(process.env.APPDATA || '', 'Code/User/mcp.json'),
      darwin: 'Library/Application Support/Code/User/mcp.json',
      linux: '.config/Code/User/mcp.json',
    }),
    useServersFormat: true,
  },
  'claude-code': {
    name: 'Claude Code',
    configPath: getPlatformConfigPath({
      win32: join(process.env.APPDATA || '', 'Claude Code/mcp_config.json'),
      darwin: '.config/claude-code/mcp_config.json',
      linux: '.config/claude-code/mcp_config.json',
    }),
  },
  cursor: {
    name: 'Cursor',
    configPath: getPlatformConfigPath({
      win32: join(process.env.APPDATA || '', 'Cursor/mcp_config.json'),
      darwin: '.cursor/mcp_config.json',
      linux: '.cursor/mcp_config.json',
    }),
  },
  qoder: {
    name: 'Qoder',
    configPath: getPlatformConfigPath({
      win32: join(process.env.APPDATA || '', 'Qoder/mcp_config.json'),
      darwin: 'Library/Application Support/Qoder/mcp_config.json',
      linux: '.config/qoder/mcp_config.json',
    }),
  },
  codex: {
    name: 'Codex',
    configPath: getPlatformConfigPath({
      win32: '.codex/config.toml',
      darwin: '.codex/config.toml',
      linux: '.codex/config.toml',
    }),
    useTomlFormat: true,
  },
};

// 检测是否通过 npx 运行
export function isNpxMode(): boolean {
  // 检查 npm_execpath 环境变量
  const execPath = process.env.npm_execpath || '';
  if (execPath.includes('npx')) {
    return true;
  }

  // 检查 npm_config_user_agent
  const userAgent = process.env.npm_config_user_agent || '';
  if (userAgent.includes('npx')) {
    return true;
  }

  // 检查 process.argv[1] 是否包含 _npx
  const argv1 = process.argv[1] || '';
  if (argv1.includes('_npx') || argv1.includes('.npm/_npx')) {
    return true;
  }

  // 检查 npm_command 是否为 exec (npx 使用 npm exec)
  const npmCommand = process.env.npm_command || '';
  if (npmCommand === 'exec') {
    return true;
  }

  return false;
}

// 获取 MCP Server 配置模板
export function getMCPServerConfig(useServersFormat?: boolean, useNpx?: boolean): any {
  const npxArgs = [
    '-y',
    `--registry=${OFFICIAL_NPM_REGISTRY}`,
    `--@mearl:registry=${OFFICIAL_NPM_REGISTRY}`,
    '@mearl/mcp-server',
  ];
  if (useServersFormat) {
    // VS Code 格式
    if (useNpx) {
      return {
        type: 'stdio',
        command: 'npx',
        args: npxArgs,
      };
    }
    return {
      type: 'stdio',
      command: 'mearl-mcp-server',
    };
  }
  // Claude Code/Cursor 格式
  if (useNpx) {
    return {
      command: 'npx',
      args: npxArgs,
      env: {},
    };
  }
  return {
    command: 'mearl-mcp-server',
    args: [],
    env: {},
  };
}

/**
 * 检测已安装的 MCP 客户端
 * @returns 已安装的客户端 ID 列表
 */
export function detectInstalledClients(): string[] {
  const installed: string[] = [];

  for (const [id, config] of Object.entries(MCP_CLIENTS)) {
    // 检查配置文件的父目录是否存在
    // 因为配置文件本身可能不存在，但如果应用已安装，其配置目录应该存在
    const configDir = dirname(config.configPath);

    if (existsSync(configDir)) {
      installed.push(id);
    }
  }

  return installed;
}

/**
 * 检测单个 MCP 客户端是否已安装
 * @param clientId 客户端 ID
 * @returns 是否已安装
 */
export function isClientInstalled(clientId: string): boolean {
  const config = MCP_CLIENTS[clientId];
  if (!config) {
    return false;
  }

  const configDir = dirname(config.configPath);
  return existsSync(configDir);
}
