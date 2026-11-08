const themeValues = new Set(['light', 'dark']);

export function normalizeThemePreference(value) {
  return value === 'system' || themeValues.has(value) ? value : 'system';
}

export function resolveThemePreference(preference, systemTheme) {
  return preference === 'system' ? systemTheme : preference;
}

export function getPreferenceForTheme(theme, systemTheme) {
  return theme === systemTheme ? 'system' : theme;
}
