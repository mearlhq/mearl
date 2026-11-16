import type {
  QuickAppProfileName,
  QuickDevicePresetName,
  QuickDeviceOrientation,
} from './quickAppProfile';

export const DEVICE_PREVIEW_TOOLBAR_MESSAGE_KEYS = [
  'deviceSimulation',
  'deviceSimulationApp',
  'deviceSimulationNoApp',
  'deviceSimulationMobileDevice',
  'deviceSimulationDisable',
  'deviceSimulationEnableLandscape',
  'deviceSimulationDisableLandscape',
  'deviceSimulationShell',
  'deviceSimulationPhoneFrame',
  'devicePreviewToolbar',
  'devicePreviewToolbarCollapse',
  'deviceSimulationChangeFailed',
] as const;

export type QuickDeviceToolbarLabels = Record<
  (typeof DEVICE_PREVIEW_TOOLBAR_MESSAGE_KEYS)[number],
  string
>;

export type QuickDeviceToolbarOperation =
  | { type: 'app'; profile: QuickAppProfileName | null }
  | { type: 'preset'; preset: QuickDevicePresetName | null }
  | { type: 'orientation' | 'shell' | 'phoneFrame' };

interface QuickDeviceToolbarPreset {
  id: QuickDevicePresetName;
  label: string;
}

export interface QuickDeviceToolbarState {
  profile: string | null;
  profiles: Array<{ id: string; label: string }>;
  preset: QuickDevicePresetName;
  presetGroups: Array<{
    adaptive?: QuickDeviceToolbarPreset;
    fixed: QuickDeviceToolbarPreset[];
  }>;
  orientation: QuickDeviceOrientation;
  labels?: QuickDeviceToolbarLabels;
}

export interface QuickDeviceToolbarSelection {
  profile: QuickDeviceToolbarState['profiles'][number] | null;
  preset: QuickDeviceToolbarPreset;
  orientation: QuickDeviceOrientation;
  labels?: QuickDeviceToolbarLabels;
}
