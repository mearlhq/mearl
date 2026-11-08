export interface MockResponseHeader {
  name: string;
  value: string;
}

export interface SerializedMockResponse {
  body: string;
  isJsonp: boolean;
}

const JSONP_CALLBACK_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const JSONP_CONTENT_TYPE = 'application/javascript; charset=utf-8';

function getJsonpCallback(url: string): string | null {
  try {
    const searchParams = new URL(url).searchParams;
    const callback = searchParams.get('callback') ?? searchParams.get('jsonp');
    return callback && JSONP_CALLBACK_RE.test(callback) ? callback : null;
  } catch {
    return null;
  }
}

export function serializeMockResponse(
  requestUrl: string,
  responseData: unknown,
): SerializedMockResponse {
  const callback = getJsonpCallback(requestUrl);
  if (!callback) {
    return {
      body:
        typeof responseData === 'string' ? responseData : (JSON.stringify(responseData) ?? 'null'),
      isJsonp: false,
    };
  }

  let json = JSON.stringify(responseData) ?? 'null';
  if (typeof responseData === 'string') {
    try {
      JSON.parse(responseData);
      json = responseData;
    } catch {
      // 字符串 mock 是 JSONP 回调的值，序列化后可避免生成无效 JavaScript。
    }
  }
  return { body: `${callback}(${json});`, isJsonp: true };
}

export function prepareMockResponseHeaders(
  headers: MockResponseHeader[] | undefined,
  isJsonp: boolean,
): MockResponseHeader[] {
  const stripped = (headers ?? []).filter(
    header => !['content-encoding', 'content-length'].includes(header.name.toLowerCase()),
  );
  if (!isJsonp) return stripped;

  const index = stripped.findIndex(header => header.name.toLowerCase() === 'content-type');
  if (index === -1) {
    return [...stripped, { name: 'content-type', value: JSONP_CONTENT_TYPE }];
  }

  const result = [...stripped];
  result[index] = { ...result[index], value: JSONP_CONTENT_TYPE };
  return result;
}
