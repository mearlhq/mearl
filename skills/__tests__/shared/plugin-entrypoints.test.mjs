import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { loadPlugin } from '@mearl/client/plugin';

const version = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;

it.each([
  ['bbrowser', 'mearl-bbrowser', ['site'], [], []],
  ['translate', 'immersive-translate', [], ['preferences', 'settings', 'start', 'state', 'stop', 'display', 'retry'], []],
  ['overlay', 'design-overlay', ['tabs', 'state', 'update', 'apply', 'clear', 'compare', 'import'], ['pick', 'cancel-pick', 'capture', 'begin-import', 'import-chunk', 'resource-chunk'], ['initialize', 'sync']],
])('registers %s without browser activity and preserves command access', async (name, skill, publicCommands, pageCommands, runtimeCommands) => {
  const invoke = vi.fn();
  const entry = fileURLToPath(new URL(`../../${skill}/scripts/main.mjs`, import.meta.url));
  const runtime = await loadPlugin(entry, { options: {}, invoke, progress: () => {} });
  expect(runtime.name).toBe(name);
  expect(runtime.version).toBe(version);
  const help = runtime.commandHelp(`mearl ${name}`);
  expect(help.split('\n').filter(Boolean).map(line => line.trim().split(/\s+/)[2])).toEqual(publicCommands);
  for (const command of pageCommands) {
    await expect(runtime.run([], { command, input: {} })).rejects.toThrow('PLUGIN_COMMAND_TOOLBOX_ONLY');
  }
  for (const command of runtimeCommands) {
    await expect(runtime.run([], { command, input: {} })).rejects.toThrow('PLUGIN_COMMAND_RUNTIME_ONLY');
    await expect(runtime.runToolbox({ command, input: {} })).rejects.toThrow('PLUGIN_COMMAND_RUNTIME_ONLY');
  }
  expect(invoke).not.toHaveBeenCalled();
});
