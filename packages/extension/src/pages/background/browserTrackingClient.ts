import type { TrackingRequestInput, TrackingRequestResult } from './browserTracking';

export type BrowserTrackingDecoder = (
  input: TrackingRequestInput,
) => Promise<TrackingRequestResult>;

export async function captureBrowserTrackingDecoder(): Promise<BrowserTrackingDecoder> {
  const tracking = await import('./browserTracking');
  return tracking.captureBrowserTrackingDecoder();
}
