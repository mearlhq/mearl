export const PRESET_AUTO_UPDATE_KEY = 'presetAutoUpdate';
export const PRESET_MANAGEMENT_ACTION = 'mearlPresetManagement';

export interface InstalledPreset {
  id: string;
  version?: string;
  source?: string;
  browserRevision: string | null;
  nativeRevision?: string;
  canUninstall: boolean;
}
export interface PresetAutoUpdateResult {
  status:
    | 'skipped'
    | 'current'
    | 'updated'
    | 'permission-required'
    | 'waiting-native'
    | 'untrusted'
    | 'failed';
  id?: string;
  source?: string;
  origins?: string[];
  error?: string;
}
export interface PresetAutoUpdateState extends PresetAutoUpdateResult {
  checkedAt: number;
  nextCheckAt: number;
}
