import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findPluginRegistration,
  loadPlugin,
  readPluginPageBundleChunk,
  refreshRegisteredPlugin,
  registerPlugin,
} from '../sdk/plugin.js';

let directory: string;
let entry: string;
let registry: string;
const context = { options: {}, invoke: vi.fn(), progress: vi.fn() };
const toolbox = {
  version: 1 as const,
  title: 'Sample',
  page: { type: 'sandbox' as const, entry: 'assets/index.html', commands: ['echo'] },
};

function writeEntry(title = 'Sample', hasToolbox = true): void {
  writeFileSync(
    entry,
    `export const description = '${title} summary';
    ${hasToolbox ? `export const toolbox = ${JSON.stringify({ ...toolbox, title })};` : ''}
    export default async app => {
      globalThis.mearlRefreshLoads = (globalThis.mearlRefreshLoads || 0) + 1;
      await Promise.resolve();
      app.command('echo', input => input);
    };`,
  );
}

async function register(): Promise<void> {
  const loaded = await loadPlugin(entry, context);
  registerPlugin('sample', entry, loaded.description, {
    toolbox: loaded.toolbox,
    managedBy: 'workspace-skills',
  });
}

function pageContent(): string {
  const hash = findPluginRegistration('sample')!.pageBundle!.hash;
  return Buffer.from(readPluginPageBundleChunk('sample', hash, 0).data, 'base64').toString('utf8');
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mearl-refresh-'));
  registry = join(directory, 'registry', 'sample.json');
  vi.stubEnv('MEARL_PLUGIN_DIR', join(directory, 'registry'));
  entry = join(directory, 'scripts', 'main.mjs');
  mkdirSync(join(directory, 'scripts'));
  mkdirSync(join(directory, 'assets'));
  writeFileSync(
    join(directory, 'assets', 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><script src="app.js"></script></body></html>',
  );
  writeFileSync(join(directory, 'assets', 'style.css'), 'body { background: url("icon.svg"); }');
  writeFileSync(join(directory, 'assets', 'icon.svg'), '<svg></svg>');
  writeFileSync(join(directory, 'assets', 'app.js'), 'window.value = 1;');
  (globalThis as any).mearlRefreshLoads = 0;
  writeEntry();
});

afterEach(() => {
  delete (globalThis as any).mearlRefreshLoads;
  delete (globalThis as any).mearlRefreshGate;
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('on-demand plugin registration refresh', () => {
  it.each([undefined, '0'.repeat(64)])(
    'rebuilds a snapshot with an outdated host bridge (%s)',
    async pageRuntime => {
      await register();
      const record = JSON.parse(readFileSync(registry, 'utf8'));
      record.source.pageRuntime = pageRuntime;
      writeFileSync(registry, JSON.stringify(record));
      await refreshRegisteredPlugin('sample', true);
      expect(findPluginRegistration('sample')!.source!.pageRuntime).toMatch(/^[a-f0-9]{64}$/);
      expect(findPluginRegistration('sample')!.source!.pageRuntime).not.toBe(pageRuntime);
      expect(pageContent()).toContain('const subscribe =');
      expect((globalThis as any).mearlRefreshLoads).toBe(1);
    },
  );
  it('does not reload or rewrite unchanged plugins, including unrelated Skill edits', async () => {
    await register();
    const timestamp = statSync(registry).mtimeMs;
    writeFileSync(join(directory, 'SKILL.md'), 'updated documentation');
    await refreshRegisteredPlugin('sample');
    await refreshRegisteredPlugin('sample', true);
    expect((globalThis as any).mearlRefreshLoads).toBe(1);
    expect(statSync(registry).mtimeMs).toBe(timestamp);
    expect(Object.keys(findPluginRegistration('sample')!.source!.page!)).toContain(
      realpathSync(join(directory, 'assets', 'icon.svg')),
    );
  });

  it('checks page assets only on open and rebuilds without executing the entry', async () => {
    await register();
    const previousHash = findPluginRegistration('sample')!.pageBundle!.hash;
    writeFileSync(join(directory, 'assets', 'app.js'), 'window.value = 2;');
    await refreshRegisteredPlugin('sample');
    expect(findPluginRegistration('sample')!.pageBundle!.hash).toBe(previousHash);
    await refreshRegisteredPlugin('sample', true);
    expect(pageContent()).toContain('window.value = 2;');
    expect(findPluginRegistration('sample')!.pageBundle!.hash).not.toBe(previousHash);
    expect((globalThis as any).mearlRefreshLoads).toBe(1);
  });

  it('tracks CSS resources and newly referenced assets after a rebuild', async () => {
    await register();
    writeFileSync(join(directory, 'assets', 'extra.js'), 'window.extra = true;');
    writeFileSync(
      join(directory, 'assets', 'index.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><script src="extra.js"></script></body></html>',
    );
    await refreshRegisteredPlugin('sample', true);
    expect(pageContent()).toContain('window.extra = true;');
    writeFileSync(join(directory, 'assets', 'icon.svg'), '<svg><path /></svg>');
    const hash = findPluginRegistration('sample')!.pageBundle!.hash;
    await refreshRegisteredPlugin('sample', true);
    expect(findPluginRegistration('sample')!.pageBundle!.hash).not.toBe(hash);
  });

  it('reloads changed metadata once for concurrent opens and preserves ownership', async () => {
    await register();
    writeEntry('Updated');
    const results = await Promise.all([
      refreshRegisteredPlugin('sample'),
      refreshRegisteredPlugin('sample', true),
      refreshRegisteredPlugin('sample', true),
    ]);
    expect(results.every(result => result?.toolbox?.title === 'Updated')).toBe(true);
    expect(findPluginRegistration('sample')).toMatchObject({
      managedBy: 'workspace-skills',
      description: 'Updated summary',
    });
    expect((globalThis as any).mearlRefreshLoads).toBe(2);
  });

  it('discovers added toolbox contributions and removes withdrawn ones', async () => {
    writeEntry('Ordinary', false);
    await register();
    writeEntry();
    expect((await refreshRegisteredPlugin('sample'))?.toolbox?.title).toBe('Sample');
    writeEntry('Ordinary', false);
    expect(await refreshRegisteredPlugin('sample')).not.toHaveProperty('toolbox');
  });

  it('migrates legacy registrations once on first use', async () => {
    await register();
    const record = JSON.parse(readFileSync(registry, 'utf8'));
    delete record.source;
    writeFileSync(registry, JSON.stringify(record));
    expect((await refreshRegisteredPlugin('sample'))?.source).toBeDefined();
    await refreshRegisteredPlugin('sample', true);
    expect((globalThis as any).mearlRefreshLoads).toBe(2);
  });

  it('does not cache stale metadata when the entry changes during loading', async () => {
    await register();
    const previous = readFileSync(registry, 'utf8');
    let release: () => void = () => {};
    (globalThis as any).mearlRefreshGate = new Promise<void>(resolve => {
      release = resolve;
    });
    writeEntry('Intermediate');
    writeFileSync(
      entry,
      readFileSync(entry, 'utf8').replace(
        'await Promise.resolve();',
        'await globalThis.mearlRefreshGate;',
      ),
    );
    const refreshing = refreshRegisteredPlugin('sample');
    await vi.waitFor(() => expect((globalThis as any).mearlRefreshLoads).toBe(2));
    writeEntry('Final');
    release();
    await expect(refreshing).rejects.toThrow('PLUGIN_SOURCE_CHANGED');
    expect(readFileSync(registry, 'utf8')).toBe(previous);
    expect((await refreshRegisteredPlugin('sample'))?.toolbox?.title).toBe('Final');
  });

  it('preserves the valid snapshot when a new page fails validation and retries after repair', async () => {
    await register();
    const previous = readFileSync(registry, 'utf8');
    writeFileSync(
      join(directory, 'assets', 'index.html'),
      '<!doctype html><html><body><script src="https://example.com/app.js"></script></body></html>',
    );
    await expect(refreshRegisteredPlugin('sample', true)).rejects.toThrow(
      'PLUGIN_INVALID_TOOLBOX_PAGE',
    );
    expect(readFileSync(registry, 'utf8')).toBe(previous);
    expect(pageContent()).toContain('window.value = 1;');
    writeFileSync(
      join(directory, 'assets', 'index.html'),
      '<!doctype html><html><body>Repaired</body></html>',
    );
    await refreshRegisteredPlugin('sample', true);
    expect(pageContent()).toContain('Repaired');
  });

  it('detects retargeted local asset symlinks', async () => {
    rmSync(join(directory, 'assets', 'app.js'));
    writeFileSync(join(directory, 'assets', 'first.js'), 'window.first = true;');
    writeFileSync(join(directory, 'assets', 'second.js'), 'window.second = true;');
    symlinkSync('first.js', join(directory, 'assets', 'app.js'));
    await register();
    rmSync(join(directory, 'assets', 'app.js'));
    symlinkSync('second.js', join(directory, 'assets', 'app.js'));
    await refreshRegisteredPlugin('sample', true);
    expect(pageContent()).toContain('window.second = true;');
  });
});
