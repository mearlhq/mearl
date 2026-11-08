import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSkillManager, type AgentSkillBackend } from '../skill-manager.js';
import {
  findPluginRegistration,
  getSkillEnabled,
  OFFICIAL_PLUGIN_MANAGER,
  registerPlugin,
  setSkillEnabled,
} from '@mearl/client/plugin';

let workspace: string;
let directory: string;
let backend: AgentSkillBackend;
let run: ReturnType<typeof vi.fn>;
beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'mearl-skill-backend-')));
  directory = join(workspace, '.agents', 'skills', 'sample');
  vi.stubEnv('MEARL_PLUGIN_DIR', join(workspace, 'plugins'));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), '---\nname: sample\n---\n');
  const output = { stdout: 'success', stderr: '' };
  backend = {
    id: 'custom-manager',
    install: vi.fn(async () => output),
    update: vi.fn(async () => output),
    uninstall: vi.fn(async () => output),
    checkUpdates: vi.fn(async () => ({ updates: [{ name: 'sample', scope: 'project' }] })),
  };
  run = vi.fn(async () => output);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(workspace, { recursive: true, force: true });
});
const data = () => ({
  providerId: 'codex' as const,
  scope: 'project' as const,
  name: 'sample',
  cwd: workspace,
});

describe('preset-selected Skill manager', () => {
  it('keeps preset ownership during Agent refreshes and plugin renames', async () => {
    mkdirSync(join(directory, 'scripts'));
    const entry = join(directory, 'scripts', 'main.mjs');
    writeFileSync(
      entry,
      "export const name='tool'; export default app=>app.command('read',()=>[]);",
    );
    registerPlugin('tool', entry, undefined, { managedBy: OFFICIAL_PLUGIN_MANAGER });
    registerPlugin('my-tool', entry);
    const manager = new AgentSkillManager({ backend: () => backend, run });
    await manager.install({ ...data(), source: 'example/skills' });
    expect(findPluginRegistration('tool')?.managedBy).toBe(OFFICIAL_PLUGIN_MANAGER);
    expect(findPluginRegistration('my-tool')?.managedBy).toBeUndefined();
    expect(findPluginRegistration('my-tool')?.entry).toBe(entry);
    backend.update = vi.fn(async () => {
      writeFileSync(
        entry,
        "export const name='renamed-tool'; export default app=>app.command('read',()=>['updated']);",
      );
      return { stdout: 'updated', stderr: '' };
    });
    await manager.update(data());
    expect(findPluginRegistration('tool')).toBeUndefined();
    expect(findPluginRegistration('renamed-tool')?.managedBy).toBe(OFFICIAL_PLUGIN_MANAGER);
    expect(findPluginRegistration('my-tool')?.entry).toBe(entry);
  });

  it('removes old aliases when a global batch updates a plugin name', async () => {
    vi.stubEnv('HOME', workspace);
    vi.stubEnv('USERPROFILE', workspace);
    mkdirSync(join(directory, 'scripts'));
    const entry = join(directory, 'scripts', 'main.mjs');
    writeFileSync(
      entry,
      "export const name = 'old-tool'; export default app => app.command('list', () => []);",
    );
    const manager = new AgentSkillManager({ backend: () => undefined, run });
    await manager.installGlobal('example/skills', 'sample');
    expect(findPluginRegistration('old-tool')).toBeDefined();
    run.mockImplementation(async () => {
      writeFileSync(
        entry,
        "export const name = 'new-tool'; export default app => app.command('list', () => ['updated']);",
      );
      return { stdout: 'updated', stderr: '' };
    });
    await manager.installGlobal('example/skills', 'sample');
    expect(findPluginRegistration('old-tool')).toBeUndefined();
    expect(findPluginRegistration('new-tool')).toBeDefined();
  });

  it('reads actual source, manifest version and plugin registration without invoking the installer', async () => {
    vi.stubEnv('HOME', workspace);
    vi.stubEnv('USERPROFILE', workspace);
    const manager = new AgentSkillManager({
      backend: () => undefined,
      run,
      readSources: () => [
        { name: 'sample', source: 'example/skills', scope: 'global', hashKind: 'folder' },
      ],
    });
    writeFileSync(join(directory, 'SKILL.md'), '---\nname: sample\nversion: "3.1.0"\n---\n');
    expect(manager.inspectGlobal('https://github.com/example/skills.git', 'sample', '^3')).toEqual({
      state: 'ready',
    });
    expect(manager.inspectGlobal('example/skills', 'sample', '^4').state).toBe('version');
    expect(manager.inspectGlobal('example/other', 'sample').state).toBe('conflict');
    mkdirSync(join(directory, 'scripts'));
    writeFileSync(
      join(directory, 'scripts', 'main.mjs'),
      "export const name = 'sample-tool'; export default app => app.command('list', () => []);",
    );
    expect(manager.inspectGlobal('example/skills', 'sample').state).toBe('registration');
    setSkillEnabled(directory, false);
    await manager.repairGlobalRegistration('sample');
    expect(manager.inspectGlobal('example/skills', 'sample', '^3')).toEqual({ state: 'ready' });
    expect(findPluginRegistration('sample-tool')).toBeDefined();
    expect(getSkillEnabled(directory)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('uses the selected manager source reader without falling back to a conflicting standard receipt', () => {
    vi.stubEnv('HOME', workspace);
    vi.stubEnv('USERPROFILE', workspace);
    backend.readSources = vi.fn(() => [
      {
        name: 'sample',
        source: 'example/skills',
        ref: 'release',
        scope: 'global',
        hashKind: 'folder',
      },
    ]);
    const readSources = vi.fn(() => [
      {
        name: 'sample',
        source: 'example/other',
        scope: 'global' as const,
        hashKind: 'folder' as const,
      },
    ]);
    const manager = new AgentSkillManager({ backend: () => backend, readSources, run }).capture();
    expect(manager.inspectGlobal('example/skills#release', 'sample')).toEqual({ state: 'ready' });
    expect(manager.inspectGlobal('example/skills#other', 'sample').state).toBe('conflict');
    expect(backend.readSources).toHaveBeenCalled();
    expect(readSources).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('treats unknown or mismatching installed identities as conflicts', () => {
    vi.stubEnv('HOME', workspace);
    vi.stubEnv('USERPROFILE', workspace);
    const manager = new AgentSkillManager({ backend: () => undefined, run, readSources: () => [] });
    expect(manager.inspectGlobal('example/skills', 'sample')).toEqual({
      state: 'conflict',
      reason: 'SKILL_SOURCE_UNKNOWN',
    });
    const tracked = new AgentSkillManager({
      backend: () => undefined,
      run,
      readSources: () => [
        { name: 'sample', source: 'example/skills', scope: 'global', hashKind: 'folder' },
      ],
    });
    writeFileSync(join(directory, 'SKILL.md'), '---\nname: another\n---\n');
    expect(tracked.inspectGlobal('example/skills', 'sample')).toEqual({
      state: 'conflict',
      reason: 'SKILL_MANIFEST_IDENTITY',
    });
    writeFileSync(join(directory, 'SKILL.md.mearl-disabled'), '---\nname: sample\n---\n');
    expect(tracked.inspectGlobal('example/skills', 'sample')).toEqual({
      state: 'conflict',
      reason: 'SKILL_MANIFEST_CONFLICT',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('installs a global source batch once with automatic agent detection and preserves disabled skills', async () => {
    vi.stubEnv('HOME', workspace);
    vi.stubEnv('USERPROFILE', workspace);
    setSkillEnabled(directory, false);
    run.mockImplementation(async () => {
      for (const name of ['sample', 'other']) {
        const target = join(workspace, '.agents', 'skills', name);
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'SKILL.md'), `---\nname: ${name}\n---\n`);
      }
      return { stdout: 'installed', stderr: '' };
    });
    const manager = new AgentSkillManager({ backend: () => undefined, run }).capture();
    await expect(
      manager.installGlobals('https://github.com/example/skills', ['sample', 'other']),
    ).resolves.toEqual({ ok: true, output: 'installed' });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        'add',
        'https://github.com/example/skills',
        '--skill',
        'sample',
        'other',
        '--global',
        '--yes',
      ]),
    );
    expect(run.mock.calls[0][1]).not.toContain('--agent');
    expect(getSkillEnabled(directory)).toBe(false);
    expect(getSkillEnabled(join(workspace, '.agents', 'skills', 'other'))).toBe(true);
  });

  it('captures one batch-capable backend instead of following a later selection', async () => {
    vi.stubEnv('HOME', workspace);
    vi.stubEnv('USERPROFILE', workspace);
    let selected: AgentSkillBackend | undefined = backend;
    backend.installBatch = vi.fn(async () => ({ stdout: 'batch', stderr: '' }));
    const manager = new AgentSkillManager({ backend: () => selected, run }).capture();
    selected = undefined;
    await manager.installGlobal('example/private', 'sample');
    expect(backend.installBatch).toHaveBeenCalledWith({
      source: 'example/private',
      names: ['sample'],
      scope: 'global',
    });
    expect(backend.install).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps a legacy adapter on its required-agent contract instead of sending an undefined agent', async () => {
    backend.install = vi.fn(async options => {
      if (!options.providerId) throw new Error('Legacy --agent requires a provider');
      return { stdout: 'installed', stderr: '' };
    });
    const manager = new AgentSkillManager({ backend: () => backend, run });
    await expect(manager.installGlobals('example/private', ['sample'])).rejects.toThrow(
      'preset update',
    );
    expect(backend.install).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    await expect(manager.install({ ...data(), source: 'example/private' })).resolves.toMatchObject({
      ok: true,
    });
    expect(backend.install).toHaveBeenCalledWith({ ...data(), source: 'example/private' });
  });

  it('uses one backend for every source and operation with unchanged request data', async () => {
    const readSources = vi.fn(() => {
      throw new Error('Public lock must not be inspected');
    });
    const checkUpdates = vi.fn(async () => []);
    const manager = new AgentSkillManager({
      backend: () => backend,
      run,
      readSources,
      checkUpdates,
    });
    for (const source of ['example/private', 'https://github.com/example/public']) {
      await expect(manager.install({ ...data(), source })).resolves.toEqual({
        ok: true,
        output: 'success',
      });
      expect(backend.install).toHaveBeenLastCalledWith({ ...data(), source });
    }
    await manager.update(data());
    await manager.uninstall(data());
    expect(backend.update).toHaveBeenCalledWith(data());
    expect(backend.uninstall).toHaveBeenCalledWith(data());
    await expect(manager.checkUpdates({ providerId: 'codex', cwd: workspace })).resolves.toEqual({
      updates: [{ name: 'sample', scope: 'project' }],
    });
    expect(run).not.toHaveBeenCalled();
    expect(readSources).not.toHaveBeenCalled();
    expect(checkUpdates).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'preserves disabled state when the selected updater recreates its manifest; failure=%s',
    async fail => {
      setSkillEnabled(directory, false);
      backend.update = vi.fn(async () => {
        writeFileSync(join(directory, 'SKILL.md'), '# Updated');
        if (fail) throw new Error('update failed');
        return { stdout: 'updated', stderr: '' };
      });
      const manager = new AgentSkillManager({ backend: () => backend, run });
      const operation = manager.update(data());
      if (fail) await expect(operation).rejects.toThrow('update failed');
      else await expect(operation).resolves.toEqual({ ok: true, output: 'updated' });
      expect(getSkillEnabled(directory)).toBe(false);
      expect(existsSync(join(directory, 'SKILL.md'))).toBe(false);
    },
  );

  it('keeps an accepted operation on its backend and uses the new selection for the next action', async () => {
    let finish!: () => void;
    backend.install = vi.fn(
      () =>
        new Promise(resolve => {
          finish = () => resolve({ stdout: 'accepted', stderr: '' });
        }),
    );
    let selected: AgentSkillBackend | undefined = backend;
    const manager = new AgentSkillManager({ backend: () => selected, run });
    const accepted = manager.install({
      ...data(),
      source: 'example/private',
      expectedManagerId: backend.id,
    });
    selected = undefined;
    finish();
    await expect(accepted).resolves.toEqual({ ok: true, output: 'accepted' });
    await manager.install({ ...data(), source: 'example/public' });
    expect(backend.install).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });

  it.each(['install', 'update', 'uninstall'] as const)(
    'rejects stale %s manager expectations in both directions before touching state',
    async operation => {
      for (const selected of [undefined, backend]) {
        const readSources = vi.fn(() => []);
        const manager = new AgentSkillManager({ backend: () => selected, run, readSources });
        const before = readFileSync(join(directory, 'SKILL.md'), 'utf8');
        await expect(
          manager[operation]({
            ...data(),
            source: 'example/private',
            expectedManagerId: selected ? 'skills' : backend.id,
          }),
        ).rejects.toThrow('SKILL_MANAGER_CHANGED');
        expect(readFileSync(join(directory, 'SKILL.md'), 'utf8')).toBe(before);
        expect(readSources).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        expect(backend[operation]).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['update', 'uninstall'] as const)(
    'refuses %s of a custom lock source with the public fallback',
    async operation => {
      const manager = new AgentSkillManager({
        backend: () => undefined,
        run,
        readSources: scope => [
          {
            name: 'sample',
            source: 'example/private',
            sourceType: 'custom-catalog',
            scope,
            hashKind: 'folder',
          },
        ],
      });
      await expect(manager[operation](data())).rejects.toThrow('external manager');
      expect(run).not.toHaveBeenCalled();
    },
  );

  it('validates the request before invoking a selected backend', async () => {
    const manager = new AgentSkillManager({ backend: () => backend, run });
    await expect(
      manager.install({ ...data(), name: '../escape', source: 'example/private' }),
    ).rejects.toThrow('Skill name');
    expect(backend.install).not.toHaveBeenCalled();
  });

  it('cleans the old plugin alias by Skill directory ownership after changing managers', async () => {
    mkdirSync(join(directory, 'scripts'));
    const entry = join(directory, 'scripts', 'main.mjs');
    writeFileSync(
      entry,
      "export const name = 'before'; export default app => app.command('list', () => []);",
    );
    let selected: AgentSkillBackend | undefined = undefined;
    const manager = new AgentSkillManager({ backend: () => selected, run });
    await manager.install({ ...data(), source: 'example/public' });
    expect(findPluginRegistration('before')?.managedBy).toBe('skills');
    backend.update = vi.fn(async () => {
      writeFileSync(
        entry,
        "export const name = 'after'; export default app => app.command('list', () => ['changed']);",
      );
      return { stdout: 'updated', stderr: '' };
    });
    selected = backend;
    await manager.update(data());
    expect(findPluginRegistration('before')).toBeUndefined();
    expect(findPluginRegistration('after')?.managedBy).toBe('custom-manager');
  });
});
