import { expect, it } from 'vitest';
import {
  browserViewPreferenceKey,
  validateBrowserViewPreferences,
} from '../browserViewPreferences';
import type { SelectedBrowserView } from '@mearl/preset/bundles';
const selected = (preference: object): SelectedBrowserView => ({
  bundleId: 'example',
  revision: 'accepted',
  slot: 'requestImport',
  html: '<main/>',
  definition: {
    schemaVersion: 1,
    entry: 'view.html',
    actions: {},
    preferences: { value: preference },
  },
});
it('shares only explicit editor preferences and namespaces other values', () => {
  expect(browserViewPreferenceKey(selected({ shared: 'json.viewMode' }), 'value')).toBe('json-modal-view-mode');
  expect(browserViewPreferenceKey(selected({ shared: 'editor.highlight', area: 'session' }), 'value')).toBe('code-editor-highlight-enabled');
  expect(browserViewPreferenceKey(selected({}), 'value')).toBe('browser-view:example:requestImport:value');
  expect(browserViewPreferenceKey({ ...selected({}), slot: 'requestCases' }, 'value')).toBe('browser-view:example:requestCases:value');
});
it.each([{ shared: 'apiToken' }, { shared: 'editor.highlight' }, { shared: 'json.viewMode', area: 'session' }])('rejects undeclared host preferences and areas %j', preference => {
  expect(() => validateBrowserViewPreferences(selected(preference))).toThrow();
});
it('does not expose editor preferences to resident capture controllers', () => {
  expect(() => validateBrowserViewPreferences({ ...selected({ shared: 'json.viewMode' }), slot: 'captureController' })).toThrow();
});
