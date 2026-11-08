import { BundleError, type SelectedBrowserView } from '@mearl/preset/bundles';

const sharedPreferences = {
  'editor.highlight': { key: 'code-editor-highlight-enabled', area: 'session' },
  'json.viewMode': { key: 'json-modal-view-mode', area: 'local' },
  'json.shortcuts': { key: 'json-modal-shortcuts-visible', area: 'local' },
  'code.shortcuts': { key: 'json-modal-code-shortcuts-visible', area: 'local' },
} as const;

/** Bundle preferences are namespaced; shared editor preferences have explicit host contracts. */
export function browserViewPreferenceKey(selected: SelectedBrowserView, key: string): string {
  const preference = selected.definition.preferences?.[key];
  if (!preference) throw new BundleError('BUNDLE_INVALID', 'Unknown browser view preference');
  if (preference.shared) {
    const definition = Object.hasOwn(sharedPreferences, preference.shared) ? sharedPreferences[preference.shared] : undefined;
    if (!definition || definition.area !== (preference.area ?? 'local') || !['requestImport', 'requestCases'].includes(selected.slot))
      throw new BundleError('BUNDLE_INVALID', 'Shared preference is outside its host position or area');
    return definition.key;
  }
  return `browser-view:${selected.bundleId}:${selected.slot}:${key}`;
}

export function validateBrowserViewPreferences(selected: SelectedBrowserView | undefined) {
  if (selected) for (const key of Object.keys(selected.definition.preferences ?? {})) browserViewPreferenceKey(selected, key);
  return selected;
}
