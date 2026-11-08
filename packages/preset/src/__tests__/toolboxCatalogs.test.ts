import { expect, it } from 'vitest';
import { parseToolboxCatalogs, resolvePreset } from '../index.js';
it('inherits, overrides and disables directories by stable key', async () => {
  const documents = {
    'https://example.com/base.json': { schemaVersion: 1, id: 'base', version: '1.0.0', defaults: { extension: { toolCatalogs: { team: { url: 'https://example.com/team.json', label: 'Team' }, obsolete: { url: 'https://example.com/old.json' } } } } },
    'https://example.com/child.json': { schemaVersion: 1, id: 'child', version: '1.0.0', extends: { source: './base.json' }, defaults: { extension: { toolCatalogs: { team: { label: 'Child team' }, obsolete: { enabled: false }, extra: { url: 'https://example.com/extra.json' } } } } },
  };
  const result = await resolvePreset('https://example.com/child.json', { mearlApiVersion: '1.0.0', load: async url => documents[url as keyof typeof documents] });
  expect(parseToolboxCatalogs((result.defaults.extension as any).toolCatalogs)).toEqual({ team: { url: 'https://example.com/team.json', label: 'Child team' }, obsolete: { url: 'https://example.com/old.json', enabled: false }, extra: { url: 'https://example.com/extra.json' } });
});
it.each([{ official: { url: 'https://evil.example' } }, { team: { url: 'javascript:alert(1)' } }, { team: { url: 'https://user:secret@example.com/' } }, { team: { url: 'http://example.com/' } }, { team: { url: 'https://example.com/#x' } }, { team: { url: '../relative.json' } }, { team: { label: 'Missing URL' } }, { team: { url: 'https://example.com/', args: ['evil'] } }, { team: { url: 'https://example.com/', enabled: 'yes' } }])('rejects unsafe or ambiguous catalog configuration %j', value => {
  expect(() => parseToolboxCatalogs(value)).toThrow('toolCatalogs');
});
it('permits disabling a missing parent entry and development loopback URLs', () => {
  expect(parseToolboxCatalogs({ off: { enabled: false }, local: { url: 'http://127.0.0.1:1234/tools.json' } })).toEqual({ off: { enabled: false }, local: { url: 'http://127.0.0.1:1234/tools.json' } });
});
it('validates catalog configuration during Node and browser preset resolution', async () => {
  await expect(resolvePreset('https://example.com/preset.json', { mearlApiVersion: '1.0.0', load: async () => ({ schemaVersion: 1, id: 'team', version: '1.0.0', defaults: { extension: { toolCatalogs: { team: { url: 'file:///tmp/tools.json' } } } } }) })).rejects.toThrow('toolCatalogs');
});
