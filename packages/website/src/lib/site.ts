import extensionPackage from '../../../extension/package.json';
import installationSite from '@mearl/preset/installation-site.json';
import {
  localizedDocFile,
  localePrefix,
  referenceDocs,
  referenceRoute,
  repositoryUrl,
} from './reference-docs.mjs';
import { siteCopy } from './site-copy';

export type Locale = 'en' | 'zh-CN';
export const guidePages = [
  'installation',
  'quick-start',
  'browsers',
  'browser-automation',
  'web-debugging',
  'authenticated-requests',
  'emulation',
  'ego-lite',
  'skill-plugins',
  'bb-browser',
] as const;
export type Guide = (typeof guidePages)[number];
export type Reference = keyof typeof referenceDocs;
export type Page = 'home' | 'extension' | 'installed' | Guide | `reference/${Reference}`;

export { repositoryUrl };
export const chromeStoreUrl = `https://chromewebstore.google.com/detail/mearl/${installationSite.extensionId}`;
export const releaseLine = extensionPackage.version.split('.').slice(0, 2).join('.');
export const setupCommand = 'npx @mearl/setup';
export const firstTask = `mearl run <<'JS'
const tab = await mearl.tabOpen({ url: 'https://example.com' });
const page = await mearl.pageSnapshot({ tabId: tab.tabId });
console.log(page.snapshot);
JS`;

export const siteBase = import.meta.env.BASE_URL.replace(/\/?$/, '/');

export function clientDemoPath(locale: Locale) {
  return `${siteBase}demos/client-h5.html?lang=${locale}`;
}

export function sitePath(locale: Locale, page: Page = 'home') {
  if (page === 'home') return siteBase + (locale === 'en' ? 'en.html' : '');
  return siteBase + localePrefix(locale) + `${page}.html`;
}

export function docPath(locale: Locale, path: string, anchor = '') {
  const file = localizedDocFile(path, locale);
  const route = referenceRoute(file);
  return (route ? siteBase + route : `${repositoryUrl}/blob/main/${file}`) + anchor;
}

export function referenceLinks(locale: Locale) {
  const t = siteCopy[locale];
  return [
    { label: t.connections, page: 'browsers', href: sitePath(locale, 'browsers') },
    { label: t.cli, page: 'reference/cli-sdk', href: docPath(locale, referenceDocs['cli-sdk']) },
    { label: t.mcp, page: 'reference/mcp', href: docPath(locale, referenceDocs.mcp) },
    { label: t.skills, page: 'reference/skills', href: docPath(locale, referenceDocs.skills) },
  ] satisfies Array<{ label: string; page: Page; href: string }>;
}

export function docsNavigation(locale: Locale) {
  const t = siteCopy[locale];
  return [
    {
      label: t.gettingStarted,
      links: [
        { page: 'home', label: t.intro },
        { page: 'installation', label: t.install },
        { page: 'quick-start', label: t.quickstart },
        { page: 'extension', label: t.chromeExtension },
      ],
    },
    {
      label: t.workflows,
      links: [
        { page: 'browser-automation', label: t.automation },
        { page: 'web-debugging', label: t.debugging },
        { page: 'authenticated-requests', label: t.authenticatedRequests },
        { page: 'emulation', label: t.emulation },
      ],
    },
    {
      label: t.integrations,
      links: [
        { page: 'skill-plugins', label: t.skillPlugins },
        { page: 'ego-lite', label: 'EgoLite' },
        { page: 'bb-browser', label: t.bbAdapters },
      ],
    },
  ] satisfies Array<{ label: string; links: Array<{ page: Page; label: string }> }>;
}
