import { describe, it, expect } from 'vitest';
import {
  getHeaderValue,
  formatJson,
  parseJsonpResponse,
  parseSseResponse,
  preprocessData,
  getValueByPath,
  tryParseJsonString,
  parseCookies,
  formatBytes,
  calculateHeadersSize,
  parseContentLength,
  getContentEncoding,
  isJsonpRequest,
  isJsonpResponse,
  normalizeNonProtocolResourceType,
  decodeQueryString,
  safeDecodeURIComponent,
  formatTimestamp,
} from '../utils/helpers';
import { deepDecodeURIComponent } from '../../../shared/dataPreprocessor';

describe('helpers.ts - 工具函数测试', () => {
  describe('getHeaderValue', () => {
    it('应该正确获取 header 值（不区分大小写）', () => {
      const headers = [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Accept', value: 'text/html' },
      ];

      expect(getHeaderValue(headers, 'content-type')).toBe('application/json');
      expect(getHeaderValue(headers, 'CONTENT-TYPE')).toBe('application/json');
      expect(getHeaderValue(headers, 'accept')).toBe('text/html');
    });

    it('未找到时应该返回空字符串', () => {
      const headers = [{ name: 'Content-Type', value: 'application/json' }];
      expect(getHeaderValue(headers, 'Authorization')).toBe('');
    });
  });

  describe('formatJson', () => {
    it('应该正确格式化 JSON 对象', () => {
      const obj = { name: 'test', value: 123 };
      const result = formatJson(obj);
      expect(result).toContain('"name": "test"');
      expect(result).toContain('"value": 123');
    });

    it('遇到错误时应该返回字符串形式', () => {
      const circular: any = {};
      circular.self = circular;
      const result = formatJson(circular);
      expect(typeof result).toBe('string');
    });
  });

  describe('parseJsonpResponse', () => {
    it('应该正确解析 JSONP 响应', () => {
      const jsonp = 'mtopjsonp3({"success":true,"data":"test"})';
      const result = parseJsonpResponse(jsonp);
      expect(result).toEqual({ success: true, data: 'test' });
    });

    it('应该处理带数组的 JSONP', () => {
      const jsonp = 'callback([1,2,3])';
      const result = parseJsonpResponse(jsonp);
      expect(result).toEqual([1, 2, 3]);
    });

    it('应该解析带注释前缀的 JSONP', () => {
      const jsonp = '/**/ jsonp17({"success":true,"data":"test"})';
      const result = parseJsonpResponse(jsonp);
      expect(result).toEqual({ success: true, data: 'test' });
    });

    it('应该解析带 typeof 检查的 JSONP', () => {
      const jsonp =
        '/**/ typeof jsonp4933 === \'function\' && jsonp4933({"success":false,"msgInfo":"无配置信息"})';
      const result = parseJsonpResponse(jsonp);
      expect(result).toEqual({ success: false, msgInfo: '无配置信息' });
    });

    it('应该解析带分号结尾的 JSONP', () => {
      const jsonp = 'callback({"success":true});';
      const result = parseJsonpResponse(jsonp);
      expect(result).toEqual({ success: true });
    });

    it('应该解析 try-catch 包装的 JSONP', () => {
      const jsonp =
        'try{jsonp248({"code":0,"data":"{\\"baseUserInfoDO\\":{\\"activated\\":true}}"})}catch(e){}';
      const result = parseJsonpResponse(jsonp);
      expect(result).toEqual({ code: 0, data: '{"baseUserInfoDO":{"activated":true}}' });
    });

    it('应该解析变量赋值 + 函数调用的 JSONP', () => {
      const jsonp =
        'var userCookie={"nickname":"test123","version":"2"};Client && Client.Global && Client.Global.run && Client.Global.run();';
      const result = parseJsonpResponse(jsonp);
      expect(result).toEqual({ nickname: 'test123', version: '2' });
    });

    it('非 JSONP 格式应该尝试直接解析', () => {
      const json = '{"normal":"json"}';
      const result = parseJsonpResponse(json);
      expect(result).toEqual({ normal: 'json' });
    });

    it('无效格式应该返回原值', () => {
      const invalid = 'not a json';
      const result = parseJsonpResponse(invalid);
      expect(result).toBe(invalid);
    });
  });

  describe('parseSseResponse', () => {
    it('应该正确解析单条 SSE 数据', () => {
      const sse = `id: 1
event: resp
data: {"key":"value"}

`;
      const result = parseSseResponse(sse);
      expect(result).toEqual({
        event: 'resp',
        data: { key: 'value' },
        eventId: '1',
      });
    });

    it('应该正确解析多条 SSE 数据', () => {
      const sse = `data: {"id":1}

data: {"id":2}

`;
      const result = parseSseResponse(sse);
      expect(result).toEqual([
        { event: 'message', data: { id: 1 }, eventId: undefined },
        { event: 'message', data: { id: 2 }, eventId: undefined },
      ]);
    });

    it('没有 data 行时应该返回原始内容', () => {
      const content = 'no data here';
      const result = parseSseResponse(content);
      expect(result).toBe(content);
    });
  });

  describe('preprocessData', () => {
    it('应该处理 key=value 格式', () => {
      const data = 'data={"test":true}';
      const result = preprocessData(data);
      expect(result).toEqual({ data: { test: true } });
    });

    it('应该处理 URL 编码的数据', () => {
      const encoded = 'data=%7B%22test%22%3Atrue%7D';
      const result = preprocessData(encoded);
      expect(result).toEqual({ data: { test: true } });
    });

    it('应该尝试解析纯 JSON 字符串', () => {
      const json = '{"direct":"json"}';
      const result = preprocessData(json);
      expect(result).toEqual({ direct: 'json' });
    });

    it('非字符串应该原样返回', () => {
      const obj = { already: 'object' };
      const result = preprocessData(obj);
      expect(result).toBe(obj);
    });

    it('应该处理 value 内部含 & 的 key=<JSON> 形式（PROTOCOL 风格 body，HTML 实体 / URL 等）', () => {
      const data = 'data={"foo":"a&nbsp;b","url":"http://x?a=1&b=2"}';
      const result = preprocessData(data);
      expect(result).toEqual({ data: { foo: 'a&nbsp;b', url: 'http://x?a=1&b=2' } });
    });

    it('多 key 的纯 query string 仍按字符串保留', () => {
      const data = 'buyParam=1&bizType=flight';
      const result = preprocessData(data);
      expect(result).toBe(data);
    });
  });

  describe('getValueByPath', () => {
    const testObj = {
      user: {
        name: 'John',
        address: {
          city: 'New York',
        },
      },
      items: ['a', 'b', 'c'],
    };

    it('应该正确获取嵌套对象的值', () => {
      expect(getValueByPath(testObj, 'user.name')).toBe('John');
      expect(getValueByPath(testObj, 'user.address.city')).toBe('New York');
    });

    it('应该正确获取数组对象', () => {
      expect(getValueByPath(testObj, 'items')).toEqual(['a', 'b', 'c']);
    });

    it('路径不存在时应该返回 undefined', () => {
      expect(getValueByPath(testObj, 'user.age')).toBeUndefined();
      expect(getValueByPath(testObj, 'items[10]')).toBeUndefined();
    });
  });

  describe('tryParseJsonString', () => {
    it('应该解析有效的 JSON 字符串', () => {
      const str = '{"valid":"json"}';
      const result = tryParseJsonString(str);
      expect(result.parsed).toEqual({ valid: 'json' });
      expect(result.format).toBeDefined();
      expect(result.format?.id).toBe('json');
    });

    it('应该处理嵌套对象的JSON字符串', () => {
      const nested = '{"inner":"value"}';
      const result = tryParseJsonString(nested);
      expect(result.parsed).toEqual({ inner: 'value' });
      expect(result.format).toBeDefined();
    });

    it('非 JSON 字符串应该保持原样', () => {
      const result1 = tryParseJsonString('plain text');
      expect(result1.parsed).toBe('plain text');
      expect(result1.format).toBeUndefined();

      const result2 = tryParseJsonString(123);
      expect(result2.parsed).toBe(123);
      expect(result2.format).toBeUndefined();
    });

    it('应该解析 FPT 格式字符串', () => {
      const fpt = 'soid(C12h952)ftuid(pvO8J6su024811.7)';
      const result = tryParseJsonString(fpt);
      expect(result.parsed).toEqual({ soid: 'C12h952', ftuid: 'pvO8J6su024811.7' });
      expect(result.format).toBeDefined();
      expect(result.format?.id).toBe('fpt');
    });

    it('单个 key(value) 不应该被识别为 FPT 格式', () => {
      const fpt = 'uid(12345)';
      const result = tryParseJsonString(fpt);
      expect(result.format?.id).not.toBe('fpt');
    });

    it('应该解析 Query String 格式', () => {
      const qs = 'foo=bar&baz=qux';
      const result = tryParseJsonString(qs);
      expect(result.parsed).toEqual({ foo: 'bar', baz: 'qux' });
      expect(result.format).toBeDefined();
      expect(result.format?.id).toBe('queryString');
    });

    it('应该解析带前缀的 JSON 字符串', () => {
      const prefixed = 'prefix{"key":"value"}';
      const result = tryParseJsonString(prefixed);
      expect(result.parsed).toEqual({ key: 'value' });
      expect(result.format).toBeDefined();
      expect(result.format?.id).toBe('prefixedJson');
      expect(result.prefix).toBe('prefix');
    });

    it('应该解析 URL 编码的 JSON', () => {
      const encoded = '%7B%22key%22%3A%22value%22%7D';
      const result = tryParseJsonString(encoded);
      expect(result.parsed).toEqual({ key: 'value' });
      expect(result.format).toBeDefined();
      expect(result.format?.id).toBe('encodedJson');
    });

    it('encodedJson 序列化应该保持 URL 编码格式', () => {
      const encoded = '%7B%22key%22%3A%22value%22%7D';
      const result = tryParseJsonString(encoded);
      expect(result.format?.serialize(result.parsed)).toBe(encoded);
    });

    it('queryString 序列化应该保持原格式', () => {
      const qs = 'foo=bar&baz=qux';
      const result = tryParseJsonString(qs);
      expect(result.format?.serialize(result.parsed)).toBe(qs);
    });

    it('fpt 序列化应该保持原格式', () => {
      const fpt = 'soid(C12h952)ftuid(pvO8J6su024811.7)';
      const result = tryParseJsonString(fpt);
      expect(result.format?.serialize(result.parsed)).toBe(fpt);
    });

    it('url 序列化应该重建原 URL', () => {
      const url = 'https://example.com/path?foo=bar&baz=qux';
      const result = tryParseJsonString(url);
      expect(result.format?.serialize(result.parsed)).toBe(url);
    });

    it('prefixedJson 序列化应该返回 JSON 部分', () => {
      const prefixed = 'prefix{"key":"value"}';
      const result = tryParseJsonString(prefixed);
      // prefixedJson.serialize 只返回 JSON 部分，前缀由 serializeWithFormat 处理
      expect(result.format?.serialize(result.parsed)).toBe('{"key":"value"}');
    });

    it('应该解析带 query 的 URL', () => {
      const url = 'https://example.com/path?foo=bar&baz=qux';
      const result = tryParseJsonString(url);
      expect(result.parsed).toEqual({
        protocol: 'https:',
        host: 'example.com',
        pathname: '/path',
        query: 'foo=bar&baz=qux',
      });
      expect(result.format).toBeDefined();
      expect(result.format?.id).toBe('url');
    });

    it('应解析带路径的 URL（不需要 query/hash）', () => {
      const url = 'https://example.com/path';
      const result = tryParseJsonString(url);
      expect(result.parsed).toEqual({
        protocol: 'https:',
        host: 'example.com',
        pathname: '/path',
      });
      expect(result.format?.id).toBe('url');
    });

    it('应解析只有域名的 URL', () => {
      const url = 'https://example.com';
      const result = tryParseJsonString(url);
      expect(result.parsed).toEqual({
        protocol: 'https:',
        host: 'example.com',
        pathname: '/',
      });
      expect(result.format?.id).toBe('url');
    });
  });

  describe('parseCookies', () => {
    it('应该正确解析 cookie 字符串', () => {
      const cookieStr = 'name=value; path=/; domain=.example.com';
      const result = parseCookies(cookieStr);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ name: 'name', value: 'value' });
      expect(result[1]).toEqual({ name: 'path', value: '/' });
      expect(result[2]).toEqual({ name: 'domain', value: '.example.com' });
    });

    it('应该处理 URL 编码的 cookie 值', () => {
      const cookieStr = 'token=abc%3D123';
      const result = parseCookies(cookieStr);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ name: 'token', value: 'abc%3D123' });
    });

    it('空字符串应该返回空数组', () => {
      expect(parseCookies('')).toEqual([]);
    });
  });

  describe('formatBytes', () => {
    it('应该正确格式化字节大小', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(1024)).toBe('1 KB');
      expect(formatBytes(1024 * 1024)).toBe('1 MB');
      // 1500 / 1024 = 1.46484375
      expect(formatBytes(1500)).toBe('1.46 KB');
    });

    it('应该处理大数值', () => {
      expect(formatBytes(1536)).toContain('KB');
      expect(formatBytes(1024 * 1024 * 5)).toContain('MB');
    });
  });

  describe('calculateHeadersSize', () => {
    it('应该正确计算 headers 大小', () => {
      const headers = [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Accept', value: 'text/html' },
      ];
      const size = calculateHeadersSize(headers);
      expect(size).toBeGreaterThan(0);
      expect(typeof size).toBe('number');
    });

    it('空数组应该返回 0', () => {
      expect(calculateHeadersSize([])).toBe(0);
    });
  });

  describe('parseContentLength', () => {
    it('应该正确解析 Content-Length', () => {
      const headers = [{ name: 'Content-Length', value: '1234' }];

      expect(parseContentLength(headers)).toBe(1234);
    });

    it('无效值应该返回 undefined', () => {
      const headers = [{ name: 'Content-Length', value: 'unknown' }];

      expect(parseContentLength(headers)).toBeUndefined();
    });
  });

  describe('getContentEncoding', () => {
    it('应该识别 gzip 编码', () => {
      const headers = [{ name: 'Content-Encoding', value: 'gzip' }];

      expect(getContentEncoding(headers)).toBe('gzip');
    });

    it('应该支持 zstd 编码', () => {
      const headers = [{ name: 'Content-Encoding', value: 'zstd' }];

      expect(getContentEncoding(headers)).toBe('zstd');
    });

    it('应该忽略 identity 编码', () => {
      const headers = [{ name: 'Content-Encoding', value: 'identity' }];

      expect(getContentEncoding(headers)).toBeUndefined();
    });
  });

  describe('isJsonpRequest', () => {
    it('应该识别带 callback 参数的 URL', () => {
      expect(isJsonpRequest('https://example.com/api?callback=jsonp123')).toBe(true);
      expect(isJsonpRequest('https://example.com/api?callback=jsonp123&other=param')).toBe(true);
    });

    it('应该识别带 jsonp 参数的 URL', () => {
      expect(isJsonpRequest('https://example.com/api?jsonp=callback123')).toBe(true);
    });

    it('没有 callback/jsonp 参数应该返回 false', () => {
      expect(isJsonpRequest('https://example.com/api?data=test')).toBe(false);
      expect(isJsonpRequest('https://example.com/api')).toBe(false);
    });

    it('无效 URL 应该返回 false', () => {
      expect(isJsonpRequest('not a valid url')).toBe(false);
    });
  });

  describe('isJsonpResponse', () => {
    it('应该识别 JSONP 格式响应', () => {
      expect(isJsonpResponse('jsonp123({"success":true})')).toBe(true);
      expect(isJsonpResponse('callback([1,2,3])')).toBe(true);
      expect(isJsonpResponse('myFunc({"data":"value"})')).toBe(true);
    });

    it('带空格的 JSONP 格式也应该识别', () => {
      expect(isJsonpResponse('jsonp123( {"success":true} )')).toBe(true);
      expect(isJsonpResponse('callback( [1,2,3] )')).toBe(true);
    });

    it('应该识别带注释前缀的 JSONP 格式', () => {
      expect(isJsonpResponse('/**/ jsonp17({"success":true})')).toBe(true);
      expect(isJsonpResponse('/**/callback([1,2,3])')).toBe(true);
    });

    it('应该识别带 typeof 检查的 JSONP 格式', () => {
      expect(
        isJsonpResponse('/**/ typeof jsonp4933 === \'function\' && jsonp4933({"success":false})'),
      ).toBe(true);
      expect(isJsonpResponse('typeof callback === "function" && callback({"data":"value"})')).toBe(
        true,
      );
    });

    it('应该识别带分号结尾的 JSONP 格式', () => {
      expect(isJsonpResponse('jsonp123({"success":true});')).toBe(true);
      expect(isJsonpResponse('/**/ jsonp17({"success":true});')).toBe(true);
    });

    it('应该识别 try-catch 包装的 JSONP 格式', () => {
      expect(isJsonpResponse('try{jsonp248({"code":0,"data":"test"})}catch(e){}')).toBe(true);
      expect(isJsonpResponse('try{jsonp123([1,2,3])}catch(e){};')).toBe(true);
    });

    it('应该识别变量赋值 + 函数调用的 JSONP 格式', () => {
      expect(isJsonpResponse('var userCookie={"nickname":"test"};Client.Global.run();')).toBe(true);
      expect(isJsonpResponse('var data={"success":true};callback();')).toBe(true);
    });

    it('非 JSONP 格式应该返回 false', () => {
      expect(isJsonpResponse('{"normal":"json"}')).toBe(false);
      expect(isJsonpResponse('[1,2,3]')).toBe(false);
      expect(isJsonpResponse('plain text')).toBe(false);
    });

    it('非字符串应该返回 false', () => {
      expect(isJsonpResponse(null as any)).toBe(false);
      expect(isJsonpResponse(undefined as any)).toBe(false);
      expect(isJsonpResponse(123 as any)).toBe(false);
    });
  });

  describe('normalizeNonProtocolResourceType', () => {
    it('应该将带 callback 的 script 请求识别为 jsonp', () => {
      const result = normalizeNonProtocolResourceType(
        'script',
        'https://example.com/api?callback=jsonp123',
        undefined,
      );
      expect(result).toBe('jsonp');
    });

    it('不带 callback 的 script 请求应该保持原样', () => {
      const result = normalizeNonProtocolResourceType(
        'script',
        'https://example.com/static.js',
        undefined,
      );
      expect(result).toBe('script');
    });

    it('script 类型且 content-type 为 javascript，URL 不像 JS 文件时应识别为 jsonp', () => {
      const headers = [{ name: 'Content-Type', value: 'application/javascript' }];
      const result = normalizeNonProtocolResourceType(
        'script',
        'https://example.com/api/mtop.example.xxx',
        headers,
      );
      expect(result).toBe('jsonp');
    });

    it('script 类型且 content-type 为 javascript，URL 是 JS 文件时保持 script', () => {
      const headers = [{ name: 'Content-Type', value: 'application/javascript' }];
      const result = normalizeNonProtocolResourceType(
        'script',
        'https://example.com/static/app.js',
        headers,
      );
      expect(result).toBe('script');
    });

    it('xhr 请求应该根据 content-type 推断', () => {
      const headers = [{ name: 'Content-Type', value: 'text/css' }];
      const result = normalizeNonProtocolResourceType('xhr', 'https://example.com/api', headers);
      expect(result).toBe('stylesheet');
    });

    it('xhr 请求 content-type 为 javascript 且带 callback 时应识别为 jsonp', () => {
      const headers = [{ name: 'Content-Type', value: 'application/javascript' }];
      const result = normalizeNonProtocolResourceType(
        'xhr',
        'https://example.com/api?callback=jsonp123',
        headers,
      );
      expect(result).toBe('jsonp');
    });

    it('xhr 请求 content-type 为 javascript 且 URL 不像 JS 文件时应识别为 jsonp', () => {
      const headers = [{ name: 'Content-Type', value: 'application/javascript' }];
      const result = normalizeNonProtocolResourceType(
        'xhr',
        'https://example.com/api/mtop.example.xxx',
        headers,
      );
      expect(result).toBe('jsonp');
    });

    it('xhr 请求 content-type 为 javascript 但 URL 是 JS 文件时应识别为 script', () => {
      const headers = [{ name: 'Content-Type', value: 'application/javascript' }];
      const result = normalizeNonProtocolResourceType(
        'xhr',
        'https://example.com/static/app.js',
        headers,
      );
      expect(result).toBe('script');
    });

    it('fetch 请求应该根据 URL 推断', () => {
      const result = normalizeNonProtocolResourceType(
        'fetch',
        'https://example.com/image.png',
        undefined,
      );
      expect(result).toBe('image');
    });

    it('其他类型应该直接返回', () => {
      expect(normalizeNonProtocolResourceType('image', 'https://example.com/img.png', undefined)).toBe(
        'image',
      );
      expect(
        normalizeNonProtocolResourceType('stylesheet', 'https://example.com/style.css', undefined),
      ).toBe('stylesheet');
    });

    it('script 类型且 URL 为 .tsx 源码（dev server）时不应识别为 jsonp', () => {
      const headers = [{ name: 'Content-Type', value: 'application/javascript' }];
      const result = normalizeNonProtocolResourceType(
        'script',
        'http://localhost:3000/src/components/DiscountTag/Activity/index.tsx',
        headers,
      );
      expect(result).toBe('script');
    });

    it('script 类型且 URL 为 .ts/.jsx/.vue/.svelte/.cjs 源码时不应识别为 jsonp', () => {
      const headers = [{ name: 'Content-Type', value: 'application/javascript' }];
      const cases = [
        'http://localhost:3000/src/utils/index.ts',
        'http://localhost:3000/src/App.jsx',
        'http://localhost:3000/src/components/Header.vue',
        'http://localhost:3000/src/lib/Store.svelte',
        'http://localhost:3000/build/util.cjs',
      ];
      for (const url of cases) {
        expect(normalizeNonProtocolResourceType('script', url, headers)).toBe('script');
      }
    });

    it('xhr 类型且 URL 为 .tsx 源码时不应识别为 jsonp（dev server 经 fetch import）', () => {
      const headers = [{ name: 'Content-Type', value: 'application/javascript' }];
      const result = normalizeNonProtocolResourceType(
        'xhr',
        'http://localhost:3000/src/main.tsx?t=1700000000000',
        headers,
      );
      // .tsx 不再被当成 JSONP，content-type 推断为 script 也因 URL 是源码文件而保持 script
      expect(result).not.toBe('jsonp');
    });

    it('script 类型且 URL 为 dev server 虚拟路径（@vite/client、@react-refresh、@id/、@fs/）时不应识别为 jsonp', () => {
      const headers = [{ name: 'Content-Type', value: 'application/javascript' }];
      const cases = [
        'http://localhost:3000/@vite/client',
        'http://localhost:3000/@react-refresh',
        'http://localhost:3000/@id/__x00__virtual:module',
        'http://localhost:3000/@fs/Users/me/project/node_modules/foo/dist/index.js',
        'http://localhost:3000/node_modules/.vite/deps/react.js?v=abc',
      ];
      for (const url of cases) {
        expect(normalizeNonProtocolResourceType('script', url, headers)).toBe('script');
      }
    });

    it('script 类型且 URL 同时带 callback 参数时仍应识别为 jsonp（callback 是强信号，不被 dev server 路径覆盖）', () => {
      const headers = [{ name: 'Content-Type', value: 'application/javascript' }];
      const result = normalizeNonProtocolResourceType(
        'script',
        'http://localhost:3000/src/api?callback=jsonp1',
        headers,
      );
      expect(result).toBe('jsonp');
    });
  });

  describe('safeDecodeURIComponent', () => {
    it('应该正确解码 URL 编码的字符串', () => {
      expect(safeDecodeURIComponent('%E5%8C%97%E4%BA%AC')).toBe('北京');
      expect(safeDecodeURIComponent('%E6%9B%BC%E8%B0%B7')).toBe('曼谷');
      expect(safeDecodeURIComponent('hello%20world')).toBe('hello world');
    });

    it('没有编码的字符串应该原样返回', () => {
      expect(safeDecodeURIComponent('plain text')).toBe('plain text');
      expect(safeDecodeURIComponent('123')).toBe('123');
    });

    it('无效的编码应该返回原值', () => {
      expect(safeDecodeURIComponent('%invalid')).toBe('%invalid');
      expect(safeDecodeURIComponent('%E0%A4%A')).toBe('%E0%A4%A');
    });
  });

  describe('decodeQueryString', () => {
    it('应该解码 queryString 数组中的值', () => {
      const queryString = [
        { name: 'city', value: '%E5%8C%97%E4%BA%AC' },
        { name: 'name', value: 'hello%20world' },
      ];
      const result = decodeQueryString(queryString);
      expect(result).toEqual([
        { name: 'city', value: '北京' },
        { name: 'name', value: 'hello world' },
      ]);
    });

    it('未编码的值应该保持不变', () => {
      const queryString = [
        { name: 'code', value: 'BJS' },
        { name: 'date', value: '2026-03-24' },
      ];
      const result = decodeQueryString(queryString);
      expect(result).toEqual(queryString);
    });

    it('空数组应该返回空数组', () => {
      expect(decodeQueryString([])).toEqual([]);
    });
  });

  describe('formatTimestamp', () => {
    it('应该格式化完整时间戳', () => {
      const ms = 1679529600000; // 2023-03-23 08:00:00 UTC
      const result = formatTimestamp(ms, 'full');
      expect(result).toContain('/');
      expect(result).toContain(':');
    });

    it('应该格式化短时间戳', () => {
      const ms = 1679529600000; // 2023-03-23 08:00:00 UTC
      const result = formatTimestamp(ms, 'short');
      expect(result).not.toContain('/');
      expect(result).toContain(':');
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });

    it('默认应该使用完整格式', () => {
      const ms = 1679529600000;
      const result = formatTimestamp(ms);
      expect(result).toContain('/');
    });
  });

  describe('deepDecodeURIComponent', () => {
    it('应该解码 URL 编码的字符串', () => {
      expect(deepDecodeURIComponent('%E5%8C%97%E4%BA%AC')).toBe('北京');
      expect(deepDecodeURIComponent('hello%20world')).toBe('hello world');
    });

    it('应该递归解码对象中的编码值', () => {
      const input = {
        nickname: '%5Cu793A%5Cu4F8B',
        encodedToken: 'Ug%3D%3D',
        plain: 'plain text',
      };
      const result = deepDecodeURIComponent(input);
      expect(result.nickname).toBe('示例'); // %5C -> \, \u793A\u4F8B -> 示例
      expect(result.encodedToken).toBe('Ug=='); // %3D -> =
      expect(result.plain).toBe('plain text');
    });

    it('应该处理嵌套的 JSON 字符串', () => {
      const input = {
        data: '%7B%22nested%22%3A%22value%22%7D',
      };
      const result = deepDecodeURIComponent(input);
      expect(result.data).toEqual({ nested: 'value' });
    });

    it('应该处理数组', () => {
      const input = ['%E5%8C%97%E4%BA%AC', '%E4%B8%8A%E6%B5%B7'];
      const result = deepDecodeURIComponent(input);
      expect(result).toEqual(['北京', '上海']);
    });

    it('应该解析带编码的 JSONP 响应', () => {
      const jsonp = 'var userCookie={"nickname":"%5Cu793A%5Cu4F8B","version":"2"};Client.Global.run();';
      const result = parseJsonpResponse(jsonp);
      expect(result.nickname).toBe('示例');
      expect(result.version).toBe('2');
    });

    it('应该解码 Unicode 转义序列', () => {
      const input = {
        nickname: '\\u793A\\u4F8B\\u6D4B\\u8BD52',
        account_name: '\\u793A\\u4F8B\\u6D4B\\u8BD52',
        plain: 'plain text',
      };
      const result = deepDecodeURIComponent(input);
      expect(result.nickname).toBe('示例测试2');
      expect(result.account_name).toBe('示例测试2');
      expect(result.plain).toBe('plain text');
    });

    it('应该同时处理 URL 编码和 Unicode 转义', () => {
      const input = {
        nickname: '%5Cu793A%5Cu4F8B', // URL 编码的 Unicode 转义
      };
      const result = deepDecodeURIComponent(input);
      expect(result.nickname).toBe('示例');
    });
  });
});
