import type { TrackingRequestInput, TrackingRequestResult } from '../../background/browserTracking';
export async function decodeTrackingRequest(input: TrackingRequestInput): Promise<TrackingRequestResult> {
  const response = await chrome.runtime.sendMessage({ action: 'browserTracking', data: { operation: 'decode', input } });
  if (!response?.success) throw new Error(response?.error || 'Tracking decoder unavailable');
  return response.data;
}
