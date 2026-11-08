/** Native Messaging identifiers shared by the installer and extension. */
export const MEARL_NATIVE_HOST_NAMES = {
  skills: 'ai.mearl.skills',
  mcp: 'ai.mearl.mcp',
} as const;

export type NativeHostIntegrationMode = keyof typeof MEARL_NATIVE_HOST_NAMES;
