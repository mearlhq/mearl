export interface AplusSpmResolution { mainSpm: string; highlightSpm: string }
export async function resolveAplusSpm(eventType: string | undefined, raw: Record<string, unknown>): Promise<AplusSpmResolution> {
  const response = await chrome.runtime.sendMessage({ action: 'browserTracking', data: { operation: 'spm', input: { eventType, raw } } });
  if (!response?.success) throw new Error(response?.error || 'Tracking point decoder unavailable');
  return response.data;
}
