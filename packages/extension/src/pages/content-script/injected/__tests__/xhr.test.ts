import { afterEach, describe, expect, it, vi } from 'vitest';
import { interceptXHR } from '../xhr';

class FakeXMLHttpRequest extends EventTarget {
  method = '';
  url = '';
  responseText = '';
  responseType: XMLHttpRequestResponseType = '';
  status = 200;
  statusText = 'OK';
  readyStateReads = 0;

  get readyState(): number {
    this.readyStateReads += 1;
    return 3;
  }

  open(method: string, url: string | URL): void {
    this.method = method;
    this.url = String(url);
  }

  setRequestHeader(): void {}

  send(): void {}

  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null;
  }

  getAllResponseHeaders(): string {
    return 'content-type: text/event-stream; charset=utf-8\r\n';
  }
}

describe('XHR SSE interception', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete window.__mearlConfig;
  });

  it('collects progress without accessing readyState or onreadystatechange', () => {
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    interceptXHR();

    const xhr = new XMLHttpRequest() as unknown as FakeXMLHttpRequest;
    xhr.open('GET', '/events');
    xhr.send();
    xhr.responseText = 'data: hello\n\n';
    xhr.dispatchEvent(new ProgressEvent('progress'));
    xhr.dispatchEvent(new ProgressEvent('load'));

    expect(xhr.readyStateReads).toBe(0);
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'SSE_RESPONSE', resourceType: 'xhr' }),
        expect.objectContaining({ type: 'SSE_CHUNK', data: 'hello' }),
        expect.objectContaining({ type: 'SSE_COMPLETE' }),
      ]),
    );
  });
});
