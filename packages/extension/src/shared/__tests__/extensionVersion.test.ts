import { afterEach, expect, it, vi } from 'vitest';
import { getExtensionVersion, setupCommand } from '../extensionVersion';
import { setupPresetCommand } from '../installation';

afterEach(() => vi.restoreAllMocks());
it('displays the verified release version and uses the beta tag for setup instructions', () => {
  vi.spyOn(chrome.runtime, 'getManifest').mockReturnValue({ manifest_version: 3, name: 'Mearl', version: '3.0.0.0', version_name: '3.0.0-beta.0' });
  expect(getExtensionVersion()).toBe('3.0.0-beta.0');
  expect(setupCommand()).toBe('npx @mearl/setup@beta');
  expect(setupPresetCommand('https://example.test/preset.json')).toBe("npx @mearl/setup@beta --preset 'https://example.test/preset.json'");
  expect(setupCommand('3.0.0')).toBe('npx @mearl/setup');
});
