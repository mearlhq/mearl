import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';
import { GUIDE_TOPICS } from '../../packages/client/dist/guide.js';

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mearl-guide-'));
  directories.push(root);
  const pkg = join(root, 'package');
  await mkdir(join(pkg, 'dist'), { recursive: true });
  await cp(new URL('../../packages/client/package.json', import.meta.url), join(pkg, 'package.json'));
  // Only management topics load the declared local metadata dependencies.
  for (const name of ['bin.js', 'guide.js', 'runtimePaths.js', 'guides'])
    await cp(new URL(`../../packages/client/dist/${name}`, import.meta.url), join(pkg, 'dist', name), { recursive: true });
  for (const name of ['cli.js', 'autoUpdate.js', 'socket.js'])
    await writeFile(join(pkg, 'dist', name), 'throw new Error("must not load browser runtime or updater");');
  for (const name of ['daemon-core', 'preset']) {
    const source = new URL(`../../packages/${name}/`, import.meta.url);
    const target = join(pkg, 'node_modules', '@mearl', name);
    await mkdir(target, { recursive: true });
    await cp(new URL('package.json', source), join(target, 'package.json'));
    await cp(new URL('dist/', source), join(target, 'dist'), { recursive: true });
  }
  const require = createRequire(new URL('../../packages/preset/package.json', import.meta.url));
  await cp(dirname(require.resolve('semver/package.json')), join(pkg, 'node_modules/semver'), { recursive: true });
  return { root, pkg, run: args => spawnSync(process.execPath, [join(pkg, 'dist/bin.js'), 'guide', ...args], { cwd: root, encoding: 'utf8', timeout: 10000, env: { ...process.env, MEARL_CAPABILITY_DIR: join(root, 'capabilities') } }) };
}

it('ships the exact canonical CLI guides and reads every topic outside the source checkout', async () => {
  const f = await fixture();
  const version = JSON.parse(await readFile(join(f.pkg, 'package.json'), 'utf8')).version;
  for (const topic of GUIDE_TOPICS) {
    expect(await readFile(join(f.pkg, 'dist/guides', topic.file), 'utf8')).toBe(await readFile(new URL(`../../packages/client/guides/${topic.file}`, import.meta.url), 'utf8'));
    const result = f.run([topic.id]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`CLI ${version} · ${topic.id}`);
    expect(result.stdout).toContain(`[mearl:guide] end ${topic.id}`);
    expect(result.stdout).not.toMatch(/\]\(\.\.?\//);
  }
});

it('defaults to core, rejects unknown paths and fails explicitly when packaged content is missing', async () => {
  const f = await fixture();
  expect(f.run([]).stdout).toContain('· core');
  const manifestPath = join(f.pkg, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: '9.9.9-beta.1' }));
  expect(f.run([]).stdout).toContain('CLI 9.9.9-beta.1 · core');
  expect(f.run(['--help']).status).toBe(0);
  expect(f.run(['--list']).status).toBe(0);
  for (const id of ['../core', '/etc/passwd', 'unknown', '--full']) expect(f.run([id]).status).toBe(2);
  await rm(join(f.pkg, 'dist/guides/core.md'));
  const missing = f.run([]);
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('缺少指南资源');
  expect(missing.stderr).toContain('修复安装包');
  expect(f.run(['--list']).status).toBe(0);
});

it('distributes only the thin Skill entry, without a duplicate guide tree', async () => {
  expect((await readdir(new URL('../../skills/mearl/', import.meta.url))).filter(name => name !== '.DS_Store')).toEqual(['SKILL.md']);
});

it('keeps core and topic discovery independent of management dependencies', async () => {
  const f = await fixture();
  await rm(join(f.pkg, 'node_modules'), { recursive: true });
  expect(f.run([]).status).toBe(0);
  expect(f.run(['--list']).status).toBe(0);
  expect(f.run(['troubleshooting']).status).toBe(1);
});
