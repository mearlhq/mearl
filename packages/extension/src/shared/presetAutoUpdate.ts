export const PRESET_AUTO_UPDATE_KEY = 'presetAutoUpdate';
export interface PresetAutoUpdateResult {
  status: 'skipped' | 'current' | 'updated' | 'permission-required' | 'waiting-native' | 'untrusted' | 'failed';
  id?: string;
  source?: string;
  origins?: string[];
  error?: string;
}
export interface PresetAutoUpdateState extends PresetAutoUpdateResult {
  checkedAt: number;
  nextCheckAt: number;
}
