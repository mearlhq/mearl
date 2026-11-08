import { detectGlobalPackage, type DetectedGlobalPackage } from './packageManager.js';

export type MearlProfile = 'local' | 'cloud' | 'mcp';

export interface MearlProfileConfig {
  id: MearlProfile;
  label: string;
  anchorPackage: string;
  anchorBins: string[];
  packages: string[];
  usesSkill: boolean;
}

export const MEARL_PROFILES: Record<MearlProfile, MearlProfileConfig> = {
  local: {
    id: 'local',
    label: 'local browser',
    anchorPackage: '@mearl/native-host',
    anchorBins: ['mearl-native-host'],
    packages: ['@mearl/native-host', '@mearl/client'],
    usesSkill: true,
  },
  cloud: {
    id: 'cloud',
    label: 'cloud agent',
    anchorPackage: '@mearl/cloud-server',
    anchorBins: ['mearl-cloud-server'],
    packages: ['@mearl/cloud-server', '@mearl/client'],
    usesSkill: true,
  },
  mcp: {
    id: 'mcp',
    label: 'MCP',
    anchorPackage: '@mearl/mcp-server',
    anchorBins: ['mearl-mcp-server'],
    packages: ['@mearl/mcp-server'],
    usesSkill: false,
  },
};

export type DetectedMearlProfiles = Map<MearlProfile, DetectedGlobalPackage>;

export function detectMearlProfiles(
  options: Parameters<typeof detectGlobalPackage>[2] = {},
): DetectedMearlProfiles {
  const detected: DetectedMearlProfiles = new Map();
  for (const profile of Object.values(MEARL_PROFILES)) {
    const installation = detectGlobalPackage(profile.anchorPackage, profile.anchorBins, options);
    if (installation) detected.set(profile.id, installation);
  }
  return detected;
}
