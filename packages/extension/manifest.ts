import installationSite from '@mearl/preset/installation-site.json';
import type { ManifestV3Export } from '@crxjs/vite-plugin';
import { ALLOWED_ORIGINS_LIST } from './src/shared/allowedOrigins';
import { EARLY_CONTENT_SCRIPT_FILES } from './src/shared/appProfileRuntimeAsset';
import { chatVisualizationCdn } from './src/shared/chatVisualizationCdn';
import { DEVICE_PREVIEW_PANEL_PAGE } from './src/shared/devicePreviewPanel';

const installationOrigin = `${new URL(installationSite.url).origin}/*`;
const contentScriptMatches = [...ALLOWED_ORIGINS_LIST, installationOrigin];

function customWebsiteUrl(value: string | undefined): URL | undefined {
  if (!value?.trim()) return;
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username || url.password || url.search || url.hash ||
    url.hostname.includes('*') || url.origin === new URL(installationSite.url).origin
  ) throw new Error('MEARL_WEBSITE_URL must be a separate HTTPS website directory URL');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

export const customWebsite = customWebsiteUrl(process.env.MEARL_WEBSITE_URL);

interface ContentScriptDefinition {
  matches: string[];
  js: string[];
  run_at: 'document_start';
  all_frames: boolean;
  match_origin_as_fallback: boolean;
  world?: 'MAIN';
}

const contentScripts: ContentScriptDefinition[] = [
  {
    matches: contentScriptMatches,
    js: EARLY_CONTENT_SCRIPT_FILES,
    run_at: 'document_start',
    all_frames: true,
    match_origin_as_fallback: true,
    world: 'MAIN',
  },
  {
    matches: contentScriptMatches,
    js: ['src/pages/content-script/index.js'],
    run_at: 'document_start',
    all_frames: true,
    match_origin_as_fallback: true,
  },
];

const manifest: ManifestV3Export = {
  manifest_version: 3,
  minimum_chrome_version: '120',
  version: '0.0.0',
  name: '__MSG_extName__',
  description: '__MSG_extDescription__',
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAufNWVWLreVJsSZnOhIaNJ7TA6aoeMorfy0oQM2pcxN1w1lRn2mpUs8y9I1vop0zyTmIrpcUfP3aEphrACjqPIgtK7KP6ms9UeZAIi3LnavZgTX0Z5TybTV+PjJe/fM5EG6l1388CaAn/U7fparD0D9X+FbxCzGmiXN7nIHnWtdkxC3SWfVVz0GlLG7Eb1uKBa6ZE0C7o6yHPy9AdZh7b8Ksu0wHD0HbhxBsXVYPvqLNIU9kjwjMdnCAOaKc1NfA6sMpIzJ7J+9t39f4ej97V5F0S8smMgM0nQn90gGT+GeKnEXTEHlwkVwn1v3gSyvyWVxs+8+r8m9/SEm5qgcytbwIDAQAB',
  default_locale: 'zh_CN',
  icons: {
    '16': 'icons/icon-16x16.png',
    '32': 'icons/icon-32x32.png',
    '48': 'icons/icon-48x48.png',
    '128': 'icons/icon-128x128.png',
  },
  action: {
    default_popup: 'src/pages/popup/index.html',
    default_icon: {
      '16': 'icons/icon-16x16.png',
      '32': 'icons/icon-32x32.png',
      '48': 'icons/icon-48x48.png',
      '128': 'icons/icon-128x128.png',
    },
  },
  devtools_page: 'src/pages/devtools/index.html',
  options_ui: {
    page: 'src/pages/options/index.html',
    open_in_tab: true,
  },
  side_panel: {
    default_path: 'src/pages/sidepanel/index.html',
  },
  commands: {
    'open-agent-side-panel': {
      suggested_key: {
        default: 'Ctrl+Shift+M',
        mac: 'MacCtrl+Shift+M',
      },
      description: '__MSG_commandToggleAgentSidePanel__',
    },
    'open-agent-side-panel-alternate': {
      suggested_key: {
        default: 'Alt+Shift+M',
      },
      description: '__MSG_commandToggleAgentSidePanelAlternate__',
    },
  },
  background: {
    service_worker: 'src/pages/background/index.ts',
    type: 'module',
  },
  sandbox: {
    pages: ['plugin/sandbox.html', 'plugin/visualization.html'],
  },
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self';",
    sandbox: `sandbox allow-scripts allow-forms allow-downloads; script-src 'self' 'unsafe-inline' 'unsafe-eval' ${chatVisualizationCdn.scripts}; style-src 'self' 'unsafe-inline' ${chatVisualizationCdn.styles}; img-src 'self' data: blob:; font-src 'self' data: ${chatVisualizationCdn.fonts}; media-src 'self' data: blob:; connect-src 'none'; frame-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none';`,
  },
  content_scripts: contentScripts,
  web_accessible_resources: [{
    resources: [DEVICE_PREVIEW_PANEL_PAGE, 'plugin/sandbox.html'],
    matches: ['http://*/*', 'https://*/*'],
  }],
  externally_connectable: { ids: ['*'], matches: [new URL('*', installationSite.url).href] },
  permissions: [
    'debugger',
    'downloads',
    'clipboardWrite',
    'clipboardRead',
    'storage',
    'alarms',
    'unlimitedStorage',
    'sidePanel',
    'contextMenus',
    'cookies',
    'webNavigation',
    'nativeMessaging',
    'declarativeNetRequest',
    'declarativeNetRequestFeedback',
    'scripting',
    'userScripts',
    'activeTab',
    'tabGroups',
    'offscreen',
  ],
  host_permissions: [
    ...ALLOWED_ORIGINS_LIST,
    'https://www.google-analytics.com/*',
    'https://skills.sh/*',
    'https://api.github.com/*',
    // Release downloads for the remote config and toolbox catalog redirect to the asset host.
    'https://github.com/*',
    'https://release-assets.githubusercontent.com/*',
    installationOrigin,
    ...(customWebsite ? [`https://${customWebsite.hostname}/*`] : []),
  ],
  optional_host_permissions: ['<all_urls>'],
};

export default manifest;
