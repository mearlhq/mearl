import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPlugin } from '@mearl/client/plugin';
import { adapterDirectories, findAdapter, listAdapters, parseMetadata, readAdapter, updateAdapters } from '../../mearl-bbrowser/scripts/catalog.mjs';
import { domainMatches, executeAdapter, resolveArguments } from '../../mearl-bbrowser/scripts/runtime.mjs';

vi.mock('node:os', async original => {
  const os = await original();
  return { ...os, homedir: vi.fn(os.homedir) };
});

const run = promisify(execFile);
const roots = [];
const entry = fileURLToPath(new URL('../../mearl-bbrowser/scripts/main.mjs', import.meta.url));
const directory = () => {
  const root = mkdtempSync(join(tmpdir(), 'mearl-bbrowser-'));
  roots.push(root);
  return root;
};
function adapter(root, name = 'demo/read', meta = {}, body = 'async function(args) { return args; }') {
  const file = join(root, `${name}.js`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `/* @meta\n${JSON.stringify({ name, domain: 'example.test', ...meta })}\n*/\n${body}`);
  return listAdapters().find(item => item.name === name);
}
async function plugin(invoke = vi.fn(), options = {}) {
  const runtime = await loadPlugin(entry, { options, invoke, progress: vi.fn() });
  return { runtime, invoke, call: (tokens, input = {}) => runtime.run([], { command: 'site', input: { tokens, ...input } }) };
}

const permissionRequired = (action, domain = 'example.test') => Object.assign(
  new Error('Permission required'), { code: 'DOMAIN_PERMISSION_REQUIRED', requestDispatched: false, action, domain },
);

beforeEach(() => {
  vi.mocked(homedir).mockReturnValue(directory());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

describe('bbrowser adapter catalog', () => {
  it('preserves extra metadata and supports legacy argument tags', () => {
    expect(parseMetadata('/* @meta\n{"args":{"q":{"required":true}},"agent":{"exposure":"diagnostic"}}\n*/', 'demo/read')).toMatchObject({ name: 'demo/read', agent: { exposure: 'diagnostic' } });
    expect(parseMetadata('// @name demo/search\n// @domain example.test\n// @args query, count\nasync function(args){}', 'fallback')).toMatchObject({ name: 'demo/search', args: { query: { required: true }, count: { required: true } } });
    expect(() => parseMetadata('/* @meta\n{"args":[]}\n*/', 'bad')).toThrow('args');
    expect(() => parseMetadata('/* @meta\ninvalid\n*/', 'bad')).toThrow('@meta');
  });

  it('loads community arguments expressed as description strings alongside object definitions', async () => {
    const root = adapterDirectories().sources.at(-1).directory;
    adapter(root, 'pypi/package', { args: { name: '包名', count: { required: true } } });
    const { call } = await plugin();
    const item = await call(['info', 'pypi/package']);
    expect(item.args).toEqual({ name: '包名', count: { required: true } });
    expect(resolveArguments(item, ['requests', '5'])).toEqual({ name: 'requests', count: '5' });
    expect(resolveArguments(item, [], { name: 'requests', count: 5 })).toEqual({ name: 'requests', count: '5' });
    for (const value of [null, 42, false, []]) {
      expect(() => parseMetadata(`/* @meta\n${JSON.stringify({ args: { name: value } })}\n*/`, 'bad')).toThrow('args');
    }
  });

  it('applies private overrides and skips helpers, hidden files, and linked directories', () => {
    const root = adapterDirectories().root;
    adapter(join(root, 'bb-sites'), 'unique-mearl-test/read', { description: 'community' });
    adapter(join(root, 'sites'), 'unique-mearl-test/read', { description: 'private' });
    writeFileSync(join(root, 'sites/unique-mearl-test/_helper.js'), 'function helper() {}');
    mkdirSync(join(root, 'sites/.hidden'));
    writeFileSync(join(root, 'sites/.hidden/read.js'), '/* @meta\n{"name":"hidden"}\n*/');
    symlinkSync(join(root, 'bb-sites'), join(root, 'sites/linked'));
    expect(listAdapters().find(item => item.name === 'unique-mearl-test/read')).toMatchObject({ description: 'private', source: 'local' });
    expect(listAdapters().map(item => item.name)).toEqual(['unique-mearl-test/read']);
  });

  it('loads helper code in the same scope and safely transports arguments', async () => {
    const root = adapterDirectories().sources.at(-1).directory;
    const item = adapter(root, 'demo/read', {}, 'async function(args) { return {value: await helper(args.value), cached: window.cached}; }');
    writeFileSync(join(root, 'demo/_helper.js'), 'async function helper(value) { window.cached = 42; return value; }');
    const { expression } = readAdapter(item);
    const value = '\"); globalThis.injected = true; //';
    const context = { window: {} };
    const fn = runInNewContext(`(${expression})`, context);
    expect(await fn({ value })).toEqual({ value, cached: 42 });
    expect(context.injected).toBeUndefined();
    const outside = join(directory(), 'outside.js');
    writeFileSync(outside, 'throw new Error("outside")');
    rmSync(join(root, 'demo/_helper.js'));
    symlinkSync(outside, join(root, 'demo/_helper.js'));
    expect(() => readAdapter(item)).toThrow('来源目录');
  });

  it('maps named and positional arguments without applying JavaScript type coercion to missing fields', () => {
    const item = { name: 'demo/read', args: { query: { required: true }, count: {}, enabled: {} } };
    expect(resolveArguments(item, ['topic'], { count: 0, enabled: false })).toEqual({ query: 'topic', count: '0', enabled: 'false' });
    expect(() => resolveArguments(item, [], {})).toThrow('query');
    expect(() => resolveArguments(item, ['a', 'b', 'c', 'd'])).toThrow('过多');
    expect(() => resolveArguments(item, [], { unknown: 'x' })).toThrow('未知');
  });

  it('resolves project-relative files before installed adapters and loads their sibling helpers', async () => {
    adapter(adapterDirectories().sources.at(-1).directory, 'example-shop/ai-agent', { description: 'installed' });
    const workspace = directory();
    adapter(workspace, 'example-shop/ai-agent', { description: 'workspace' }, 'async function(args) { return helper(args); }');
    writeFileSync(join(workspace, 'example-shop/_helper.js'), 'function helper(args) { return { project: true, ...args }; }');
    vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    for (const name of ['example-shop/ai-agent', './example-shop/ai-agent.js', join(workspace, 'example-shop/ai-agent.js')]) {
      const found = findAdapter(name);
      expect(found).toMatchObject({ description: 'workspace', file: join(workspace, 'example-shop/ai-agent.js') });
      const fn = runInNewContext(`(${readAdapter(found).expression})`);
      expect(await fn({ value: 42 })).toEqual({ project: true, value: 42 });
    }
    const { call } = await plugin();
    expect(await call(['info', 'example-shop/ai-agent'])).toMatchObject({ description: 'workspace' });
    rmSync(join(workspace, 'example-shop/ai-agent.js'));
    expect(findAdapter('example-shop/ai-agent')).toMatchObject({ description: 'installed' });
  });

  it('clones and fast-forwards a source without overwriting local edits or another origin', async () => {
    const root = adapterDirectories().root;
    const repository = directory();
    const git = (...args) => run('git', ['-C', repository, ...args]);
    await git('init', '-b', 'main');
    writeFileSync(join(repository, 'read.js'), 'async function(args) { return args; }');
    await git('add', '.');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'fixture');
    const gitConfig = join(directory(), 'gitconfig');
    writeFileSync(gitConfig, `[url "file://${repository}"]\n\tinsteadOf = https://github.com/epiral/bb-sites.git\n`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', gitConfig);
    const first = await updateAdapters();
    expect(first).toMatchObject({ success: true, directory: join(root, 'bb-sites') });
    expect(first.repository).toBe('https://github.com/epiral/bb-sites.git');
    expect(readFileSync(join(first.directory, 'read.js'), 'utf8')).toContain('async function');
    writeFileSync(join(repository, 'revision.txt'), 'next');
    await git('add', '.');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'next');
    const second = await updateAdapters();
    expect(second.commit).not.toBe(first.commit);
    writeFileSync(join(second.directory, 'revision.txt'), 'local');
    await expect(updateAdapters()).rejects.toThrow('本地修改');
    expect(readFileSync(join(second.directory, 'revision.txt'), 'utf8')).toBe('local');
    expect(adapterDirectories().community).toBe(second.directory);
    await run('git', ['-C', second.directory, 'remote', 'set-url', 'origin', 'https://other.test/repository.git']);
    await expect(updateAdapters()).rejects.toThrow('origin');
  });
});

describe('bbrowser plugin commands and browser execution', () => {
  it('lists, searches and describes adapters without contacting a browser', async () => {
    const root = adapterDirectories().sources.at(-1).directory;
    adapter(root, 'demo/read', { description: '读取身份', agent: { exposure: 'diagnostic' }, example: 'bb-browser site demo/read' });
    const { call, invoke } = await plugin();
    expect(await call(['list'])).toMatchObject([{ name: 'demo/read' }]);
    expect(await call(['search', '身份'])).toMatchObject([{ name: 'demo/read' }]);
    expect(await call(['info', 'demo/read'])).toMatchObject({ agent: { exposure: 'diagnostic' }, example: 'mearl bbrowser site demo/read' });
    expect(invoke).not.toHaveBeenCalled();
    await expect(call(['demo/missing'])).rejects.toThrow('未找到适配器');
    await expect(call(['list', 'extra'])).rejects.toThrow('位置参数');
    await expect(call(['list'], { directory: root })).rejects.toThrow('不接受适配器参数');
    await expect(call(['update'], { repository: 'https://other.test/sites.git' })).rejects.toThrow('不接受业务选项');
  });

  it.each([undefined, 'cdp'])('executes the original helper and async function via the %s transport', async transport => {
    const root = adapterDirectories().sources.at(-1).directory;
    adapter(root, 'demo/read', { args: { seller_id: { required: true }, count: {} } }, 'async function(args) { return await helper(args); }');
    writeFileSync(join(root, 'demo/_helper.js'), 'async function helper(args) { return { ...args, token: window.pageToken }; }');
    const invoke = vi.fn(async (action, payload) => {
      if (action === 'tab_list') return { tabs: [] };
      if (action === 'tab_open') return { tabId: 12, url: 'https://example.test/dashboard', reused: true };
      if (action === 'page_eval') return { result: await runInNewContext(`(${payload.expression})`, { window: { pageToken: 'page-state' } })(...payload.args) };
      throw new Error(`Unexpected action ${action}`);
    });
    const { call } = await plugin(invoke, { browser: 'mearl:local:selected', ...(transport ? { transport } : {}) });
    await expect(call(['demo/read', '123'], { count: '0' })).resolves.toEqual({ result: { seller_id: '123', count: '0', token: 'page-state' } });
    expect(invoke.mock.calls.every(([, , options]) => options.browser === 'mearl:local:selected')).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith('page_eval', expect.objectContaining({ tabId: 12, executionWorld: 'main', awaitPromise: true, observe: false }), expect.any(Object));
  });

  it('pins the discovered default browser across opening and evaluating', async () => {
    const item = adapter(adapterDirectories().sources.at(-1).directory);
    const invoke = vi.fn(async action => ({
      browser_list: { defaultBrowserId: 'fixed' },
      tab_list: { tabs: [] },
      tab_open: { tabId: 12, url: 'https://example.test/' },
      page_eval: { result: false },
    })[action]);
    await expect(executeAdapter(item, {}, { invoke })).resolves.toEqual({ result: false });
    expect(invoke.mock.calls.slice(1).every(([, , options]) => options.browser === 'fixed')).toBe(true);
  });

  it('requests permission on the selected browser and retries tab_open before executing the adapter', async () => {
    adapter(adapterDirectories().sources.at(-1).directory);
    const browserId = 'mearl:remote:node-a:fixed';
    const session = { sessionId: 's_fixed', browserId };
    let authorized = false;
    const invoke = vi.fn(async (action, payload) => {
      if (action === 'browser_list') return {
        defaultBrowserId: 'mearl:remote:node-a:other',
        browsers: [{ browserId, originalName: 'Work Chrome', status: 'connected' }],
      };
      if (action === 'tab_list') return { tabs: [] };
      if (action === 'tab_open') {
        if (!authorized) throw permissionRequired(action);
        return { tabId: 12, url: payload.url, session };
      }
      if (action === 'request_permission') {
        authorized = true;
        return { granted: true };
      }
      if (action === 'page_eval') return { result: 'executed', session };
      throw new Error(`Unexpected action ${action}`);
    });
    const { runtime } = await plugin(invoke, { browser: 'work chr', session: 'new' });
    await expect(runtime.run(['site', 'demo/read'])).resolves.toEqual({ result: 'executed', session });
    expect(invoke.mock.calls.map(([action]) => action)).toEqual([
      'browser_list', 'tab_list', 'tab_open', 'request_permission', 'tab_open', 'page_eval',
    ]);
    expect(invoke.mock.calls.slice(1).every(([, , options]) => options.browser === browserId)).toBe(true);
    expect(invoke.mock.calls[3]).toEqual(['request_permission', { domain: 'example.test' }, { browser: browserId, session: undefined }]);
    expect(invoke.mock.calls[4]).toEqual(invoke.mock.calls[2]);
    expect(invoke.mock.calls[5][2]).toEqual({ browser: browserId, session: 's_fixed' });
  });

  it('asks for a full browser ID when multiple profiles match a selector', async () => {
    adapter(adapterDirectories().sources.at(-1).directory);
    const invoke = vi.fn().mockResolvedValue({
      browsers: [
        { browserId: 'mearl:local:first', originalName: 'Chrome work', status: 'connected' },
        { browserId: 'mearl:local:second', originalName: 'Chrome personal', status: 'connected' },
      ],
    });
    const { call } = await plugin(invoke, { browser: 'chrome' });
    await expect(call(['demo/read'])).rejects.toThrow('完整 browserId');
    expect(invoke.mock.calls.map(([action]) => action)).toEqual(['browser_list']);
  });

  it('authorizes a selected tab before creating the requested control session', async () => {
    const item = adapter(adapterDirectories().sources.at(-1).directory);
    const browser = 'mearl:local:fixed';
    const session = { sessionId: 's_fixed', browserId: browser };
    let approved = false;
    const invoke = vi.fn(async action => {
      if (action === 'tab_list') return { tabs: [{ tabId: 12, url: 'https://example.test/' }] };
      if (action === 'page_snapshot') {
        if (!approved) throw permissionRequired(action);
        return { session };
      }
      if (action === 'request_permission') {
        approved = true;
        return { granted: true };
      }
      return { result: 42, session };
    });
    await expect(executeAdapter(item, {}, { invoke, tabId: 12, options: { browser, session: 'new' } }))
      .resolves.toEqual({ result: 42, session });
    expect(invoke.mock.calls.map(([action, , routing]) => [action, routing.session])).toEqual([
      ['tab_list', undefined],
      ['page_snapshot', 'new'],
      ['request_permission', undefined],
      ['tab_list', undefined],
      ['page_snapshot', 'new'],
      ['page_eval', 's_fixed'],
    ]);
  });

  it.each(['unchanged', 'during approval', 'after recheck', 'container frame'])('protects the approved tab against changes (%s)', async change => {
    adapter(adapterDirectories().sources.at(-1).directory, 'demo/read', {}, 'async function() { executed(); return true; }');
    let authorized = false;
    const executed = vi.fn();
    const invoke = vi.fn(async (action, payload) => {
      if (action === 'tab_list') return { tabs: [{ tabId: 12, url: authorized && change === 'during approval' ? 'https://other.test/' : 'https://example.test/' }] };
      if (action === 'request_permission') {
        authorized = true;
        return { granted: true };
      }
      if (action === 'page_eval' && authorized) {
        const location = {
          origin: change === 'unchanged' ? 'https://example.test' : 'https://other.test',
          ancestorOrigins: change === 'container frame' ? ['https://example.test'] : [],
        };
        const evaluate = runInNewContext(`(${payload.expression})`, { window: { location }, executed });
        return { result: await evaluate(...payload.args) };
      }
      throw permissionRequired(action);
    });
    const { call } = await plugin(invoke, { browser: 'mearl:local:fixed' });
    const result = call(['demo/read'], { tab: 12 });
    const runsAdapter = change === 'unchanged' || change === 'container frame';
    if (runsAdapter) await expect(result).resolves.toEqual({ result: true });
    else await expect(result).rejects.toThrow('目标标签页已关闭或切换站点');
    expect(invoke.mock.calls.map(([action]) => action)).toEqual([
      'tab_list', 'page_eval', 'request_permission', 'tab_list', ...(change === 'during approval' ? [] : ['page_eval']),
    ]);
    expect(executed).toHaveBeenCalledTimes(runsAdapter ? 1 : 0);
  });

  it.each([false, true])('stops after denial or a retry that is still blocked (granted: %s)', async granted => {
    adapter(adapterDirectories().sources.at(-1).directory);
    const invoke = vi.fn(async action => {
      if (action === 'tab_list') return { tabs: [] };
      if (action === 'request_permission') return { granted };
      throw permissionRequired(action);
    });
    const { call } = await plugin(invoke, { browser: 'mearl:local:fixed' });
    await expect(call(['demo/read'])).rejects.toThrow(granted ? 'Permission required' : '未获得 example.test 的访问权限');
    expect(invoke.mock.calls.filter(([action]) => action === 'request_permission')).toHaveLength(1);
    expect(invoke.mock.calls.filter(([action]) => action === 'tab_open')).toHaveLength(granted ? 2 : 1);
  });

  it.each([
    new Error('Permission required'),
    Object.assign(permissionRequired('tab_open'), { requestDispatched: true }),
    permissionRequired('page_eval'),
    permissionRequired('tab_open', 'other.test'),
  ])('does not request authorization for unrelated or ambiguous failures', async error => {
    adapter(adapterDirectories().sources.at(-1).directory);
    const invoke = vi.fn().mockResolvedValueOnce({ tabs: [] }).mockRejectedValueOnce(error);
    const { call } = await plugin(invoke, { browser: 'mearl:local:fixed' });
    await expect(call(['demo/read'])).rejects.toBe(error);
    expect(invoke.mock.calls.map(([action]) => action)).toEqual(['tab_list', 'tab_open']);
  });

  it('uses the toolbox host browser without discovering or overriding its routing', async () => {
    const item = adapter(adapterDirectories().sources.at(-1).directory);
    const invoke = vi.fn(async action => {
      if (action === 'tab_list') return { tabs: [] };
      if (action === 'tab_open') return { tabId: 12, url: 'https://example.test/' };
      if (action === 'page_eval') return { result: { ok: true } };
      throw new Error(`Unknown action: ${action}`);
    });
    const runtime = await loadPlugin(entry, { options: {}, invoke, progress: vi.fn() });
    await expect(runtime.runToolbox({ command: 'execute', input: { tokens: ['run', item.file] } })).resolves.toEqual({ result: { ok: true } });
    expect(invoke.mock.calls.map(([action]) => action)).toEqual(['tab_list', 'tab_open', 'page_eval']);
    expect(invoke.mock.calls.every(([, , options]) => options.browser === undefined)).toBe(true);
  });

  it('creates a control session once and returns it with adapter errors without retrying', async () => {
    const item = adapter(adapterDirectories().sources.at(-1).directory);
    const session = { sessionId: 's_fixed', browserId: 'browser', status: 'active' };
    const invoke = vi.fn(async action => action === 'tab_list' ? { tabs: [] } : action === 'tab_open'
      ? { tabId: 12, url: 'https://example.test/', session }
      : { result: '{"error":"HTTP 401","hint":"请登录"}', session });
    await expect(executeAdapter(item, {}, { invoke, options: { session: 'new', browser: 'mearl:local:browser' } })).resolves.toMatchObject({ success: false, error: { message: 'HTTP 401' }, hint: '请登录', session });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls[0][2]).toMatchObject({ session: undefined });
    expect(invoke.mock.calls[2][2]).toMatchObject({ session: 's_fixed' });
  });

  it('reuses an existing subdomain page with its current route and state', async () => {
    const item = adapter(adapterDirectories().sources.at(-1).directory);
    const url = 'https://app.example.test/workspace?id=42';
    const invoke = vi.fn(async (action, payload) => {
      if (action === 'tab_list') return { tabs: [{ tabId: 12, url: 'https://example.test.evil.test/' }, { tabId: 13, url }] };
      if (action === 'tab_open') {
        expect(payload.url).toBe(url);
        expect(payload).toMatchObject({ reuse: 'prefer', active: false });
        return { tabId: 13, url, reused: true };
      }
      if (action === 'page_eval') {
        expect(payload.tabId).toBe(13);
        return { result: { state: 'existing-page' } };
      }
      throw new Error(`Unexpected action ${action}`);
    });
    await expect(executeAdapter(item, {}, { invoke, options: { browser: 'mearl:local:browser' } })).resolves.toEqual({ result: { state: 'existing-page' } });
  });

  it('validates explicit tabs and redirects before dispatching adapter code', async () => {
    const item = adapter(adapterDirectories().sources.at(-1).directory);
    const invoke = vi.fn(async action => action === 'tab_list'
      ? { tabs: [{ id: 12, url: 'https://other.test/' }] }
      : { tabId: 12, url: 'https://login.other.test/' });
    for (const tabId of [12, undefined]) await expect(executeAdapter(item, {}, { invoke, options: { browser: 'mearl:local:browser' }, tabId })).rejects.toThrow(/不匹配|跳转/);
    expect(invoke.mock.calls.some(([action]) => action === 'page_eval')).toBe(false);
    expect(domainMatches('https://sub.example.test/path', 'example.test')).toBe(true);
    expect(domainMatches('https://example.test.evil.test', 'example.test')).toBe(false);
    expect(() => domainMatches('https://example.test', 'example.test/path')).toThrow('无效');
  });

  it('handles domainless legacy adapters and pre-existing control sessions', async () => {
    const item = adapter(adapterDirectories().sources.at(-1).directory, 'demo/read', { domain: '' });
    const invoke = vi.fn(async action => action === 'tab_list'
      ? { tabs: [{ id: 1, active: false }, { id: 2, active: true }] }
      : { result: 'plain text' });
    await expect(executeAdapter(item, {}, { invoke, options: { session: 's_existing' } })).resolves.toEqual({ result: 'plain text' });
    expect(invoke).toHaveBeenLastCalledWith('page_eval', expect.objectContaining({ tabId: 2 }), { session: 's_existing' });
  });
});
