import { expect, it } from 'vitest';
import { parseSetupManagement, setupManagementCommand, setupRuntimeCompatible } from '../management.js';
import { resolvePreset } from '../resolve.js';

const setup = { package: '@team/setup', version: 'beta', registry: 'https://registry.example.test/', runtime: '>=3.0.0-beta.8 <4' };
it('inherits a validated management declaration and renders bounded package arguments', async () => {
  const root = 'https://example.test/root.json';
  const preset = await resolvePreset('https://example.test/child.json', { mearlApiVersion: '1.0.0', load: async source => ({ schemaVersion: 1, id: source === root ? 'root' : 'child', version: '1.0.0', ...(source === root ? { defaults: { management: { setup } } } : { extends: { source: root } }) }) });
  const selected = parseSetupManagement(preset.defaults.management)!;
  expect(selected).toEqual(setup);
  expect(setupManagementCommand(selected)).toBe('npx --registry=https://registry.example.test/ @team/setup@beta');
  expect(setupRuntimeCompatible(selected, '3.0.0-beta.9')).toBe(true);
  expect(setupRuntimeCompatible(selected, '3.0.0-beta.7')).toBe(false);
  expect(setupRuntimeCompatible(selected, '4.0.0')).toBe(false);
  expect(setupRuntimeCompatible(selected, '3.0.0-beta.9', '2.22.x')).toBe(false);
  expect(setupRuntimeCompatible({ ...selected, runtime: '>=3.0.0 <3.0.10' }, '3.0.1', '3.0.x')).toBe(false);
});
it.each([
  { package: '--evil' }, { package: 'team/setup' }, { version: 'beta;echo x' },
  { registry: 'https://user:secret@example.test/' }, { registry: 'https://example.test/?token=x' },
  { registry: 'http://example.test/' }, { runtime: 'unknown' }, { command: 'echo x' },
])('rejects executable or invalid management values: %j', patch => {
  expect(() => parseSetupManagement({ setup: { ...setup, ...patch } })).toThrow();
});
