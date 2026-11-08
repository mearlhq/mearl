import { invokeBrowserCapability } from '../browserCapabilities';

/** Reads the identity selected by the installed browser capability. */
export async function getPanelIdentity(): Promise<string> {
  const result = await invokeBrowserCapability('identity.panel', {});
  if (!result.available) throw new Error('CAPABILITY_NOT_INSTALLED');
  if (typeof result.value !== 'string' || !result.value) throw new Error('Invalid panel identity');
  return result.value;
}
