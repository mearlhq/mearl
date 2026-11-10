import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyLinkPlan, createLinkPlan } from '../link-local.mjs';

const temporary = [];
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-link-test-'));
  temporary.push(directory);
  const file = (name, content = '') => {
    const target = path.join(directory, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };
  return { directory, file, options: { log() {} } };
}
afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('local development links', () => {
  it('discovers top-level and cloud CLI packages without private non-CLI packages', () => {
    const { directory, file } = fixture();
    file('repo/packages/client/package.json', JSON.stringify({ name: '@mearl/client', bin: { mearl: './dist/bin.js' } }));
    file('repo/packages/cloud/server/package.json', JSON.stringify({ name: '@mearl/server', bin: { server: './dist/cli.js' } }));
    file('repo/packages/website/package.json', JSON.stringify({ name: '@mearl/website', private: true }));
    const links = createLinkPlan({ root: path.join(directory, 'repo'), prefix: path.join(directory, 'prefix') });
    expect(links.map(link => path.relative(directory, link.destination))).toEqual([
      'prefix/lib/node_modules/@mearl/client', 'prefix/bin/mearl',
      'prefix/lib/node_modules/@mearl/server', 'prefix/bin/server',
    ]);
    expect(links[1].source).toBe(path.join(directory, 'repo/packages/client/dist/bin.js'));
  });

  it('replaces installed directories and dangling bins without backups and is idempotent', () => {
    const { directory, file, options } = fixture();
    const source = path.dirname(file('repo/skill/SKILL.md', 'project'));
    const destination = path.dirname(file('installed/skill/SKILL.md', 'installed'));
    const bin = path.join(directory, 'installed/bin');
    fs.symlinkSync('/missing/old-bin', bin);
    const links = [{ source, destination }, { source: file('repo/bin'), destination: bin }];
    applyLinkPlan(links, options);
    expect(fs.realpathSync(destination)).toBe(fs.realpathSync(source));
    expect(fs.realpathSync(bin)).toBe(fs.realpathSync(links[1].source));
    expect(fs.readdirSync(path.join(directory, 'installed'))).toEqual(['bin', 'skill']);
    expect(fs.readdirSync(directory)).toEqual(['installed', 'repo']);
    const inode = fs.lstatSync(destination).ino;
    applyLinkPlan(links, options);
    expect(fs.lstatSync(destination).ino).toBe(inode);
  });

  it('validates all build outputs before replacing anything', () => {
    const { directory, file, options } = fixture();
    const destination = file('installed/bin', 'original');
    expect(() => applyLinkPlan([
      { source: file('repo/bin'), destination },
      { source: path.join(directory, 'missing'), destination: path.join(directory, 'next') },
    ], options)).toThrow('Missing build output');
    expect(fs.readFileSync(destination, 'utf8')).toBe('original');
  });

  it('preserves project sources when an ancestor of the destination is already linked', () => {
    const { directory, file, options } = fixture();
    const source = path.dirname(file('repo/skills/mearl/SKILL.md', 'project'));
    fs.symlinkSync(path.join(directory, 'repo/skills'), path.join(directory, 'installed'));
    applyLinkPlan([{ source, destination: path.join(directory, 'installed/mearl') }], options);
    expect(fs.lstatSync(source).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8')).toBe('project');
  });
});
