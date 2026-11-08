import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { preparePreset } from '@mearl/preset/bundles';
import { PresetInstallationStore, claimPresetInstallation } from '../preset.js';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  findPluginEntry,
  findPluginRegistration,
  OFFICIAL_PLUGIN_MANAGER,
  registerPlugin,
  replaceOfficialPluginCatalog,
} from '@mearl/client/plugin';
import {
  ensureOfficialPlugin,
  installPlugins,
  parseInstalledPluginPaths,
  setupPlugin,
  uninstallPlugin,
} from '../plugin.js';
import { ensurePluginRuntime } from '../pluginRuntime.js';

vi.mock('../pluginRuntime.js', () => ({ ensurePluginRuntime: vi.fn() }));
vi.mock('node:os', async importOriginal => {
  const original = await importOriginal<typeof import('node:os')>();
  return { ...original, homedir: vi.fn(original.homedir) };
});
let directory: string;
let entry: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mearl-setup-plugin-'));
  vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
  replaceOfficialPluginCatalog('a'.repeat(64), {
    identity: { description: 'Identity adapter', skill: 'identity-request', installArgs: ['https://github.com/mearlhq/mearl', '--skill', 'identity-request', '--yes'] },
    headers: { description: 'Headers adapter', skill: 'headers-request', installArgs: ['https://github.com/mearlhq/mearl', '--skill', 'headers-request', '--yes'] },
  });
  vi.mocked(homedir).mockReturnValue(directory);
  vi.mocked(ensurePluginRuntime).mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  entry = join(directory, 'scripts', 'main.mjs');
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(
    entry,
    `export const name = 'sample'; export const description = 'Short plugin summary'; export default app => { app.command('hello', () => 'hello'); };`,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

it('registers a directory or custom entry and validates before rebinding', async () => {
  expect(await setupPlugin(directory)).toEqual({ entry, name: 'sample' });
  expect(findPluginRegistration('sample')).toEqual({
    entry,
    hasPublicCommands: true,
    description: 'Short plugin summary',
    source: { entry: expect.any(String) },
  });
  const invalid = join(directory, 'broken.mjs');
  writeFileSync(invalid, 'export default {};');
  await expect(setupPlugin(invalid)).rejects.toThrow('PLUGIN_LOAD_FAILED');
  expect(findPluginEntry('sample')).toBe(entry);
  const custom = join(directory, 'custom.mjs');
  writeFileSync(
    custom,
    `export const name = 'sample'; export default app => { app.command('hello', () => 'custom'); };`,
  );
  expect(await setupPlugin(custom)).toEqual({ entry: custom, name: 'sample' });
  expect(findPluginEntry('sample')).toBe(custom);
});

it('awaits Skill setup before registration and retries failed setup', async () => {
  writeFileSync(entry, `export const name = 'sample';
export async function setup({runCommand}) { const result = await runCommand('node', ['prepare-dependencies']); if (result.code) throw new Error(result.stderr); }
export default app => app.command('hello', () => 'ready');`);
  const failure = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'Registry offline' });
  await expect(setupPlugin(directory, undefined, failure)).rejects.toThrow('Registry offline');
  expect(findPluginRegistration('sample')).toBeUndefined();
  const runner = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
  await expect(setupPlugin(directory, undefined, runner)).resolves.toEqual({ name: 'sample', entry });
  expect(runner).toHaveBeenCalledTimes(1);
  expect(findPluginRegistration('sample')?.entry).toBe(entry);
});

it('lets an explicit name override metadata and otherwise falls back to the skill directory', async () => {
  expect(await setupPlugin(directory, 'alias')).toEqual({ entry, name: 'alias' });
  expect(findPluginEntry('alias')).toBe(entry);
  const fallbackDirectory = join(directory, 'fallback-skill');
  const fallbackEntry = join(fallbackDirectory, 'scripts', 'main.mjs');
  mkdirSync(dirname(fallbackEntry), { recursive: true });
  writeFileSync(fallbackEntry, `export default app => app.command('hello', () => 'hello');`);
  expect(await setupPlugin(fallbackDirectory)).toEqual({
    entry: fallbackEntry,
    name: 'fallback-skill',
  });
  expect(findPluginEntry('fallback-skill')).toBe(fallbackEntry);
});

it('persists toolbox metadata exported by a registered plugin', async () => {
  const page = join(directory, 'assets', 'toolbox', 'index.html');
  mkdirSync(dirname(page), { recursive: true });
  writeFileSync(page, '<!doctype html><html><body>Workspace Notes</body></html>');
  writeFileSync(
    entry,
    `export const name = 'notebook';
     export const toolbox = { version: 1, title: 'Workspace Notes', icon: 'git-branch', page: { type: 'sandbox', entry: 'assets/toolbox/index.html', commands: ['list'] } };
     export default app => app.command('list', () => ({ items: [] }));`,
  );
  await setupPlugin(directory);
  expect(findPluginRegistration('notebook')?.toolbox).toEqual({
    version: 1,
    title: 'Workspace Notes',
    icon: 'git-branch',
    page: {
      type: 'sandbox',
      entry: 'assets/toolbox/index.html',
      commands: ['list'],
    },
  });
  expect(findPluginRegistration('notebook')?.pageBundle?.hash).toMatch(/^[a-f0-9]{64}$/);
});

it('derives CLI visibility from public commands for toolbox-only plugins', async () => {
  const page = join(directory, 'assets', 'toolbox', 'index.html');
  mkdirSync(dirname(page), { recursive: true });
  writeFileSync(page, '<!doctype html><html><body>Tool</body></html>');
  writeFileSync(
    entry,
    `export const name='translate';
    export const toolbox={version:1,title:'翻译',displayMode:'popup',page:{type:'sandbox',entry:'assets/toolbox/index.html',commands:['start']}};
    export default app=>app.toolboxCommand('start',()=>{throw new Error('must not execute');});`,
  );
  await setupPlugin(directory);
  expect(findPluginRegistration('translate')).toMatchObject({
    hasPublicCommands: false,
    toolbox: { displayMode: 'popup' },
  });
});

it('does not bind a plugin when runtime setup fails', async () => {
  vi.mocked(ensurePluginRuntime).mockRejectedValueOnce(new Error('update failed'));
  await expect(setupPlugin(directory)).rejects.toThrow('update failed');
  expect(findPluginEntry('sample')).toBeUndefined();
});

it('unregisters a manually registered plugin without deleting its source', async () => {
  await setupPlugin(directory);
  const runner = vi.fn();
  await expect(uninstallPlugin('sample', runner)).resolves.toEqual({
    removed: true,
    unregisteredNames: ['sample'],
  });
  expect(findPluginEntry('sample')).toBeUndefined();
  expect(runner).not.toHaveBeenCalled();
  expect(() => writeFileSync(entry, 'still writable')).not.toThrow();
  await expect(uninstallPlugin('sample', runner)).resolves.toEqual({
    removed: false,
    unregisteredNames: [],
  });
});

it('removes an installed Skill symlink and plugin registrations while preserving source', async () => {
  const source = join(directory, 'source', 'sample');
  const sourceEntry = join(source, 'scripts', 'main.mjs');
  mkdirSync(dirname(sourceEntry), { recursive: true });
  writeFileSync(join(source, 'SKILL.md'), '---\nname: sample\n---\n');
  writeFileSync(
    sourceEntry,
    `export const name = 'sample'; export default app => app.command('hello', () => 'hello');`,
  );
  const installedSkill = join(directory, '.agents', 'skills', 'sample');
  mkdirSync(dirname(installedSkill), { recursive: true });
  symlinkSync(source, installedSkill, 'dir');
  await setupPlugin(source);
  registerPlugin('alias', sourceEntry);
  const runner = vi.fn(async () => {
    unlinkSync(installedSkill);
    return { code: 0, stdout: '', stderr: '' };
  });

  await expect(uninstallPlugin('sample', runner)).resolves.toEqual({
    removed: true,
    skillName: 'sample',
    unregisteredNames: ['alias', 'sample'],
  });
  expect(runner.mock.calls[0][1].slice(-4)).toEqual(['remove', 'sample', '--global', '--yes']);
  expect(existsSync(installedSkill)).toBe(false);
  expect(existsSync(sourceEntry)).toBe(true);
  expect(findPluginEntry('sample')).toBeUndefined();
  expect(findPluginEntry('alias')).toBeUndefined();
});

it('removes a project Skill without removing the same source installed globally', async () => {
  const source = join(directory, 'source', 'sample');
  const sourceEntry = join(source, 'scripts', 'main.mjs');
  mkdirSync(dirname(sourceEntry), { recursive: true });
  writeFileSync(join(source, 'SKILL.md'), '---\nname: sample\n---\n');
  writeFileSync(sourceEntry, `export default app => app.command('hello', () => 'hello');`);
  const globalSkill = join(directory, '.agents', 'skills', 'sample');
  const workspace = join(directory, 'workspace');
  const projectSkill = join(workspace, '.agents', 'skills', 'sample');
  mkdirSync(dirname(globalSkill), { recursive: true });
  mkdirSync(dirname(projectSkill), { recursive: true });
  symlinkSync(source, globalSkill, 'dir');
  symlinkSync(source, projectSkill, 'dir');
  const projectEntry = join(projectSkill, 'scripts', 'main.mjs');
  registerPlugin('sample', projectEntry, undefined, { managedBy: 'skills' });
  registerPlugin('alias', projectEntry);
  const runner = vi.fn(async (_command, _args, options) => {
    expect(options?.cwd).toBe(workspace);
    unlinkSync(projectSkill);
    return { code: 0, stdout: '', stderr: '' };
  });

  await expect(uninstallPlugin('sample', runner)).resolves.toEqual({
    removed: true,
    skillName: 'sample',
    unregisteredNames: ['alias', 'sample'],
  });
  expect(runner.mock.calls[0][1].slice(-3)).toEqual(['remove', 'sample', '--yes']);
  expect(existsSync(projectSkill)).toBe(false);
  expect(existsSync(globalSkill)).toBe(true);
  expect(existsSync(sourceEntry)).toBe(true);
  expect(findPluginEntry('sample')).toBeUndefined();
  expect(findPluginEntry('alias')).toBeUndefined();
});

function installSkill(
  name: string,
  source = `export default app => app.command('hello', () => 'hello');`,
) {
  const skill = join(directory, '.agents', 'skills', name);
  mkdirSync(join(skill, 'scripts'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`);
  writeFileSync(join(skill, 'scripts', 'main.mjs'), source);
  return join(skill, 'scripts', 'main.mjs');
}

function installPythonSkill(name: string) {
  const skill = join(directory, '.agents', 'skills', name);
  const pythonEntry = join(skill, 'scripts', 'main.py');
  mkdirSync(dirname(pythonEntry), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`);
  writeFileSync(
    pythonEntry,
    `name = "${name}"
description = "Python plugin"

def register(app):
    app.command("hello", lambda input: "hello", "问候")
`,
  );
  return pythonEntry;
}

function report(...names: string[]) {
  return `◇  Installed ${names.length} skill${names.length === 1 ? '' : 's'} ───╮\n│\n${names.map(name => `│  ✓ ~/.agents/skills/${name}  │\n│    symlinked: Codex, Claude Code  │`).join('\n')}\n├────────────────────╯\n`;
}

it('repairs a manually deleted skills directory so removal can clear its tracking record', async () => {
  const managedEntry = installSkill('sample');
  const skillDirectory = dirname(dirname(managedEntry));
  await setupPlugin(managedEntry);
  registerPlugin('alias', managedEntry);
  rmSync(skillDirectory, { recursive: true });
  const runner = vi.fn(async () => {
    expect(existsSync(skillDirectory)).toBe(true);
    return { code: 0, stdout: '', stderr: '' };
  });
  await expect(uninstallPlugin('sample', runner)).resolves.toEqual({
    entryMissing: true,
    removed: true,
    skillName: 'sample',
    unregisteredNames: ['alias', 'sample'],
  });
  expect(runner).toHaveBeenCalledOnce();
  expect(runner.mock.calls[0][1].slice(-4)).toEqual(['remove', 'sample', '--global', '--yes']);
  expect(runner.mock.calls[0][2]).toMatchObject({ env: expect.any(Object), tee: true });
  expect(findPluginEntry('sample')).toBeUndefined();
  expect(findPluginEntry('alias')).toBeUndefined();
  expect(existsSync(skillDirectory)).toBe(false);
});

it('keeps an skills managed registration when removal fails', async () => {
  const managedEntry = installSkill('sample');
  await setupPlugin(managedEntry);
  const runner = vi.fn().mockResolvedValue({ code: 7, stdout: '', stderr: '' });
  await expect(uninstallPlugin('sample', runner)).rejects.toThrow('exit 7');
  expect(findPluginEntry('sample')).toBe(managedEntry);
});

it('parses the two-skill Installed output from Skills', () => {
  const output = `│
◇  Installed 2 skills ───────────────╮
│                                    │
│  ✓ ~/.agents/skills/sample-doc-fetch  │
│    symlinked: Codex, Claude Code   │
│  ✓ ~/.agents/skills/mearl          │
│    symlinked: Codex, Claude Code   │
│                                    │
├────────────────────────────────────╯`;
  expect(parseInstalledPluginPaths(output)).toEqual([
    join(directory, '.agents', 'skills', 'sample-doc-fetch'),
    join(directory, '.agents', 'skills', 'mearl'),
  ]);
});

it('parses only successful result paths, strips ANSI, and supports absolute and Windows separators', () => {
  const output = `◇  Installation Summary ──╮\n│ ✓ ~/.agents/skills/unrelated │\n╰──╯\n${report('sample')}│ ✓ ~/.agents/skills/also-unrelated │\n└ Done!`;
  expect(
    parseInstalledPluginPaths(
      output.replace('✓ ~/.agents/skills/sample', '\u001b[32m✓\u001b[0m ~/.agents/skills/sample'),
    ),
  ).toEqual([join(directory, '.agents', 'skills', 'sample')]);
  expect(
    parseInstalledPluginPaths(
      report('sample').replace(
        '~/.agents/skills/sample',
        join(directory, '.agents', 'skills', 'sample'),
      ),
    ),
  ).toHaveLength(1);
  expect(parseInstalledPluginPaths(report('sample').replaceAll('/', '\\'))).toHaveLength(1);
});

it('rejects changed or incomplete result formats and paths outside the shared skill directory', () => {
  expect(() => parseInstalledPluginPaths(report('sample').replace('✓', '→'))).toThrow(
    '格式无法识别',
  );
  expect(() => parseInstalledPluginPaths(report('sample').replace('1 skill', '2 skills'))).toThrow(
    '格式无法识别',
  );
  expect(() => parseInstalledPluginPaths(report('../outside'))).toThrow('安装路径');
  expect(parseInstalledPluginPaths('Installation cancelled')).toEqual([]);
});

it('only runs add, forces global scope, and registers new default and named entries', async () => {
  installSkill('unrelated', `throw new Error('must not load existing skills');`);
  const args = [
    './source with spaces',
    '--skill',
    'sample-doc-fetch',
    'sample',
    '--agent',
    'codex',
    '--project',
    '--yes',
  ];
  const runner = vi.fn(async () => {
    installSkill(
      'sample-doc-fetch',
      `export const name = 'sample-docs'; export const description = 'Read sample documents'; export default app => app.command('read <url>', () => 'ok');`,
    );
    installSkill('sample');
    const ordinary = join(directory, '.agents', 'skills', 'ordinary');
    mkdirSync(ordinary);
    writeFileSync(join(ordinary, 'SKILL.md'), 'plain skill');
    writeFileSync(
      join(ordinary, 'main.mjs'),
      `export default app => app.command('legacy', () => 'ignored');`,
    );
    return { code: 0, stdout: report('sample-doc-fetch', 'sample', 'ordinary'), stderr: '' };
  });
  expect(await installPlugins(args, runner)).toBe(0);
  expect(runner).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/npx(?:\.cmd)?$/),
    ['-y', 'skills@1.5.0', 'add', ...args, '--global'],
    expect.objectContaining({ env: expect.any(Object), tee: true }),
  );
  expect(ensurePluginRuntime).toHaveBeenCalledExactlyOnceWith(runner);
  expect(findPluginEntry('sample-docs')).toBe(
    join(directory, '.agents', 'skills', 'sample-doc-fetch', 'scripts', 'main.mjs'),
  );
  expect(findPluginRegistration('sample-docs')?.description).toBe('Read sample documents');
  expect(findPluginEntry('sample')).toBe(
    join(directory, '.agents', 'skills', 'sample', 'scripts', 'main.mjs'),
  );
  expect(findPluginEntry('unrelated')).toBeUndefined();
  expect(findPluginEntry('ordinary')).toBeUndefined();
});

it('automatically registers an installed skill with a Python entry', async () => {
  let pythonEntry = '';
  const runner = vi.fn(async () => {
    pythonEntry = installPythonSkill('python-sample');
    return { code: 0, stdout: report('python-sample'), stderr: '' };
  });

  expect(await installPlugins(['./python-sample', '--yes'], runner)).toBe(0);
  expect(findPluginEntry('python-sample')).toBe(pythonEntry);
  expect(findPluginRegistration('python-sample')?.description).toBe('Python plugin');
  expect(ensurePluginRuntime).toHaveBeenCalledExactlyOnceWith(runner);
});

it('records the manager for automatically maintained plugin registrations', async () => {
  const runner = vi.fn(async () => {
    installSkill('sample');
    return { code: 0, stdout: report('sample'), stderr: '' };
  });

  expect(
    await installPlugins(['./sample', '-y'], runner, { registrationManagedBy: '@mearl/setup' }),
  ).toBe(0);
  expect(findPluginRegistration('sample')).toMatchObject({ managedBy: '@mearl/setup' });
});

it('installs an official plugin by catalog name and records official ownership', async () => {
  const runner = vi.fn(async () => {
    installSkill(
      'identity-request',
      `export const name = 'identity'; export default app => app.command('whoami', () => ({}));`,
    );
    return { code: 0, stdout: report('identity-request'), stderr: '' };
  });

  await expect(ensureOfficialPlugin('identity', runner)).resolves.toBe('installed');
  expect(runner.mock.calls[0][1]).toEqual([
    '-y',
    'skills@1.5.0',
    'add',
    'https://github.com/mearlhq/mearl',
    '--skill',
    'identity-request',
    '--yes',
    '--global',
  ]);
  expect(findPluginRegistration('identity')).toMatchObject({
    managedBy: OFFICIAL_PLUGIN_MANAGER,
  });
  await expect(ensureOfficialPlugin('identity', runner)).resolves.toBe('existing');
  await expect(ensureOfficialPlugin('unknown', runner)).rejects.toThrow('未知官方插件');
});

it('installs Headers only when its official plugin is requested', async () => {
  const runner = vi.fn(async () => {
    installSkill(
      'headers-request',
      `export const name = 'headers'; export default app => app.command('request <url> [audience]', () => ({}));`,
    );
    return { code: 0, stdout: report('headers-request'), stderr: '' };
  });

  await expect(ensureOfficialPlugin('headers', runner)).resolves.toBe('installed');
  expect(runner.mock.calls[0][1]).toEqual([
    '-y',
    'skills@1.5.0',
    'add',
    'https://github.com/mearlhq/mearl',
    '--skill',
    'headers-request',
    '--yes',
    '--global',
  ]);
  expect(findPluginRegistration('headers')).toMatchObject({ managedBy: OFFICIAL_PLUGIN_MANAGER });
});

it('registers a reinstalled entry even when its contents are identical', async () => {
  const previous = installSkill('sample');
  const runner = vi.fn(async () => {
    rmSync(dirname(previous), { recursive: true });
    installSkill('sample');
    return { code: 0, stdout: report('sample'), stderr: '' };
  });
  expect(await installPlugins(['./sample', '-y'], runner)).toBe(0);
  expect(findPluginEntry('sample')).toBe(previous);
});

it('preserves add failures and does not register partially installed entries', async () => {
  const runner = vi.fn(async () => {
    installSkill('partial');
    return { code: 7, stdout: '', stderr: '' };
  });
  expect(await installPlugins(['./source'], runner)).toBe(7);
  expect(ensurePluginRuntime).not.toHaveBeenCalled();
  expect(findPluginEntry('partial')).toBeUndefined();
});

it.each([
  { args: [], stdout: '' },
  { args: ['--help'], stdout: '' },
  { args: ['source', '--list'], stdout: '' },
  { args: ['source'], stdout: 'Installation cancelled' },
])('does not update the runtime when add produces no entries: $args', async ({ args, stdout }) => {
  const runner = vi.fn().mockResolvedValue({ code: 0, stdout, stderr: '' });
  expect(await installPlugins(args, runner)).toBe(0);
  expect(ensurePluginRuntime).not.toHaveBeenCalled();
});

it('rejects ambiguous pass-through and successful output that cannot identify installed skills', async () => {
  const runner = vi.fn().mockResolvedValue({ code: 0, stdout: 'Added one skill', stderr: '' });
  await expect(installPlugins(['source', '--'], runner)).rejects.toThrow('不支持 -- 参数分隔符');
  expect(runner).not.toHaveBeenCalled();
  await expect(installPlugins(['source'], runner)).rejects.toThrow('无法识别安装结果');
  expect(ensurePluginRuntime).not.toHaveBeenCalled();
});

it('validates all new namespaces before registering any', async () => {
  const runner = vi.fn(async () => {
    installSkill(
      'first',
      `export const name = 'same'; export default app => app.command('hello', () => 'ok');`,
    );
    installSkill(
      'second',
      `export const name = 'same'; export default app => app.command('hello', () => 'ok');`,
    );
    return { code: 0, stdout: report('first', 'second'), stderr: '' };
  });
  await expect(installPlugins(['source'], runner)).rejects.toThrow('多个 skill');
  expect(findPluginEntry('same')).toBeUndefined();
  expect(ensurePluginRuntime).not.toHaveBeenCalled();
});

it('installs a profile-only plugin without a toolbox contribution', async () => {
  const name = 'maps';
  const root = join(directory, '.agents', 'skills', name);
  const profileEntry = join(root, 'scripts', 'main.mjs');
  mkdirSync(dirname(profileEntry), { recursive: true });
  writeFileSync(join(root, 'SKILL.md'), '---\nname: maps\n---\n');
  const profile = {
    name: 'sample',
    label: 'Sample Maps',
    appName: 'sample',
    defaultAppVersion: '1',
    uaTokens: [],
    globals: {},
    bridges: [{ global: 'MapApp.bridge', style: 'sample' }],
    activeEvents: [],
    schemes: [],
    actions: { open: [], close: [], title: [], systemInfo: [], protocol: [], noop: [] },
  };
  writeFileSync(
    profileEntry,
    `export const name = 'maps'; export const appProfiles = ${JSON.stringify({ version: 1, profiles: [profile] })};`,
  );
  const runner = vi.fn().mockResolvedValue({ code: 0, stdout: report(name), stderr: '' });
  expect(await installPlugins(['./maps', '--yes'], runner)).toBe(0);
  expect(findPluginRegistration('maps')?.appProfiles?.profiles[0].name).toBe('sample');
  expect(findPluginRegistration('maps')?.toolbox).toBeUndefined();
});

it('registers copied Skills through the canonical path in the JSON list', async () => {
  const path = join(directory, '.agents', 'skills', 'copied');
  const runner = vi.fn(async (_command: string, args: string[]) => {
    if (args.includes('list')) return { code: 0, stdout: JSON.stringify([{ name: 'copied', path, scope: 'global' }]), stderr: '' };
    installSkill('copied');
    return { code: 0, stdout: 'Installed 1 skill\n│ ✓ copied (copied)\n└ Done', stderr: '' };
  });
  await expect(installPlugins(['./copied', '--yes'], runner)).resolves.toBe(0);
  expect(findPluginEntry('copied')).toBe(join(path, 'scripts/main.mjs'));
  expect(runner).toHaveBeenCalledTimes(2);
});

it('rejects an unconfirmed or escaped copied Skill without registering anything', async () => {
  const report = 'Installed 1 skill\n│ ✓ copied (copied)\n└ Done';
  expect(() => parseInstalledPluginPaths(report)).toThrow('JSON');
  expect(() => parseInstalledPluginPaths(report, [{ name: 'copied', path: '/outside/copied', scope: 'global' }])).toThrow('全局');
  const runner = vi.fn(async (_command: string, args: string[]) => ({ code: 0, stdout: args.includes('list') ? '[]' : report, stderr: '' }));
  await expect(installPlugins(['./copied', '--yes'], runner)).rejects.toThrow('JSON');
  expect(findPluginEntry('copied')).toBeUndefined();
});


it('uses an explicit Skills CLI for plugin installation', async () => {
  const cli = join(directory, 'skills');
  writeFileSync(cli, '#!/bin/sh\n');
  const { chmodSync } = await import('node:fs');
  chmodSync(cli, 0o700);
  const runner = vi.fn(async () => ({ code: 0, stdout: 'Installation cancelled', stderr: '' }));
  await expect(installPlugins(['source'], runner, { env: { MEARL_SKILLS_PATH: cli } })).resolves.toBe(0);
  expect(runner).toHaveBeenCalledWith(cli, ['add', 'source', '--global'], expect.objectContaining({ tee: true }));
});

it('keeps a user alias and shared Skill source during managed uninstall', async () => {
  const skillDirectory = join(directory, '.agents', 'skills', 'shared');
  const sharedEntry = join(skillDirectory, 'scripts', 'main.mjs');
  mkdirSync(dirname(sharedEntry), { recursive: true });
  writeFileSync(sharedEntry, 'export default app => {};');
  registerPlugin('managed', sharedEntry, undefined, { managedBy: OFFICIAL_PLUGIN_MANAGER });
  registerPlugin('my-alias', sharedEntry);
  const runner = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
  await expect(uninstallPlugin('managed', runner, { preserveRegistrationsOutsideManager: OFFICIAL_PLUGIN_MANAGER })).resolves.toEqual({ removed: true, unregisteredNames: ['managed'] });
  expect(runner).not.toHaveBeenCalled();
  expect(findPluginRegistration('managed')).toBeUndefined();
  expect(findPluginEntry('my-alias')).toBe(sharedEntry);
  expect(existsSync(sharedEntry)).toBe(true);
});


it('does not replace a user registration in a managed multi-Skill install', async () => {
  registerPlugin('sample', entry);
  const runner = vi.fn(async () => {
    installSkill('sample');
    return { code: 0, stdout: report('sample'), stderr: '' };
  });
  await installPlugins(['source', '--yes'], runner, { registrationManagedBy: OFFICIAL_PLUGIN_MANAGER });
  expect(findPluginEntry('sample')).toBe(entry);
  expect(findPluginRegistration('sample')?.managedBy).toBeUndefined();
});


it.each(['Failed to remove 1 skill(s)', ''])('retains registrations when a zero-exit removal leaves the Skill present (%s)', async output => {
  const managedEntry = installSkill('sample');
  registerPlugin('sample', managedEntry, undefined, { managedBy: OFFICIAL_PLUGIN_MANAGER });
  const runner = vi.fn(async () => ({ code: 0, stdout: output, stderr: '' }));
  await expect(uninstallPlugin('sample', runner)).rejects.toThrow('注册已保留');
  expect(findPluginEntry('sample')).toBe(managedEntry);
  expect(existsSync(managedEntry)).toBe(true);
});

it('keeps plugin installation, registration and removal on the locally selected manager', async () => {
  const { createHash } = await import('node:crypto');
  const { prepareCapabilitySnapshot } = await import('@mearl/preset');
  const folder = join(directory, '.mearl', 'capabilities');
  mkdirSync(join(folder, 'objects'), { recursive: true });
  const source = 'module.exports=host=>({manager:()=>({id:"workspace-skills",cli:(args,options)=>host.runCommand("private-cli",args,options)})})';
  const sha256 = createHash('sha256').update(source).digest('hex');
  writeFileSync(join(folder, 'objects', sha256 + '.cjs'), source);
  const snapshot = await prepareCapabilitySnapshot({ schemaVersion: 1, modules: { manager: { sha256, byteLength: Buffer.byteLength(source) } }, bindings: { 'skills.manager': { module: 'manager', handler: 'manager' } } });
  writeFileSync(join(folder, 'active-node.json'), JSON.stringify(snapshot));
  const runner = vi.fn(async (_command: string, args: string[]) => {
    if (args[0] === 'add') { installSkill('sample'); return { code: 0, stdout: report('sample'), stderr: '' }; }
    rmSync(join(directory, '.agents', 'skills', 'sample'), { recursive: true, force: true });
    return { code: 0, stdout: '', stderr: '' };
  });
  expect(await installPlugins(['https://github.com/example/skills', '--skill', 'sample'], runner)).toBe(0);
  expect(findPluginRegistration('sample')?.managedBy).toBe('workspace-skills');
  expect(runner).toHaveBeenCalledWith('private-cli', ['add', 'https://github.com/example/skills', '--skill', 'sample', '--global'], { tee: true });
  expect((await uninstallPlugin('sample', runner)).removed).toBe(true);
  expect(runner).toHaveBeenLastCalledWith('private-cli', ['remove', 'sample', '--global', '--yes'], { tee: true });
});

it('retains completed files but refuses registration when the accepted catalog changes during installation', async () => {
  const runner = vi.fn(async () => {
    installSkill('identity-request', 'export const name="identity"; export default app=>app.command("whoami",()=>({}));');
    replaceOfficialPluginCatalog('b'.repeat(64), {});
    return { code: 0, stdout: report('identity-request'), stderr: '' };
  });
  await expect(ensureOfficialPlugin('identity', runner)).rejects.toThrow('CATALOG_SELECTION_CHANGED');
  expect(findPluginRegistration('identity')).toBeUndefined();
  expect(existsSync(join(directory, '.agents', 'skills', 'identity-request', 'SKILL.md'))).toBe(true);
});

async function selectManagedIdentity(migrateFrom?: string[]) {
  const source = 'https://github.com/example/skills#stable';
  const prepared = await preparePreset('https://fixture.test/preset.json', { mearlApiVersion: '1.0.0', load: async () => Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'team', version: '1.0.0', skills: { 'identity-request': { source, version: '^3', ...(migrateFrom ? { migrateFrom } : {}) } } })) });
  const folder = join(directory, '.mearl', 'capabilities');
  const store = new PresetInstallationStore({ directory: folder });
  const receipt = await store.apply(prepared, { expectedRevision: null });
  const current = await store.current();
  replaceOfficialPluginCatalog(receipt.revision, { identity: { description: 'Identity', skill: 'identity-request', installArgs: [source, '--skill', 'identity-request', '--yes'] } }, { path: join(folder, 'active-node.json'), sha256: current.rawHash! });
  return { source, folder };
}

it.each([
  { source: 'https://github.com/example/skills', ref: 'stable', version: '3.1.0', error: undefined },
  { source: 'https://github.com/example/skills', ref: 'other', version: '3.1.0', error: 'SKILL_SOURCE_CONFLICT' },
  { source: 'https://github.com/example/other', ref: 'stable', version: '3.1.0', error: 'SKILL_SOURCE_CONFLICT' },
  { source: 'https://github.com/example/skills', ref: 'stable', version: '2.9.0', error: 'SKILL_VERSION_REQUIRED' },
])('verifies the selected source, ref and version before registering a preset alias ($ref, $version, $source)', async ({ source, ref, version, error }) => {
  await selectManagedIdentity();
  // The caller's state directory also owns its manager's existing source receipt.
  vi.stubEnv('XDG_STATE_HOME', join(directory, 'state'));
  const runner = vi.fn(async () => {
    const installed = installSkill('identity-request', 'export const name="identity"; export default app=>app.command("whoami",()=>({}));');
    writeFileSync(join(dirname(dirname(installed)), 'SKILL.md'), `---\nname: identity-request\nversion: ${version}\n---\n`);
    const state = join(directory, 'state', 'skills');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, '.skill-lock.json'), JSON.stringify({ skills: { 'identity-request': { sourceUrl: source, sourceType: 'github', ref } } }));
    return { code: 0, stdout: report('identity-request'), stderr: '' };
  });
  if (error) {
    await expect(ensureOfficialPlugin('identity', runner)).rejects.toThrow(error);
    expect(findPluginRegistration('identity')).toBeUndefined();
    expect(ensurePluginRuntime).not.toHaveBeenCalled();
  } else {
    await expect(ensureOfficialPlugin('identity', runner)).resolves.toBe('installed');
    expect(findPluginRegistration('identity')?.managedBy).toBe(OFFICIAL_PLUGIN_MANAGER);
  }
  expect(existsSync(join(directory, '.agents', 'skills', 'identity-request', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(directory, '.agents', '.mearl-preset-install.json'))).toBe(false);
});

it('refuses on-demand installation while the preset batch owns the global Skills directory', async () => {
  const lease = claimPresetInstallation();
  const runner = vi.fn();
  try {
    await expect(ensureOfficialPlugin('identity', runner)).rejects.toThrow('PRESET_INSTALL_BUSY');
    expect(runner).not.toHaveBeenCalled();
  } finally { lease.release(); }
});

it('keeps the preset lease through an on-demand command and releases it on failure', async () => {
  let started!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const runner = vi.fn(async () => { started(); await gate; return { code: 7, stdout: '', stderr: '' }; });
  const running = ensureOfficialPlugin('identity', runner);
  await entered;
  try { expect(() => claimPresetInstallation()).toThrow('PRESET_INSTALL_BUSY'); }
  finally { finish(); }
  await expect(running).rejects.toThrow('exit 7');
  const lease = claimPresetInstallation();
  lease.release();
});


it('migrates an existing setup registration on demand and retains disabled state', async () => {
  const { source } = await selectManagedIdentity(['https://github.com/example/skills']);
  const target = installSkill('identity-request', 'export const name="identity"; export default app=>app.command("whoami",()=>({}));');
  const manifest = join(dirname(dirname(target)), 'SKILL.md');
  writeFileSync(manifest, '---\nname: identity-request\nversion: 2.0.0\n---\n');
  renameSync(manifest, manifest + '.mearl-disabled');
  const lock = join(directory, '.agents/.skill-lock.json');
  writeFileSync(lock, JSON.stringify({ skills: { 'identity-request': { sourceUrl: 'https://github.com/example/skills', sourceType: 'github' } } }));
  registerPlugin('identity', target, undefined, { managedBy: OFFICIAL_PLUGIN_MANAGER });
  const runner = vi.fn(async () => {
    installSkill('identity-request', 'export const name="identity"; export default app=>app.command("whoami",()=>({}));');
    writeFileSync(manifest, '---\nname: identity-request\nversion: 3.1.0\n---\n');
    writeFileSync(lock, JSON.stringify({ skills: { 'identity-request': { sourceUrl: 'https://github.com/example/skills', sourceType: 'github', ref: 'stable' } } }));
    return { code: 0, stdout: report('identity-request'), stderr: '' };
  });
  await expect(ensureOfficialPlugin('identity', runner)).resolves.toBe('installed');
  expect(findPluginRegistration('identity')?.managedBy).toBe(OFFICIAL_PLUGIN_MANAGER);
  expect(existsSync(manifest)).toBe(false);
  expect(existsSync(manifest + '.mearl-disabled')).toBe(true);
  await expect(ensureOfficialPlugin('identity', runner)).resolves.toBe('existing');
  expect(runner).toHaveBeenCalledOnce();
  expect(runner.mock.calls[0]).toEqual(expect.arrayContaining([expect.any(String), expect.arrayContaining([source])]));
});

it('rechecks migration ownership after confirmation before invoking an external installer', async () => {
  const { source } = await selectManagedIdentity(['https://github.com/example/skills']);
  const target = installSkill('identity-request', 'export const name="identity"; export default app=>app.command("whoami",()=>({}));');
  writeFileSync(join(directory, '.agents/.skill-lock.json'), JSON.stringify({ skills: { 'identity-request': { sourceUrl: 'https://github.com/example/skills', sourceType: 'github' } } }));
  registerPlugin('identity', target, undefined, { managedBy: OFFICIAL_PLUGIN_MANAGER });
  const runner = vi.fn();
  await expect(installPlugins([source, '--skill', 'identity-request', '--yes'], runner, {
    expectedSkill: 'identity-request', registrationManagedBy: OFFICIAL_PLUGIN_MANAGER,
    confirm: () => { registerPlugin('identity', target); },
  })).rejects.toThrow('SKILL_SOURCE_CONFLICT');
  expect(runner).not.toHaveBeenCalled();
  expect(findPluginRegistration('identity')?.managedBy).toBeUndefined();
});
