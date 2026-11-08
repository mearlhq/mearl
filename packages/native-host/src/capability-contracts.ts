import { createTrackingPlugin } from '@mearl/plugin-tracking';
import type { RequestCookie, RequestMetadata, ParsedSseEvent, RumEvent } from '@mearl/browser-core';
import { nativeCapabilities } from './native-capability-services.js';

/** Protocol-specific fields remain opaque to the HTTP host. */
export interface ResolvedProtocolRequest {
  requestData: unknown;
  normalizedMethod: 'GET' | 'POST'; timeout: number; gatewayUrl: URL;
  customHeaders: Record<string, string>;
  metadata?: RequestMetadata;
  [key: string]: unknown;
}
export interface PreparedProtocolRequest extends ResolvedProtocolRequest {
  targetUrl: URL; requestHeaders: Record<string, string>; cookieHeader: string; body?: string;
}
export type { RequestStreamCapture as ProtocolStreamCapture, RequestStreamCaptureResponse as ProtocolStreamCaptureResponse } from '@mearl/browser-core';
export type ProtocolStreamCaptureStart = Omit<import('@mearl/browser-core').RequestStreamCaptureStart, 'url'> & { url?: string };
export interface RequestProtocolCapability {
  resolveRequest(data: Record<string, unknown>): ResolvedProtocolRequest;
  prepareRequest(resolved: ResolvedProtocolRequest, cookies: readonly RequestCookie[], stream?: boolean): PreparedProtocolRequest;
  parseResponse(text: string): unknown;
  consumeResponse(response: Response, onReceive: (event: ParsedSseEvent) => void | Promise<void>): Promise<unknown>;

}
export interface TrackingCapability {
  matches(url: string): boolean;
  parse(url: string, postData?: string, options?: { sequence?: number; now?: number }): RumEvent[];
}
export function getRequestProtocolCapability(): RequestProtocolCapability { return nativeCapabilities.require('request.protocol')(); }
const builtinTracking: TrackingCapability = createTrackingPlugin().tracking();
export function getTrackingCapability(): TrackingCapability { return nativeCapabilities.get('tracking.request')?.() ?? builtinTracking; }
