import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { bumpVersion, workspaceManifests } from '../bump-version.mjs';

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mearl-version-'));
  directories.push(root);
  for (const path of ['packages/mcp-server', 'packages/cloud/server', 'skills/example']) await mkdir(join(root, path), { recursive: true });
  for (const path of ['package.json', 'packages/mcp-server/package.json', 'packages/cloud/server/package.json']) await writeFile(join(root, path), JSON.stringify({ version: '2.22.0' }));
  await writeFile(join(root, 'packages/mcp-server/server.json'), JSON.stringify({ version: '2.22.0', packages: [{ version: '2.22.0' }] }));
  await writeFile(join(root, 'skills/example/SKILL.md'), '---\nname: example\nversion: "2.22.0"\n---\nBody\nversion: keep-body\n');
  return root;
}
it('updates nested manifests, MCP metadata and Skill frontmatter while retaining body text', async () => {
  const root = await fixture();
  await bumpVersion('3.0.0-beta.0', root);
  for (const path of await workspaceManifests(root)) expect(JSON.parse(await readFile(path, 'utf8')).version).toBe('3.0.0-beta.0');
  expect(JSON.parse(await readFile(join(root, 'packages/mcp-server/server.json'), 'utf8'))).toEqual({ version: '3.0.0-beta.0', packages: [{ version: '3.0.0-beta.0' }] });
  expect(await readFile(join(root, 'skills/example/SKILL.md'), 'utf8')).toContain('version: "3.0.0-beta.0"\n---\nBody\nversion: keep-body');
  expect(JSON.parse(await readFile(join(root, 'skills/catalog.json'), 'utf8'))).toEqual(['example']);
  expect(await readFile(join(root, 'changelogs/v3.0.0-beta.0.md'), 'utf8')).toMatch(/^\[简体中文\].*\[English\]/);
  expect(await readFile(join(root, 'changelogs/v3.0.0-beta.0.en.md'), 'utf8')).toContain('\n### Highlights\n');
});
it('rejects unsupported versions, invalid Skills and existing release notes before changing versions', async () => {
  const root = await fixture();
  await expect(bumpVersion('3.0.0-rc.1', root)).rejects.toThrow('explicit release');
  const skill = join(root, 'skills/example/SKILL.md');
  await writeFile(skill, '---\nname: example\n---\n');
  await expect(bumpVersion('3.0.0-beta.0', root)).rejects.toThrow('top-level version');
  expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('2.22.0');
  await mkdir(join(root, 'changelogs'));
  await writeFile(join(root, 'changelogs/v3.0.0-beta.0.en.md'), 'Edited notes');
  await expect(bumpVersion('3.0.0-beta.0', root)).rejects.toThrow('already exists');
  expect(await readFile(join(root, 'changelogs/v3.0.0-beta.0.en.md'), 'utf8')).toBe('Edited notes');
  expect(await readdir(join(root, 'changelogs'))).toEqual(['v3.0.0-beta.0.en.md']);
  expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('2.22.0');
});

it('keeps the released Skill catalog unique and backed by installable directories', async () => {
  const catalog = JSON.parse(await readFile(new URL('../../skills/catalog.json', import.meta.url), 'utf8'));
  expect(catalog.length).toBeGreaterThan(0);
  expect(new Set(catalog).size).toBe(catalog.length);
  for (const folder of catalog) {
    expect(folder).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(await readFile(new URL(`../../skills/${folder}/SKILL.md`, import.meta.url), 'utf8')).toContain('name: ' + folder);
  }
});

it('prepares a beta build without creating a release note or requiring its own commit', async () => {
  const root = await fixture();
  await bumpVersion('3.0.0-beta.2', root, { changelog: false });
  expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('3.0.0-beta.2');
  expect(JSON.parse(await readFile(join(root, 'skills/catalog.json'), 'utf8'))).toEqual(['example']);
  expect(await readdir(root)).not.toContain('changelogs');
});
