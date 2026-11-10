import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'jsonc-parser';
import { parseDocument } from 'yaml';
import { editClientConfig, detectOpenCodeMajor } from '../client-config.js';
import { MCP_CLIENTS, detectInstalledClients, isClientInstalled } from '../mcp-clients.js';
import { updateMCPConfig } from '../configure.js';
import { cleanMCPConfig, runUninstall } from '../uninstall.js';

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(() => {
    throw new Error('not installed');
  }),
}));
const directories: string[] = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'mearl-clients-'));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('client configuration lifecycle', () => {
  it.each(['pi', 'opencode', 'dsh'] as const)(
    'rejects converting an existing %s remote entry without changing the file',
    format => {
      const content =
        format === 'dsh'
          ? '- insert:\n    - id: mcp-mearl\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: mearl\n        transport: streamable-http\n        url: https://example.com/mcp\n'
          : JSON.stringify({
              [format === 'pi' ? 'mcpServers' : 'mcp']: {
                mearl: {
                  type: format === 'pi' ? 'http' : 'remote',
                  url: 'https://example.com/mcp',
                },
              },
            });
      const configPath = join(temp(), 'config');
      writeFileSync(configPath, content);
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(updateMCPConfig(configPath, { name: format, configPath, format }, false)).toBe(
          false,
        );
        expect(readFileSync(configPath, 'utf8')).toBe(content);
      } finally {
        log.mockRestore();
      }
    },
  );

  it('uninstalls OpenCode from both JSON and JSONC even after the preferred file changes', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', temp());
    const client = MCP_CLIENTS.opencode;
    mkdirSync(dirname(client.configPath), { recursive: true });
    const [json, jsonc] = client.cleanupPaths!;
    writeFileSync(
      json,
      '{"mcp":{"mearl":{"type":"local","command":["old"]},"other":{"type":"local","command":["other"]}}}',
    );
    writeFileSync(jsonc, '{"mcp":{"servers":{"mearl":{"type":"local","command":["new"]}}}}');
    expect(client.configPath).toBe(jsonc);
    expect(
      await runUninstall(['--yes', '--managed-by-setup'], {
        clients: { opencode: client },
        removeNativeHost: async () => true,
        log: () => {},
      }),
    ).toBe(true);
    expect(parse(readFileSync(json, 'utf8')).mcp).toEqual({
      other: { type: 'local', command: ['other'] },
    });
    expect(parse(readFileSync(jsonc, 'utf8')).mcp.servers).toEqual({});
  });
  it.each([1, 2])(
    'preserves OpenCode v%s JSONC and other servers through install and removal',
    major => {
      const servers = { other: { type: 'local', command: ['other'] } };
      const content = JSON.stringify(
        { model: 'example/model', mcp: major === 1 ? servers : { servers } },
        null,
        2,
      ).replace('"model"', '// Keep this comment\n  "model"');
      const once = editClientConfig(content, 'opencode', true)!;
      const twice = editClientConfig(once, 'opencode', false)!;
      expect(twice).toContain('// Keep this comment');
      const config = parse(twice);
      expect((major === 1 ? config.mcp : config.mcp.servers).mearl.command).toEqual([
        'mearl-mcp-server',
      ]);
      expect(editClientConfig(twice, 'opencode', false)).toBe(twice);
      const removed = editClientConfig(twice, 'opencode', false, true)!;
      expect(parse(removed)).toEqual(parse(content));
      expect(removed).toContain('// Keep this comment');
      expect(editClientConfig(removed, 'opencode', false, true)).toBeNull();
    },
  );

  it.each([1, 2])('creates the right structure for OpenCode v%s', major => {
    const config = parse(editClientConfig('', 'opencode', true, false, major)!);
    const server = major === 1 ? config.mcp.mearl : config.mcp.servers.mearl;
    expect(server).toEqual({
      type: 'local',
      command: [
        'npx',
        '-y',
        '--registry=https://registry.npmjs.org/',
        '--@mearl:registry=https://registry.npmjs.org/',
        '@mearl/mcp-server',
      ],
    });
  });

  it('requires a known version for an empty OpenCode config', () => {
    expect(() => editClientConfig('{}', 'opencode', false)).toThrow('Cannot determine');
    vi.mocked(execFileSync).mockReturnValueOnce('2.0.1\n');
    expect(detectOpenCodeMajor()).toBe(2);
    vi.mocked(execFileSync).mockReturnValueOnce('1.18.21\n');
    expect(parse(editClientConfig('{}', 'opencode', false)!).mcp.mearl).toBeDefined();
  });

  it('does not confuse a v1 server named servers with the v2 container', () => {
    const config = parse(
      editClientConfig(
        '{"mcp":{"servers":{"type":"local","command":["other"]}}}',
        'opencode',
        false,
      )!,
    );
    expect(config.mcp.mearl.command).toEqual(['mearl-mcp-server']);
    expect(config.mcp.servers.command).toEqual(['other']);
  });

  it('supports a v2 server named type', () => {
    const config = parse(
      editClientConfig(
        '{"mcp":{"servers":{"type":{"type":"local","command":["other"]}}}}',
        'opencode',
        false,
      )!,
    );
    expect(config.mcp.servers.mearl.command).toEqual(['mearl-mcp-server']);
    expect(config.mcp.servers.type.command).toEqual(['other']);
  });

  it('preserves Pi settings, other servers and custom Mearl options', () => {
    const original = {
      custom: true,
      mcpServers: {
        other: { command: 'other' },
        mearl: { command: 'old', env: { EXAMPLE: 'value' }, timeout: 90 },
      },
    };
    const updated = editClientConfig(JSON.stringify(original), 'pi', true)!;
    expect(parse(updated).mcpServers.mearl).toMatchObject({
      command: 'npx',
      env: { EXAMPLE: 'value' },
      timeout: 90,
    });
    expect(parse(editClientConfig(updated, 'pi', false, true)!)).toEqual({
      custom: true,
      mcpServers: { other: { command: 'other' } },
    });
  });

  it('preserves Cordis patches, comments and JS tags and installs only once', () => {
    const original =
      '# Keep this comment\n- id: unrelated\n  config:\n    cwd: !!js process.cwd()\n';
    const once = editClientConfig(original, 'dsh', true)!;
    const twice = editClientConfig(once, 'dsh', false)!;
    expect(twice).toContain('# Keep this comment');
    expect(twice).toContain('!!js process.cwd()');
    const data = parseDocument(twice).toJS();
    expect(data).toHaveLength(2);
    expect(data[1].insert[0].config).toMatchObject({
      serverName: 'mearl',
      transport: 'stdio',
      command: 'mearl-mcp-server',
      args: [],
    });
    expect(editClientConfig(twice, 'dsh', false)).toBe(twice);
    const removed = editClientConfig(twice, 'dsh', false, true)!;
    expect(parseDocument(removed).toJS()).toEqual(parseDocument(original).toJS());
    expect(removed).toContain('!!js process.cwd()');
    expect(editClientConfig(removed, 'dsh', false, true)).toBeNull();
  });

  it('removes only the owned entry from a shared DSH insert', () => {
    const content =
      '- insert:\n    - id: other\n      name: other\n    - id: mcp-mearl\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: mearl\n        command: old\n';
    expect(parseDocument(editClientConfig(content, 'dsh', false, true)!).toJS()).toEqual([
      { insert: [{ id: 'other', name: 'other' }] },
    ]);
    expect(() =>
      editClientConfig(content.replace('serverName: mearl', 'serverName: other'), 'dsh', false),
    ).toThrow('belongs to another');
  });

  it.each(['pi', 'opencode', 'dsh'] as const)(
    'writes and cleans %s on disk without damaging malformed input',
    format => {
      const configPath = join(temp(), 'nested', 'config');
      const client = { name: format, configPath, format };
      if (format === 'opencode') vi.mocked(execFileSync).mockReturnValueOnce('2.0.0');
      expect(updateMCPConfig(configPath, client, true)).toBe(true);
      expect(cleanMCPConfig(configPath, client)).toBe('removed');
      expect(cleanMCPConfig(configPath, client)).toBe('not-found');
      writeFileSync(configPath, '{broken');
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(updateMCPConfig(configPath, client, false)).toBe(false);
        expect(cleanMCPConfig(configPath, client)).toBe('failed');
        expect(readFileSync(configPath, 'utf8')).toBe('{broken');
      } finally {
        log.mockRestore();
      }
    },
  );
});

describe('client discovery', () => {
  it('detects initialized directories and honors environment paths', () => {
    const root = temp();
    vi.stubEnv('XDG_CONFIG_HOME', root);
    vi.stubEnv('DSH_HOME', join(root, 'dsh'));
    vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'pi'));
    for (const id of ['opencode', 'dsh', 'pi']) {
      expect(isClientInstalled(id)).toBe(false);
      mkdirSync(dirname(MCP_CLIENTS[id].configPath), { recursive: true });
      expect(isClientInstalled(id)).toBe(true);
      expect(detectInstalledClients()).toContain(id);
    }
    writeFileSync(join(root, 'opencode', 'opencode.jsonc'), '{}');
    expect(MCP_CLIENTS.opencode.configPath).toBe(join(root, 'opencode', 'opencode.jsonc'));
    vi.stubEnv('DSH_HOME', '~/custom-dsh');
    expect(MCP_CLIENTS.dsh.configPath).toBe(join(homedir(), 'custom-dsh', 'cordis.patch.yml'));
  });
});
