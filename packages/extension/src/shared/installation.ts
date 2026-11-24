import { setupCommand } from './extensionVersion';
import site from '@mearl/preset/installation-site.json';
import type { BrowserUiText } from '@mearl/preset/bundles';

export const INSTALLATION_ACTION = 'mearlInstallation';
export const SHOW_PRESET_INSTALLATION_POPUP = 'mearlShowPresetInstallation';
export const INSTALLATION_VIEW_PATH = 'src/pages/installation/index.html';
export const INSTALLATION_SITE = new URL(site.url);
export const INSTALLATION_BRIDGE_URL = new URL('bridge.html', INSTALLATION_SITE).href;

export interface InstallationOpening {
  session: string;
  inline?: boolean;
}

export interface InstallationPreview {
  purpose?: BrowserUiText;
  appProfileCount: number;
  packageCount: number;
  skillCount: number;
  providerCount: number;
}

export interface InstallationView {
  session: string;
  presetId: string;
  label: string;
  source: string;
  origins: string[];
  missingOrigins: string[];
  missingAuthorization: string[];
  browserReady: boolean;
  browserRequired?: boolean;
  ready?: boolean;
  needsInstall: boolean;
  localComponentCount: number;
  localStatus?: 'none' | 'setup-required' | 'ready' | 'pending';
  localIssues?: Array<{ id: string; reason: string }>;
  sourceRequest?:
    | { catalogUrl: string; requestingPage: string; presetUrl?: never }
    | { presetUrl: string; catalogUrl?: never; requestingPage?: never };
  needsSourceConfirmation?: boolean;
  presetChoices?: { id: string; label: string }[];
}

export function setupPresetCommand(source: string, windows = false): string {
  const escaped = windows ? source.replaceAll("'", "''") : source.replaceAll("'", "'\\''");
  return `${setupCommand()} --preset '${escaped}'`;
}
