import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { installAppProfileMessageRelay } from '../environment/relay.js';

function page(options: object = {}, child = false) {
  const listeners: Array<(event: any) => void> = [], binding = vi.fn(), postMessage = vi.fn();
  const context = createContext({ addEventListener: (_type: string, listener: (event: any) => void) => listeners.push(listener),
    postMessage, ownBinding: binding, console: { warn: vi.fn() } });
  runInContext(`globalThis.top=${child ? '{}' : 'globalThis'};`, context);
  const source = `(${installAppProfileMessageRelay.toString()})('ownBinding',${JSON.stringify(options)})`;
  runInContext(source, context);
  const global = runInContext('globalThis', context);
  const send = (type: string, extra: object = {}) => listeners[0]!({ source: global, data: { source: 'mearl-app-bridge', type, requestId: 1, ...extra } });
  return { listeners, binding, postMessage, context, source, send };
}

describe('serialized App bridge relay', () => {
  it('preserves the complete existing host request set and installs its listener once', () => {
    const f = page();
    for (const type of ['protocol', 'protocolStream', 'userInfo', 'authCode', 'authCodeCancel', 'settings', 'screenshot']) f.send(type);
    expect(f.binding.mock.calls.map(([payload]) => JSON.parse(payload).type)).toEqual(['protocol', 'protocolStream', 'userInfo', 'authCode', 'authCodeCancel', 'settings', 'screenshot']);
    runInContext(f.source, f.context);
    expect(f.listeners).toHaveLength(1);
    expect(f.postMessage).not.toHaveBeenCalled();
  });

  it('rejects an unsupported stream with a terminal error rather than silently waiting', () => {
    const f = page({ markerName: '__separateOwner__', supportedTypes: ['protocol'] });
    f.send('protocolStream');
    expect(f.binding).not.toHaveBeenCalled();
    expect(f.postMessage).toHaveBeenCalledWith(expect.objectContaining({ source: 'mearl-content', type: 'APP_BRIDGE_PROTOCOL_STREAM_EVENT', eventType: 'onError', requestId: 1, data: { error: expect.any(String) } }), '*');
    f.send('protocol', { payload: { api: 'sample.api' } });
    expect(JSON.parse(f.binding.mock.calls[0]![0]).payload).toEqual({ api: 'sample.api' });
  });

  it('keeps child frames from submitting top-document settings and answers WebView preparation locally', () => {
    const f = page({}, true);
    f.send('settings'); f.send('prepareWebView');
    expect(f.binding).not.toHaveBeenCalled();
    expect(f.postMessage).toHaveBeenCalledExactlyOnceWith({ source: 'mearl-content', type: 'APP_BRIDGE_PREPARE_WEBVIEW_RESPONSE', requestId: 1, result: { success: true } }, '*');
  });

  it('ignores foreign events and reports a missing native binding as a normal bridge failure', () => {
    const f = page();
    f.listeners[0]!({ source: {}, data: { source: 'mearl-app-bridge', type: 'protocol', requestId: 1 } });
    f.send('unknown'); f.send('protocol', { requestId: undefined }); f.send('protocol', { source: 'foreign' });
    expect(f.binding).not.toHaveBeenCalled(); expect(f.postMessage).not.toHaveBeenCalled();
    runInContext('delete globalThis.ownBinding', f.context); f.send('userInfo');
    expect(f.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'APP_BRIDGE_USER_INFO_RESPONSE', result: { success: false, error: 'native relay binding is unavailable' } }), '*');
  });
});
