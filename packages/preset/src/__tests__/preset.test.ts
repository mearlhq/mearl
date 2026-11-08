import { describe, expect, it, vi } from 'vitest';
import { mergePresetDefaults, PresetError, resolvePreset, validatePreset } from '../index.js';

const baseUrl = 'https://presets.example.com/base/preset.json';
const teamUrl = 'https://presets.example.com/team/preset.json';
const manifest = (id = 'base', patch: Record<string, unknown> = {}) => ({
  schemaVersion: 1, id, version: '1.0.0', ...patch,
});

function resolve(documents: Record<string, unknown>, source = teamUrl, version = '1.0.0') {
  const load = vi.fn(async (url: string) => {
    if (!(url in documents)) throw new Error(`Missing fixture: ${url}`);
    return documents[url];
  });
  return { result: resolvePreset(source, { mearlApiVersion: version, load }), load };
}

describe('preset resolution', () => {
  it('preserves installer sources and Git refs while resolving explicit relative URLs', async () => {
    const documents = {
      [baseUrl]: manifest('base', {
        skills: {
          shorthand: { source: 'example/skills' },
          git: { source: 'https://github.com/example/skills.git#release/v3' },
          ssh: { source: 'git@code.example.test:team/skills.git#stable' },
          local: { source: '../skills/sample#v3' },
        },
        providers: { device: { source: 'npm:@example/device', version: '^3' } },
        packages: { runtime: { source: './bundle.json#ignored' } },
      }),
      [teamUrl]: manifest('team', { extends: { source: '../base/preset.json' }, skills: { shorthand: { version: '^3' } } }),
    };
    const preset = await resolve(documents).result;
    expect(preset.skills.shorthand).toMatchObject({ source: 'example/skills', version: '^3' });
    expect(preset.skills.git.source).toBe('https://github.com/example/skills.git#release/v3');
    expect(preset.skills.ssh.source).toBe('git@code.example.test:team/skills.git#stable');
    expect(preset.skills.local.source).toBe('https://presets.example.com/skills/sample#v3');
    expect(preset.providers.device.source).toBe('npm:@example/device');
    expect(preset.packages.runtime.source).toBe('https://presets.example.com/base/bundle.json');
    expect(documents[baseUrl].skills.git.source).toBe('https://github.com/example/skills.git#release/v3');
  });

  it('resolves and inherits Skill migration sources with explicit child replacement', async () => {
    const documents: Record<string, unknown> = {
      [baseUrl]: manifest('base', { skills: { sample: { source: 'example/skills#new', migrateFrom: ['./legacy', 'git@example.test:team/skills.git'] } } }),
      [teamUrl]: manifest('team', { extends: { source: baseUrl }, skills: { sample: { version: '^3' } } }),
    };
    expect((await resolve(documents).result).skills.sample.migrateFrom).toEqual(['https://presets.example.com/base/legacy', 'git@example.test:team/skills.git']);
    documents[teamUrl] = manifest('team', { extends: { source: baseUrl }, skills: { sample: { migrateFrom: [] } } });
    expect((await resolve(documents).result).skills.sample.migrateFrom).toEqual([]);
  });

  it.each([
    { packages: { sample: { source: './bundle.json', migrateFrom: [] } } },
    { providers: { sample: { source: 'npm:sample', migrateFrom: [] } } },
    { skills: { sample: { source: 'example/skills', migrateFrom: 'example/legacy' } } },
    { skills: { sample: { source: 'example/skills', migrateFrom: ['example/legacy', 'example/legacy'] } } },
    { skills: { sample: { source: 'example/skills', migrateFrom: Array.from({ length: 17 }, (_, i) => `example/legacy-${i}`) } } },
    { skills: { sample: { source: 'example/skills', migrateFrom: ['--global'] } } },
    { skills: { sample: { source: 'example/skills', migrateFrom: ['https://user:secret@example.test/skills'] } } },
  ])('rejects invalid or non-Skill migration declarations', async patch => {
    await expect(resolve({ [teamUrl]: manifest('team', patch) }).result).rejects.toMatchObject({ code: 'PRESET_INVALID' });
  });

  it.each(['--global', 'repo\n--yes', 'https://user:secret@example.test/repo', 'ssh://git:secret@example.test/repo', 'x'.repeat(8193)])('rejects invalid install sources before loading external components', async source => {
    const { result, load } = resolve({ [teamUrl]: manifest('team', { skills: { sample: { source } } }) });
    await expect(result).rejects.toMatchObject({ code: 'PRESET_INVALID' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('resolves sources relative to each declaring preset and retains exact parent-first versions', async () => {
    const documents = {
      [baseUrl]: manifest('base', {
        packages: { simulation: { source: './simulation/package.json', version: '^1', targets: ['browser'] } },
        skills: { convert: { source: '../skills/convert/SKILL.md' } },
        providers: { device: { source: '../providers/device/package.json', targets: ['node'] } },
        defaults: { simulation: { app: 'sample', version: '1' }, tools: ['convert', 'notes'] },
        permissions: { origins: ['https://*.example.com/*'] },
      }),
      [teamUrl]: manifest('team', {
        extends: { source: '../base/preset.json', version: '^1' },
        packages: { simulation: { version: '^2' }, logs: { source: './logs/package.json', dependsOn: ['simulation'] } },
        defaults: { simulation: { version: '2' }, tools: [] },
        permissions: { origins: ['https://*.example.com/*', 'https://api.example.net/*'] },
      }),
    };
    const { result, load } = resolve(documents);
    const preset = await result;
    expect(load.mock.calls.map(([url]) => url)).toEqual([teamUrl, baseUrl]);
    expect(preset.chain).toEqual([
      { source: baseUrl, id: 'base', version: '1.0.0' },
      { source: teamUrl, id: 'team', version: '1.0.0' },
    ]);
    expect(preset.packages.simulation).toEqual({
      source: 'https://presets.example.com/base/simulation/package.json',
      version: '^2', targets: ['browser'], declaredBy: teamUrl,
    });
    expect(preset.packages.logs.source).toBe('https://presets.example.com/team/logs/package.json');
    expect(preset.skills.convert.source).toBe('https://presets.example.com/skills/convert/SKILL.md');
    expect(preset.defaults).toEqual({ simulation: { app: 'sample', version: '2' }, tools: [] });
    expect(preset.permissions.origins).toEqual(['https://*.example.com/*', 'https://api.example.net/*']);
    expect(preset.permissions).not.toHaveProperty('granted');
    expect(documents[baseUrl].defaults).toEqual({ simulation: { app: 'sample', version: '1' }, tools: ['convert', 'notes'] });
  });

  it('allows child entries to disable inherited components and finish the final dependency graph', async () => {
    const { result } = resolve({
      [baseUrl]: manifest('base', { packages: { capture: { source: './capture.json', dependsOn: ['transport'] }, retired: { source: './retired.json' } } }),
      [teamUrl]: manifest('team', { extends: { source: '../base/preset.json' }, packages: { transport: { source: './transport.json' }, retired: { enabled: false } } }),
    });
    const preset = await result;
    expect(preset.packages.retired.enabled).toBe(false);
    expect(preset.packages.capture.dependsOn).toEqual(['transport']);
  });

  it('keeps user overrides separate from inherited defaults', () => {
    const base = { simulation: { version: '1', language: 'en' }, tools: ['convert'] };
    const user = { simulation: { language: 'zh' }, tools: [], optional: null };
    const applied = mergePresetDefaults(base, user);
    expect(applied).toEqual({ simulation: { version: '1', language: 'zh' }, tools: [], optional: null });
    expect(mergePresetDefaults({ simulation: { version: '2', language: 'en' } }, user))
      .toEqual({ simulation: { version: '2', language: 'zh' }, tools: [], optional: null });
    (applied.simulation as Record<string, unknown>).version = 'changed';
    expect(base.simulation.version).toBe('1');
    expect(user.simulation.language).toBe('zh');
  });

  it.each([
    { transport: { enabled: false }, capture: { source: './capture.json', dependsOn: ['transport'] } },
    { capture: { source: './capture.json', dependsOn: ['missing'] } },
    { one: { source: './one.json', dependsOn: ['two'] }, two: { source: './two.json', dependsOn: ['one'] } },
  ])('rejects broken final package dependencies', async packages => {
    await expect(resolve({ [teamUrl]: manifest('team', { packages }) }).result)
      .rejects.toMatchObject({ code: 'PRESET_DEPENDENCY' });
  });

  it('rejects an enabled component without an inherited or declared source', async () => {
    await expect(resolve({ [teamUrl]: manifest('team', { skills: { convert: { enabled: true } } }) }).result)
      .rejects.toMatchObject({ code: 'PRESET_INVALID' });
  });

  it('detects inheritance cycles even when URLs have fragments', async () => {
    const { result, load } = resolve({
      [baseUrl]: manifest('base', { extends: { source: '../team/preset.json#again' } }),
      [teamUrl]: manifest('team', { extends: { source: '../base/preset.json' } }),
    });
    await expect(result).rejects.toMatchObject({ code: 'PRESET_CYCLE' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('bounds a chain of distinct sources', async () => {
    const load = vi.fn(async (url: string) => {
      const current = Number(new URL(url).pathname.slice(1));
      return manifest(`preset-${current}`, { extends: { source: `/${current + 1}` } });
    });
    await expect(resolvePreset('https://presets.example.com/0', { mearlApiVersion: '1.0.0', load }))
      .rejects.toThrow('32 presets');
    expect(load).toHaveBeenCalledTimes(32);
  });

  it('checks both inherited API requirements and the requested parent version', async () => {
    const child = manifest('team', { extends: { source: '../base/preset.json', version: '^2' } });
    await expect(resolve({ [baseUrl]: manifest(), [teamUrl]: child }).result)
      .rejects.toMatchObject({ code: 'PRESET_INCOMPATIBLE' });
    await expect(resolve({
      [baseUrl]: manifest('base', { requires: { mearlApi: '^2' } }),
      [teamUrl]: manifest('team', { extends: { source: '../base/preset.json' } }),
    }).result).rejects.toMatchObject({ code: 'PRESET_INCOMPATIBLE' });
  });

  it('does not silently include an API prerelease in a stable requirement', async () => {
    await expect(resolve({ [teamUrl]: manifest('team', { requires: { mearlApi: '^1' } }) }, teamUrl, '1.1.0-beta.1').result)
      .rejects.toMatchObject({ code: 'PRESET_INCOMPATIBLE' });
  });

  it('supports file URL sources without importing Node filesystem APIs', async () => {
    const { result } = resolve({
      'file:///workspace/presets/base.json': manifest('local', { skills: { convert: { source: '../skills/convert/SKILL.md' } } }),
    }, 'file:///workspace/presets/base.json');
    expect((await result).skills.convert.source).toBe('file:///workspace/skills/convert/SKILL.md');
  });

  it('propagates cancellation and transport failures without loading further parents', async () => {
    const controller = new AbortController();
    const load = vi.fn(async () => {
      controller.abort();
      return manifest('team', { extends: { source: '../base/preset.json' } });
    });
    await expect(resolvePreset(teamUrl, { mearlApiVersion: '1.0.0', load, signal: controller.signal }))
      .rejects.toThrow();
    expect(load).toHaveBeenCalledTimes(1);
    const error = new Error('Transport unavailable');
    await expect(resolvePreset(teamUrl, { mearlApiVersion: '1.0.0', load: async () => { throw error; } }))
      .rejects.toBe(error);
  });

  it('does not fetch for an invalid source or API version', async () => {
    const load = vi.fn();
    await expect(resolvePreset('javascript:alert(1)', { mearlApiVersion: '1.0.0', load })).rejects.toBeInstanceOf(PresetError);
    await expect(resolvePreset(teamUrl, { mearlApiVersion: 'latest', load })).rejects.toBeInstanceOf(PresetError);
    expect(load).not.toHaveBeenCalled();
  });
});

describe('manifest validation', () => {
  it.each([
    manifest('base', { schemaVersion: 2 }),
    manifest('base', { version: 'latest' }),
    manifest('base', { unexpected: true }),
    manifest('base', { extends: { source: '../base.json', version: 'not-a-version' } }),
    manifest('base', { packages: { transport: { enabled: 'false' } } }),
    manifest('base', { packages: { transport: { targets: ['unknown'] } } }),
    manifest('base', { packages: { transport: { dependsOn: ['one', 'one'] } } }),
    manifest('base', { defaults: { value: Infinity } }),
    manifest('base', { defaults: { value: undefined } }),
    manifest('base', { defaults: { value: new Date() } }),
    manifest('base', { permissions: { origins: ['https://example.com/*', 'https://example.com/*'] } }),
    manifest('base', { defaults: { oversized: 'x'.repeat(262_144) } }),
  ])('rejects malformed manifests', value => {
    expect(() => validatePreset(value)).toThrow(PresetError);
  });

  it('rejects prototype pollution keys at any nesting depth', () => {
    for (const defaults of [
      JSON.parse('{"__proto__":{"polluted":true}}'),
      JSON.parse('{"tools":{"constructor":{"prototype":{"polluted":true}}}}'),
    ]) {
      expect(() => validatePreset(manifest('base', { defaults }))).toThrow(PresetError);
      expect(() => mergePresetDefaults({}, defaults)).toThrow(PresetError);
    }
    expect({}).not.toHaveProperty('polluted');
  });

  it('clones validated content so caller mutations cannot modify the installed definition', () => {
    const original = manifest('base', { packages: { tool: { source: './tool.json', targets: ['browser'] } }, defaults: { language: 'en' } });
    const cloned = validatePreset(original);
    original.defaults.language = 'zh';
    original.packages.tool.targets.push('node');
    expect(cloned.defaults).toEqual({ language: 'en' });
    expect(cloned.packages?.tool.targets).toEqual(['browser']);
  });
});
