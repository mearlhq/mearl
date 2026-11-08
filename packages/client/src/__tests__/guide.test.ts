import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { readInstallationManagement } from '@mearl/daemon-core/installation';
import { GUIDE_TOPICS, readGuide, renderGuideLinks, runGuideCli } from '../guide.js';

vi.mock('node:fs', async original => { const actual = await original<typeof import('node:fs')>(); return { ...actual, readFileSync: vi.fn(actual.readFileSync) }; });
vi.mock('@mearl/daemon-core/installation', async original => ({ ...await original<typeof import('@mearl/daemon-core/installation')>(), readInstallationManagement: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

it('turns packaged reference links into topic commands and retains section hints and external URLs', () => {
  expect(renderGuideLinks('Read [controls](./api-page-automation.md#page_wait), [site](https://example.com/docs) and [here](#section).'))
    .toBe('Read controls（`mearl guide automation`，小节 `page_wait`）, [site](https://example.com/docs) and [here](#section).');
  expect(() => renderGuideLinks('[missing](../private.md)')).toThrow('未打包');
});

it('lists bounded topics without loading bodies or a browser', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runGuideCli(['--list'], 'fixture', '9.1.0')).toBe(0);
  const text = String(log.mock.calls[0]?.[0]);
  expect(text).toContain('fixture guide — CLI 9.1.0');
  for (const topic of GUIDE_TOPICS) expect(text).toContain(topic.id);
  expect(text).not.toContain('# Mearl 核心工作流');
  expect(readInstallationManagement).not.toHaveBeenCalled();
});

it('renders one local management entry across lifecycle and plugin instructions', async () => {
  vi.mocked(readFileSync).mockReturnValueOnce('{{setup}} update\n{{setup}} uninstall --yes');
  vi.mocked(readInstallationManagement).mockResolvedValue({ setup: { package: '@team/setup', version: 'beta' }, source: 'https://example.test/preset.json', revision: 'a'.repeat(64) });
  const text = await readGuide('troubleshooting');
  expect(text).toContain('npx @team/setup@beta update');
  expect(text).toContain('npx @team/setup@beta uninstall --yes');
  expect(text).not.toContain('@mearl/setup');
});

it('distinguishes an unselected installation and refuses corrupt ownership metadata', async () => {
  vi.mocked(readFileSync).mockReturnValue('{{setup}} update');
  vi.mocked(readInstallationManagement).mockResolvedValue({ setup: undefined, source: undefined, revision: undefined });
  expect(await readGuide('troubleshooting')).toContain('本机尚未选择 preset');
  vi.mocked(readInstallationManagement).mockRejectedValue(new Error('BUNDLE_INTEGRITY'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await runGuideCli(['troubleshooting'])).toBe(1);
  expect(log).not.toHaveBeenCalled();
});

it.each([['unknown'], ['../core'], ['--full'], ['--list', 'core'], ['core', 'extra']])('rejects invalid guide input: %j', async (...args) => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await runGuideCli(args)).toBe(2);
  expect(error).toHaveBeenCalledWith(expect.stringContaining('guide --list'));
});
