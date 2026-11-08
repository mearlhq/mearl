import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanMCPConfig,
  parseUninstallArgs,
  runUninstall,
  type MCPUninstallDependencies,
} from '../uninstall.js';

const temporaryDirectories: string[] = [];

function createConfigFile(name: string, content: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-mcp-uninstall-test-'));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, name);
  fs.writeFileSync(configPath, content);
  return configPath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('cleanMCPConfig', () => {
  it.each(['', '  \n\t\r\n'])('leaves an empty config untouched: %j', content => {
    const configPath = createConfigFile('mcp.json', content);

    expect(
      cleanMCPConfig(configPath, {
        name: 'VSCode Copilot',
        configPath,
        useServersFormat: true,
      }),
    ).toBe('not-found');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(content);
  });

  it('reports malformed nonempty config without overwriting it', () => {
    const content = '{"servers":';
    const configPath = createConfigFile('mcp.json', content);
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        cleanMCPConfig(configPath, {
          name: 'VSCode Copilot',
          configPath,
          useServersFormat: true,
        }),
      ).toBe('failed');
      expect(fs.readFileSync(configPath, 'utf8')).toBe(content);
      expect(logError).toHaveBeenCalledWith(expect.stringContaining(configPath));
    } finally {
      logError.mockRestore();
    }
  });

  it('removes the VSCode server while preserving unrelated configuration', () => {
    const configPath = createConfigFile(
      'mcp.json',
      JSON.stringify({
        inputs: [{ id: 'api-key', type: 'promptString' }],
        servers: { mearl: { command: 'mearl-mcp-server' }, other: { command: 'other-server' } },
      }),
    );

    expect(
      cleanMCPConfig(configPath, {
        name: 'VSCode Copilot',
        configPath,
        useServersFormat: true,
      }),
    ).toBe('removed');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      inputs: [{ id: 'api-key', type: 'promptString' }],
      servers: { other: { command: 'other-server' } },
    });
  });

  it('removes a JSON MCP server without changing other entries', () => {
    const configPath = createConfigFile(
      'mcp.json',
      JSON.stringify({
        mcpServers: {
          mearl: { command: 'mearl-mcp-server' },
          other: { command: 'other-server' },
        },
      }),
    );

    expect(cleanMCPConfig(configPath, { name: 'Cursor', configPath })).toBe('removed');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      mcpServers: {
        other: { command: 'other-server' },
      },
    });
  });

  it('removes only the Mearl section from a Codex TOML config', () => {
    const configPath = createConfigFile(
      'config.toml',
      [
        'model = "gpt-5"',
        '',
        '[mcp_servers.mearl]',
        'command = "mearl-mcp-server"',
        '',
        '[mcp_servers.other]',
        'command = "other-server"',
        '',
      ].join('\n'),
    );

    expect(
      cleanMCPConfig(configPath, {
        name: 'Codex',
        configPath,
        useTomlFormat: true,
      }),
    ).toBe('removed');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(
      ['model = "gpt-5"', '', '[mcp_servers.other]', 'command = "other-server"', ''].join('\n'),
    );
  });
});

describe('runUninstall', () => {
  function dependencies(
    overrides: Partial<MCPUninstallDependencies> = {},
  ): MCPUninstallDependencies {
    return {
      clients: {},
      globalInstallationDetected: vi.fn(() => false),
      log: vi.fn(),
      logError: vi.fn(),
      prompt: vi.fn(async () => ({ clients: [] })),
      removeNativeHost: vi.fn(async () => true),
      ...overrides,
    };
  }

  it('returns failure when Native Host cleanup fails', async () => {
    const deps = dependencies({
      removeNativeHost: vi.fn(async () => false),
    });

    await expect(runUninstall(['--managed-by-setup'], deps)).resolves.toBe(false);
    expect(deps.logError).toHaveBeenCalledWith('\n❌ 卸载未完整完成，请检查上述错误');
  });

  it('cleans every discovered client without prompting when --yes is set', async () => {
    const cleanConfig = vi.fn(() => 'removed' as const);
    const prompt = vi.fn(async () => ({ clients: [] }));
    const deps = dependencies({
      cleanConfig,
      clients: {
        cursor: { name: 'Cursor', configPath: '/configs/cursor.json' },
        codex: {
          name: 'Codex',
          configPath: '/configs/codex.toml',
          useTomlFormat: true,
        },
      },
      exists: vi.fn(() => true),
      prompt,
    });

    await expect(runUninstall(['--managed-by-setup', '--yes'], deps)).resolves.toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    expect(cleanConfig).toHaveBeenCalledTimes(2);
  });

  it('completes when a discovered client config is empty', async () => {
    const configPath = createConfigFile('mcp.json', '');
    const deps = dependencies({
      clients: { vscode: { name: 'VSCode Copilot', configPath, useServersFormat: true } },
    });

    await expect(runUninstall(['--managed-by-setup', '--yes'], deps)).resolves.toBe(true);
    expect(deps.log).toHaveBeenCalledWith('未找到 VSCode Copilot 配置');
    expect(fs.readFileSync(configPath, 'utf8')).toBe('');
  });

  it('returns failure when a selected client config cannot be cleaned', async () => {
    const deps = dependencies({
      cleanConfig: vi.fn(() => 'failed'),
      clients: {
        cursor: { name: 'Cursor', configPath: '/configs/cursor.json' },
      },
      exists: vi.fn(() => true),
    });

    await expect(runUninstall(['--managed-by-setup', '--yes'], deps)).resolves.toBe(false);
  });
});

describe('parseUninstallArgs', () => {
  it('accepts non-interactive aliases and rejects unknown options', () => {
    expect(parseUninstallArgs(['--managed-by-setup', '--non-interactive'])).toEqual({
      help: false,
      managedBySetup: true,
      yes: true,
    });
    expect(() => parseUninstallArgs(['--unknown'])).toThrow('unknown option');
  });
});
