import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, mkdtempSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const git = promisify(execFile);
const COMMUNITY_REPOSITORY = 'https://github.com/epiral/bb-sites.git';

export function adapterDirectories() {
  const root = join(homedir(), '.mearl', 'bbrowser');
  return {
    root,
    community: join(root, 'bb-sites'),
    sources: [
      { directory: join(homedir(), '.bb-browser', 'bb-sites'), source: 'community' },
      { directory: join(root, 'bb-sites'), source: 'community' },
      { directory: join(homedir(), '.bb-browser', 'sites'), source: 'local' },
      { directory: join(root, 'sites'), source: 'local' },
    ],
  };
}

export function parseMetadata(content, fallbackName) {
  const block = content.match(/\/\*\s*@meta\s*\n([\s\S]*?)\*\//);
  let meta = {};
  if (block) {
    try { meta = JSON.parse(block[1]); }
    catch { throw new Error(`适配器 ${fallbackName} 的 @meta 不是有效 JSON`); }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error(`适配器 ${fallbackName} 的 @meta 必须是对象`);
  } else {
    for (const [, key, value] of content.matchAll(/\/\/\s*@(name|description|domain|args|example)[ \t]+([^\r\n]*)/g)) {
      meta[key] = key === 'args'
        ? Object.fromEntries(value.trim().split(/[,\s]+/).filter(Boolean).map(name => [name, { required: true }]))
        : value.trim();
    }
  }
  const args = meta.args ?? {};
  if (typeof args !== 'object' || Array.isArray(args) || args === null ||
    Object.entries(args).some(([key, value]) => !key || (typeof value !== 'string' && (!value || typeof value !== 'object' || Array.isArray(value))))) {
    throw new Error(`适配器 ${fallbackName} 的 args 必须是参数定义对象`);
  }
  for (const key of ['name', 'description', 'domain', 'example']) {
    if (meta[key] !== undefined && typeof meta[key] !== 'string') throw new Error(`适配器 ${fallbackName} 的 ${key} 必须是字符串`);
  }
  return { ...meta, name: meta.name || fallbackName, description: meta.description || '', domain: meta.domain || '', args };
}

export function listAdapters() {
  const adapters = new Map();
  for (const source of adapterDirectories().sources) {
    const walk = current => {
      if (!existsSync(current)) return;
      for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.')) continue;
        const file = join(current, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && entry.name.endsWith('.js') && entry.name !== '_helper.js') {
          const name = relative(source.directory, file).split(sep).join('/').replace(/\.js$/, '');
          const meta = parseMetadata(readFileSync(file, 'utf8'), name);
          adapters.set(meta.name, { ...meta, file, source: source.source, directory: source.directory });
        }
      }
    };
    walk(source.directory);
  }
  return [...adapters.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function readAdapter(adapter) {
  const read = file => {
    const target = realpathSync(file);
    const path = relative(realpathSync(adapter.directory), target);
    if (path === '..' || path.startsWith(`..${sep}`) || resolve(target) === resolve(adapter.directory)) throw new Error('适配器资源必须位于来源目录内');
    return readFileSync(target, 'utf8');
  };
  const body = read(adapter.file).replace(/\/\*\s*@meta[\s\S]*?\*\//, '').trim();
  const helperPath = join(dirname(adapter.file), '_helper.js');
  const helper = existsSync(helperPath) ? read(helperPath) : '';
  return { expression: `async (args) => {\n${helper}\nreturn await (${body})(args);\n}` };
}

export function findAdapter(name) {
  if (typeof name !== 'string' || !name) return undefined;
  const file = resolve(name.endsWith('.js') ? name : `${name}.js`);
  if (existsSync(file) && statSync(file).isFile()) {
    return {
      ...parseMetadata(readFileSync(file, 'utf8'), name.replace(/\.js$/, '')),
      file, directory: dirname(file), source: 'local',
    };
  }
  return listAdapters().find(adapter => adapter.name === name);
}

export async function updateAdapters(progress = () => {}) {
  const { root, community } = adapterDirectories();
  mkdirSync(root, { recursive: true });
  const lock = join(root, '.update-lock');
  try { mkdirSync(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('适配器库正在更新，请稍后重试');
    throw error;
  }
  let temporary;
  const run = async args => (await git('git', args, { timeout: 120000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
  try {
    if (existsSync(community)) {
      const origin = await run(['-C', community, 'config', '--get', 'remote.origin.url']);
      if (origin !== COMMUNITY_REPOSITORY) throw new Error('社区适配器库的 origin 不是官方 epiral/bb-sites，请先检查本地仓库');
      if (await run(['-C', community, 'status', '--porcelain'])) throw new Error('社区适配器库有本地修改，请先处理后再更新；私有适配器请放在 sites 目录');
      progress('更新 bb-browser 社区适配器...');
      await run(['-C', community, 'pull', '--ff-only']);
    } else {
      temporary = mkdtempSync(join(root, '.download-'));
      progress('下载 bb-browser 社区适配器...');
      await run(['clone', '--depth', '1', '--', COMMUNITY_REPOSITORY, join(temporary, 'repository')]);
      renameSync(join(temporary, 'repository'), community);
    }
    return { success: true, directory: community, repository: COMMUNITY_REPOSITORY, commit: await run(['-C', community, 'rev-parse', 'HEAD']) };
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}
