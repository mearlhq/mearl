import { invokeBrowserCapability } from '../browserCapabilities';
import { isExternalServiceEnabled } from '../externalServices';
import { browserRequestUiSelection } from '../browserRequestUiState';

export async function fetchApiSchema(data: { api: string; version?: string; fields?: ('schema' | 'hsf')[] }): Promise<any> {
  if (!data.api || typeof data.api !== 'string' || !data.api.trim()) throw new Error('Invalid api: api must be a non-empty string');
  const { selected } = await browserRequestUiSelection();
  if (!selected) throw new Error('CAPABILITY_NOT_INSTALLED');
  if (!(await isExternalServiceEnabled(selected.definition.setting.key))) throw new Error('REQUEST_METADATA_DISABLED');
  const result = await invokeBrowserCapability('request.apiSchema', data, { bundleId: selected.bundleId, revision: selected.revision });
  if (!result.available) throw new Error('CAPABILITY_NOT_INSTALLED');
  return result.value;
}
