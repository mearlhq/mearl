export const repositoryUrl = 'https://github.com/mearlhq/mearl';

export const referenceDocs = {
  'cli-sdk': 'packages/client/README.md',
  mcp: 'packages/mcp-server/README.md',
  skills: 'skills/README.md',
  providers: 'packages/provider/README.md',
  'capability-model': 'docs/capability-model.md',
  presets: 'packages/preset/README.md',
  setup: 'packages/setup/README.md',
  extension: 'packages/extension/README.md',
};

export function localizedDocFile(file, locale) {
  return locale === 'en' ? file.replace(/\.md$/, '.en.md') : file;
}

export function localePrefix(locale) {
  return locale === 'en' ? 'en/' : '';
}

const routesByFile = new Map(Object.entries(referenceDocs).flatMap(([id, file]) => [
  [file, `reference/${id}.html`],
  [localizedDocFile(file, 'en'), `${localePrefix('en')}reference/${id}.html`],
]));

export function referenceRoute(file) {
  return routesByFile.get(file);
}
