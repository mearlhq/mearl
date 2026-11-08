import { isTrackingUrl, parseTrackingRequest, resolveAplusSpm, type TrackingParseOptions } from './eventParsers.js';

export interface TrackingInput {
  url: string;
  body?: string | Record<string, unknown> | null;
  options?: TrackingParseOptions;
}
/** The built-in default and independently installed bundles use the same handlers. */
export default function createTrackingPlugin() {
  return {
    tracking: () => ({ matches: isTrackingUrl, parse: parseTrackingRequest }),
    decode: (inputs: TrackingInput[]) => inputs.map(({ url, body, options }) => {
      try { return { tracking: isTrackingUrl(url), events: parseTrackingRequest(url, body, options) }; }
      catch (error) { return { tracking: isTrackingUrl(url), events: [], error: error instanceof Error ? error.message : String(error) }; }
    }),
    spm: ({ eventType, raw }: { eventType?: string; raw: Record<string, unknown> }) => resolveAplusSpm(eventType, raw),
  };
}
export { createTrackingPlugin };
