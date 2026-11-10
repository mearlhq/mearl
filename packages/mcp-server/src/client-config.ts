import { execFileSync } from 'node:child_process';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { isMap, isSeq, parseDocument } from 'yaml';
import { getMCPServerConfig, type MCPClientConfig } from './mcp-clients.js';

function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function detectOpenCodeMajor(): number | undefined {
  try {
    const version = execFileSync('opencode', ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = /^(?:v)?(\d+)\.\d+\.\d+/.exec(version);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

// Edit only the server entry so comments, unrelated settings and YAML tags survive.
export function editClientConfig(
  content: string,
  format: NonNullable<MCPClientConfig['format']>,
  useNpx: boolean,
  remove = false,
  openCodeMajor?: number,
): string | null {
  if (format === 'dsh') return editDsh(content, useNpx, remove);
  const source = content.trim() ? content : '{}';
  const errors: ParseError[] = [];
  const config = parse(source, errors, { allowTrailingComma: true });
  if (errors.length || !object(config)) throw new Error('Invalid MCP configuration object');
  let path = ['mcpServers', 'mearl'];
  if (format === 'opencode') {
    if (config.mcp !== undefined && !object(config.mcp)) throw new Error('Invalid OpenCode mcp');
    const nested = object(config.mcp?.servers) && typeof config.mcp.servers.type !== 'string';
    const flat = Object.values(config.mcp ?? {}).some(
      value => object(value) && (value.type === 'local' || value.type === 'remote'),
    );
    const major = openCodeMajor ?? (remove || nested || flat ? undefined : detectOpenCodeMajor());
    if (nested && flat) throw new Error('Mixed OpenCode v1/v2 MCP configuration');
    if (!nested && !flat && major === undefined && !remove) {
      throw new Error(
        'Cannot determine OpenCode version; run opencode --version before configuring',
      );
    }
    path =
      nested || (!flat && major !== undefined && major >= 2)
        ? ['mcp', 'servers', 'mearl']
        : ['mcp', 'mearl'];
  }
  let parent: any = config;
  for (const key of path.slice(0, -1)) {
    if (parent[key] === undefined) {
      parent = undefined;
      break;
    }
    if (!object(parent[key])) throw new Error(`Invalid MCP configuration: ${key}`);
    parent = parent[key];
  }
  const current = parent?.mearl;
  if (remove && current === undefined) return null;
  if (!remove && current !== undefined && !object(current)) throw new Error('Invalid mearl entry');
  if (
    !remove &&
    current &&
    (current.url !== undefined ||
      (current.type !== undefined && current.type !== 'local' && current.type !== 'stdio'))
  ) {
    throw new Error('Existing remote mearl entry must be removed before installing a local server');
  }
  const server = getMCPServerConfig(false, useNpx);
  const value =
    format === 'opencode'
      ? { ...current, type: 'local', command: [server.command, ...server.args] }
      : { ...current, command: server.command, args: server.args };
  return applyEdits(
    source,
    modify(source, path, remove ? undefined : value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  );
}

function editDsh(content: string, useNpx: boolean, remove: boolean): string | null {
  const doc = parseDocument(content.trim() ? content : '[]');
  if (doc.errors.length || !isSeq(doc.contents)) throw new Error('Invalid DSH patch sequence');
  const patches = doc.contents;
  for (let p = 0; p < patches.items.length; p++) {
    const patch = patches.items[p];
    if (!isMap(patch)) continue;
    const entries = patch.get('insert', true);
    if (!isSeq(entries)) continue;
    for (let i = 0; i < entries.items.length; i++) {
      const entry = entries.items[i];
      if (!isMap(entry) || entry.get('id') !== 'mcp-mearl') continue;
      if (
        entry.get('name') !== '@deepseek-ai/dsh-mcp-client' ||
        entry.getIn(['config', 'serverName']) !== 'mearl'
      ) {
        throw new Error('DSH mcp-mearl id belongs to another configuration');
      }
      if (remove) {
        entries.delete(i);
        if (entries.items.length === 0 && patch.items.length === 1) patches.delete(p);
      } else {
        if (
          entry.getIn(['config', 'url']) !== undefined ||
          (entry.getIn(['config', 'transport']) !== undefined &&
            entry.getIn(['config', 'transport']) !== 'stdio')
        ) {
          throw new Error(
            'Existing remote mearl entry must be removed before installing a local server',
          );
        }
        const server = getMCPServerConfig(false, useNpx);
        entry.setIn(['config', 'command'], server.command);
        entry.setIn(['config', 'args'], server.args);
        entry.setIn(['config', 'transport'], 'stdio');
      }
      return doc.toString();
    }
  }
  if (remove) return null;
  doc.add({
    insert: [
      {
        id: 'mcp-mearl',
        name: '@deepseek-ai/dsh-mcp-client',
        config: { serverName: 'mearl', transport: 'stdio', ...getMCPServerConfig(false, useNpx) },
      },
    ],
  });
  return doc.toString();
}
