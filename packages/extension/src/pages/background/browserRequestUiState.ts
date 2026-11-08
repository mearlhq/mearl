import { browserCapabilityRegistry } from './browserCapabilityRegistry';
import { isExternalServiceEnabled } from './externalServices';

export async function browserRequestUiSelection() {
  const selected = await browserCapabilityRegistry().requestUi() ?? null;
  return { selected, definition: selected?.definition ?? null };
}
export async function browserRequestUiState() {
  const state = await browserRequestUiSelection();
  return { ...state, enabled: state.definition ? await isExternalServiceEnabled(state.definition.setting.key) : false };
}
