import type { QuickAppProfileName, QuickDevicePresetName, QuickDeviceOrientation } from './quickAppProfile';

export type QuickDeviceToolbarOperation =
  | { type: 'app'; profile: QuickAppProfileName | null }
  | { type: 'preset'; preset: QuickDevicePresetName | null }
  | { type: 'orientation' | 'shell' | 'phoneFrame' };

export interface QuickDeviceToolbarState {
  profile: string | null;
  profiles: Array<{ id: string; label: string }>;
  preset: QuickDevicePresetName;
  presets: Array<{ id: QuickDevicePresetName; label: string }>;
  orientation: QuickDeviceOrientation;
}

export interface QuickDeviceToolbarSelection {
  profile: QuickDeviceToolbarState['profiles'][number] | null;
  preset: QuickDeviceToolbarState['presets'][number];
  orientation: QuickDeviceOrientation;
}
