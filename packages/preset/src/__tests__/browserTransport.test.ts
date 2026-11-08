import { expect, it } from 'vitest';
import { browserTransportUrl, browserTransportPolicies, validateBrowserView } from '../bundles.js';

it('validates finite read transports and excludes privileged setting keys', () => {
  const view = { schemaVersion: 1, entry: 'view.html', actions: {}, transports: { capture: { kind: 'websocket', setting: 'exampleEnabled' } } };
  expect(validateBrowserView(view).transports?.capture.kind).toBe('websocket');
  for (const transport of [{ kind: 'socket', setting: 'exampleEnabled' }, { kind: 'eventSource', setting: 'agentEnabled' }, { kind: 'eventSource', setting: 'exampleEnabled', code: 'evil' }]) expect(() => validateBrowserView({ ...view, transports: { capture: transport } })).toThrow();
});
it('maps socket URLs to their Chrome permission origins without exposing credentials or fragments', () => {
  expect(browserTransportUrl('wss://example.com:8080/capture?user=1', 'websocket')).toEqual({ url: 'wss://example.com:8080/capture?user=1', permissionUrl: 'https://example.com:8080/capture?user=1' });
  expect(browserTransportUrl('ws://127.0.0.1:1234/', 'websocket').permissionUrl).toBe('http://127.0.0.1:1234/');
  expect(browserTransportUrl('https://example.com/sse', 'eventSource').url).toBe('https://example.com/sse');
  for (const url of ['file:///tmp/file', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/#fragment']) expect(() => browserTransportUrl(url, 'eventSource')).toThrow();
  expect(() => browserTransportUrl('https://example.com/', 'websocket')).toThrow();
  expect(() => browserTransportUrl('wss://example.com/', 'eventSource')).toThrow();
});
it('intersects independent domain choices and Chrome grants without permitting policy injection', () => {
  expect(browserTransportPolicies(['*://*.example.com/*', "*://evil'; connect-src */*"], ['https://api.example.com/*'], false, 'eventSource')).toEqual([
    'connect-src http://example.com:* http://*.example.com:* https://example.com:* https://*.example.com:* ws://example.com:* ws://*.example.com:* wss://example.com:* wss://*.example.com:*',
    'connect-src https://api.example.com:*',
  ]);
  expect(browserTransportPolicies([], [], false, 'eventSource')).toEqual(["connect-src 'none'", "connect-src 'none'"]);
  expect(browserTransportPolicies(['<all_urls>', 'https://example.com/*', '*://*/*'], [], false, 'eventSource')[0]).toBe("connect-src 'none'");
  expect(browserTransportPolicies([], ['<all_urls>'], true, 'eventSource')).toEqual(['connect-src http: https: ws: wss:', 'connect-src https: http:']);
});
it('does not widen HTTP-only Chrome grants through CSP implicit HTTPS upgrades', () => {
  expect(browserTransportPolicies([], ['http://only.example.com/*'], true, 'eventSource')[1]).toBe("connect-src 'none'");
  expect(browserTransportPolicies([], ['http://*.example.com/*', 'https://api.example.com/*'], true, 'eventSource')[1]).toBe('connect-src https://api.example.com:* http://api.example.com:*');
  expect(browserTransportPolicies([], ['https://*.example.com/*', 'http://api.example.com/*'], true, 'eventSource')[1]).toBe('connect-src https://example.com:* https://*.example.com:* http://api.example.com:*');
  expect(browserTransportPolicies([], ['http://only.example.com/*'], true, 'websocket')[1]).toContain('ws://only.example.com:*');
});
