import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuffers } from '../buffers.js';
import type { PageSession } from '../cdp-session.js';
import { clearCdpFetchInterceptionState } from '../fetch-interceptor.js';
import { cdpGetMocks, cdpSetMock, clearCdpMockState } from '../mock-handlers.js';

function createSession(requests: any[] = []): {
  session: PageSession;
  sendCommand: ReturnType<typeof vi.fn>;
  paused: () => ((params: any) => Promise<void>) | undefined;
} {
  let pausedListener: ((params: any) => Promise<void>) | undefined;
  const sendCommand = vi.fn().mockResolvedValue({});
  const buffers = createBuffers(1000);
  buffers.requests.push(...requests);
  const session = {
    tabId: 1000,
    targetId: 'target-mock',
    url: 'https://market.m.shop.com/app/trip/rx-home/pages/home',
    buffers,
    client: {
      sendCommand,
      on: vi.fn((event: string, listener: (params: any) => Promise<void>) => {
        if (event === 'Fetch.requestPaused') pausedListener = listener;
        return () => {};
      }),
    },
  } as unknown as PageSession;
  return { session, sendCommand, paused: () => pausedListener };
}

afterEach(() => {
  clearCdpMockState();
  clearCdpFetchInterceptionState();
});

describe('CDP mock handlers', () => {
  it('isolates mocks between pages sharing the same browser connection', async () => {
    const first = createSession();
    const second = createSession();
    await cdpSetMock(first.session, { tabId: 1000, apiName: 'api', mockData: { owner: 'first' } });
    expect(cdpGetMocks(second.session, { tabId: 1000 }).count).toBe(0);
    await cdpSetMock(second.session, {
      tabId: 1000,
      apiName: 'api',
      mockData: { owner: 'second' },
    });
    expect(cdpGetMocks(first.session, { tabId: 1000 }).mocks[0].responseData).toEqual({
      owner: 'first',
    });
    expect(cdpGetMocks(second.session, { tabId: 1000 }).mocks[0].responseData).toEqual({
      owner: 'second',
    });
  });

  it('fields 使用最近的业务响应作为基线并跳过 OPTIONS', async () => {
    const apiName = 'sample.reader.feed.pattern.home';
    const realResponse = {
      ret: ['SUCCESS::调用成功'],
      data: {
        data: {
          s_vertical_homepage_wap_kingkong_2022: {
            fields: { 'waphome-slider-202207': [{ title: '原始标题', extra: true }] },
          },
        },
      },
    };
    const { session } = createSession([
      {
        method: 'GET',
        apiName,
        url: `https://h5api.m.shop.com/h5/${apiName}/1.0?data=${encodeURIComponent(
          JSON.stringify({ name: 'reader_home_new' }),
        )}`,
        responseBody: realResponse,
      },
      {
        method: 'GET',
        apiName,
        url: `https://h5api.m.shop.com/h5/${apiName}/1.0?data=${encodeURIComponent(
          JSON.stringify({ name: 'reader_home_guess_you_like_miniapp_new' }),
        )}`,
        responseBody: { data: { items: ['猜你喜欢'] } },
      },
      {
        method: 'OPTIONS',
        apiName,
        url: `https://h5api.m.shop.com/h5/${apiName}/1.0`,
        responseBody: null,
      },
    ]);

    await cdpSetMock(session, {
      apiName,
      fields: [
        {
          path: 'data.data.s_vertical_homepage_wap_kingkong_2022.fields.waphome-slider-202207[0].title',
          value: 'test',
        },
      ],
      conditions: { name: 'reader_home_new' },
    });

    expect(cdpGetMocks(session, { apiName }).mocks[0].responseData).toEqual({
      ret: ['SUCCESS::调用成功'],
      data: {
        data: {
          s_vertical_homepage_wap_kingkong_2022: {
            fields: { 'waphome-slider-202207': [{ title: 'test', extra: true }] },
          },
        },
      },
    });
  });

  it('透传预检并在响应阶段保留状态码和 CORS 响应头', async () => {
    const apiName = 'sample.reader.feed.pattern.home';
    const { session, sendCommand, paused } = createSession();
    await cdpSetMock(session, { apiName, mockData: { data: { title: 'test' } } });
    sendCommand.mockClear();

    await paused()?.({
      requestId: 'preflight-request',
      request: { method: 'OPTIONS', url: `https://h5api.m.shop.com/h5/${apiName}/1.0` },
    });
    expect(sendCommand).toHaveBeenLastCalledWith('Fetch.continueRequest', {
      requestId: 'preflight-request',
    });

    await paused()?.({
      requestId: 'preflight-response',
      request: { method: 'OPTIONS', url: `https://h5api.m.shop.com/h5/${apiName}/1.0` },
      responseStatusCode: 204,
      responseHeaders: [{ name: 'access-control-allow-origin', value: '*' }],
    });
    expect(sendCommand).toHaveBeenLastCalledWith('Fetch.continueResponse', {
      requestId: 'preflight-response',
    });

    await paused()?.({
      requestId: 'business-response',
      request: { method: 'GET', url: `https://h5api.m.shop.com/h5/${apiName}/1.0` },
      responseStatusCode: 206,
      responseHeaders: [
        { name: 'content-type', value: 'application/json' },
        { name: 'access-control-allow-origin', value: 'https://market.m.shop.com' },
        { name: 'content-encoding', value: 'gzip' },
        { name: 'content-length', value: '123' },
      ],
    });

    const fulfillCall = sendCommand.mock.calls.at(-1);
    expect(fulfillCall?.[0]).toBe('Fetch.fulfillRequest');
    expect(fulfillCall?.[1]).toMatchObject({
      requestId: 'business-response',
      responseCode: 206,
      responseHeaders: [
        { name: 'content-type', value: 'application/json' },
        { name: 'access-control-allow-origin', value: 'https://market.m.shop.com' },
      ],
    });
    expect(JSON.parse(Buffer.from(fulfillCall?.[1].body, 'base64').toString('utf8'))).toEqual({
      data: { title: 'test' },
    });
  });

  it('请求阶段的 duration mock 为跨域请求补齐 CORS 头', async () => {
    const apiName = 'mtop.test.api';
    const { session, sendCommand, paused } = createSession();
    await cdpSetMock(session, { apiName, mockData: { ok: true }, duration: 0 });
    sendCommand.mockClear();

    await paused()?.({
      requestId: 'duration-request',
      request: {
        method: 'GET',
        url: `https://h5api.m.shop.com/h5/${apiName}/1.0`,
        headers: { Origin: 'https://market.m.shop.com' },
      },
    });

    expect(sendCommand).toHaveBeenCalledWith(
      'Fetch.fulfillRequest',
      expect.objectContaining({
        responseHeaders: expect.arrayContaining([
          {
            name: 'access-control-allow-origin',
            value: 'https://market.m.shop.com',
          },
          { name: 'access-control-allow-credentials', value: 'true' },
        ]),
      }),
    );
  });

  it('请求阶段的 duration mock 保留 JSONP 传输', async () => {
    const apiName = 'mtop.test.jsonp';
    const { session, sendCommand, paused } = createSession();
    await cdpSetMock(session, { apiName, mockData: { data: { mocked: true } }, duration: 0 });
    sendCommand.mockClear();

    await paused()?.({
      requestId: 'jsonp-duration',
      request: {
        method: 'GET',
        url: `https://h5api.m.shop.com/h5/${apiName}/1.0?callback=mtopjsonp42`,
      },
    });

    const fulfillCall = sendCommand.mock.calls.at(-1);
    expect(Buffer.from(fulfillCall?.[1].body, 'base64').toString('utf8')).toBe(
      'mtopjsonp42({"data":{"mocked":true}});',
    );
    expect(fulfillCall?.[1].responseHeaders).toContainEqual({
      name: 'content-type',
      value: 'application/javascript; charset=utf-8',
    });
  });

  it('响应阶段的 mock 保留 JSONP 传输和响应元数据', async () => {
    const apiName = 'mtop.test.jsonp.response';
    const { session, sendCommand, paused } = createSession();
    await cdpSetMock(session, { apiName, mockData: { ret: ['SUCCESS::调用成功'] } });
    sendCommand.mockClear();

    await paused()?.({
      requestId: 'jsonp-response',
      request: {
        method: 'GET',
        url: `https://h5api.m.shop.com/h5/${apiName}/1.0?jsonp=callback_7`,
      },
      responseStatusCode: 206,
      responseHeaders: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Content-Encoding', value: 'gzip' },
        { name: 'X-Test', value: 'kept' },
      ],
    });

    const fulfillCall = sendCommand.mock.calls.at(-1);
    expect(fulfillCall?.[1].responseCode).toBe(206);
    expect(Buffer.from(fulfillCall?.[1].body, 'base64').toString('utf8')).toBe(
      'callback_7({"ret":["SUCCESS::调用成功"]});',
    );
    expect(fulfillCall?.[1].responseHeaders).toEqual([
      { name: 'Content-Type', value: 'application/javascript; charset=utf-8' },
      { name: 'X-Test', value: 'kept' },
    ]);
  });
});
