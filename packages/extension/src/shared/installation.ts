import { setupCommand } from './extensionVersion';
import site from '@mearl/preset/installation-site.json';

export const INSTALLATION_ACTION = 'mearlInstallation';
export const INSTALLATION_VIEW_PATH = 'src/pages/installation/index.html';
export const INSTALLATION_SITE = new URL(site.url);
export const INSTALLATION_BRIDGE_URL = new URL('bridge.html', INSTALLATION_SITE).href;

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
  sourceRequest?: { catalogUrl: string; requestingPage: string };
  needsSourceConfirmation?: boolean;
}

export function setupPresetCommand(source: string, windows = false): string {
  const escaped = windows ? source.replaceAll("'", "''") : source.replaceAll("'", "'\\''");
  return `${setupCommand()} --preset '${escaped}'`;
}
