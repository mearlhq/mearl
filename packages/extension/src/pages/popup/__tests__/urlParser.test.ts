import { describe, it, expect } from 'vitest';
import { parseUrl, rebuildUrl } from '../../panel/utils/helpers';
import { isUrl, deepParseJson } from '../utils';

describe('URL Parser', () => {
  describe('isUrl', () => {
    it('should detect valid URLs with query parameters', () => {
      expect(isUrl('https://example.com?foo=bar')).toBe(true);
      expect(isUrl('http://example.com?test=1')).toBe(true);
      expect(isUrl('https://edith.wapa.shop.com/clam/test?id=123')).toBe(true);
    });

    it('should detect valid URLs with hash parameters', () => {
      expect(isUrl('https://example.com#section')).toBe(true);
      expect(
        isUrl(
          'https://projects.example.test/v2/project/1114231/bug#viewIdentifier=1dedc5afd44979211cad516f',
        ),
      ).toBe(true);
      expect(isUrl('http://example.com/path#hash=value')).toBe(true);
    });

    it('should detect URLs without query or hash (simplified check)', () => {
      // isUrl 只检查协议头，不要求必须有 query 或 hash
      expect(isUrl('https://example.com')).toBe(true);
      expect(isUrl('http://example.com')).toBe(true);
      expect(isUrl('https://edith.wapa.shop.com/clam/test')).toBe(true);
    });

    it('should reject invalid URLs', () => {
      expect(isUrl('not a url')).toBe(false);
      expect(isUrl('example.com')).toBe(false);
      expect(isUrl('')).toBe(false);
      expect(isUrl('ftp://example.com')).toBe(false);
    });
  });

  describe('parseUrl', () => {
    it('should parse URL with query parameters', () => {
      const url = 'https://example.com/path?foo=bar&baz=qux';
      const result = parseUrl(url);

      expect(result).toEqual({
        protocol: 'https:',
        host: 'example.com',
        pathname: '/path',
        query: 'foo=bar&baz=qux',
      });
    });

    it('should parse URL with hash', () => {
      const url = 'https://example.com/path#section';
      const result = parseUrl(url);

      expect(result).toEqual({
        protocol: 'https:',
        host: 'example.com',
        pathname: '/path',
        hash: 'section',
      });
      // query 为空时不应该返回 query 字段
      expect(result).not.toHaveProperty('query');
    });

    it('should parse complex URL from real example', () => {
      const url =
        'https://edith.wapa.shop.com/clam/30.240.110.28-11000/src/pages/d-change-apply/index.html?fetchType=2&fpt=ftuid(pvPfXRFu889024.2)&orderId=9114320977955&pre_pageVersion=1.35.7&spm=181.7437879.0.0&spmUrl=181.8947523.cardlist.card&ttid=201200%40travel_iphone_9.10.43.104&deviceid=WILw5zKyvbaxRK88YdtOMt4edoL2uFLeyF3x8bl5d8lMGtswHJ4LOGZLOLez48mk&client_version=9.10.43.104&client_type=ios&frm=travel&_layer_router_spm=181.7437879.operationButtons.on%E6%88%91%E8%A6%81%E6%94%B9%E7%AD%BEClick_ose4&_layer_interceptor_start_time=1769482894340&_layer_from_cache=true&_projVer=webpack%7C1769482843392';
      const result = parseUrl(url);

      expect(result).toBeDefined();
      expect(result?.host).toBe('edith.wapa.shop.com');
      expect(result?.protocol).toBe('https:');
      expect(result?.pathname).toBe(
        '/clam/30.240.110.28-11000/src/pages/d-change-apply/index.html',
      );
      // query 保持原始字符串格式，交给 JsonTree 展示
      expect(typeof result?.query).toBe('string');
      expect(result?.query).toContain('fetchType=2');
      expect(result?.query).toContain('orderId=9114320977955');
      expect(result?.query).toContain('client_type=ios');
      expect(result?.query).toContain('_layer_from_cache=true');
      // 没有 hash，所以不应该有 hash 字段
      expect(result).not.toHaveProperty('hash');
    });

    it('should keep URL-encoded characters in query string', () => {
      const url =
        'https://example.com/search?q=%E4%B8%AD%E6%96%87&name=%E5%BC%A0%E4%B8%89&space=hello%20world';
      const result = parseUrl(url);

      // query 保持原始编码格式，交给 JsonTree 按需解码
      expect(typeof result?.query).toBe('string');
      expect(result?.query).toContain('q=%E4%B8%AD%E6%96%87');
      expect(result?.query).toContain('name=%E5%BC%A0%E4%B8%89');
      expect(result?.query).toContain('space=hello%20world');
    });

    it('should include port in host when present', () => {
      const url = 'http://localhost:3000/api?test=1';
      const result = parseUrl(url);

      expect(result).toEqual({
        protocol: 'http:',
        host: 'localhost:3000',
        pathname: '/api',
        query: 'test=1',
      });
    });

    it('should not include hash when not present', () => {
      const url = 'https://example.com/path';
      const result = parseUrl(url);

      expect(result).not.toHaveProperty('hash');
    });

    it('should parse SPA hash mode URL with query in hash (Google Analytics style)', () => {
      const url =
        'https://analytics.google.com/analytics/web/#/a379970588p519106719/reports/reportinghub?params=_u..nav%3Dmaui&collectionId=business-objectives';
      const result = parseUrl(url);

      expect(result).toEqual({
        protocol: 'https:',
        host: 'analytics.google.com',
        pathname: '/analytics/web/',
        hash: '/a379970588p519106719/reports/reportinghub',
        hashQuery: 'params=_u..nav%3Dmaui&collectionId=business-objectives',
      });
    });

    it('should parse hash with query but no standard query', () => {
      const url = 'https://example.com/#/user/profile?tab=settings&theme=dark';
      const result = parseUrl(url);

      expect(result).toEqual({
        protocol: 'https:',
        host: 'example.com',
        pathname: '/',
        hash: '/user/profile',
        hashQuery: 'tab=settings&theme=dark',
      });
      // 没有标准 query，不应该有 query 字段
      expect(result).not.toHaveProperty('query');
    });

    it('should parse URL with both standard query and hash query', () => {
      const url = 'https://example.com/app?env=prod#/dashboard?view=chart&period=week';
      const result = parseUrl(url);

      expect(result).toEqual({
        protocol: 'https:',
        host: 'example.com',
        pathname: '/app',
        query: 'env=prod',
        hash: '/dashboard',
        hashQuery: 'view=chart&period=week',
      });
    });

    it('should return null for invalid URL', () => {
      expect(parseUrl('not a url')).toBeNull();
      expect(parseUrl('')).toBeNull();
    });
  });

  describe('rebuildUrl', () => {
    it('should rebuild URL from parsed object with string query', () => {
      const parsed = {
        protocol: 'https:',
        host: 'example.com',
        pathname: '/path',
        query: 'foo=bar&baz=qux',
      };

      const result = rebuildUrl(parsed);
      expect(result).toBe('https://example.com/path?foo=bar&baz=qux');
    });

    it('should rebuild URL with hash', () => {
      const parsed = {
        protocol: 'https:',
        host: 'example.com',
        pathname: '/path',
        query: 'test=1',
        hash: 'section',
      };

      const result = rebuildUrl(parsed);
      expect(result).toBe('https://example.com/path?test=1#section');
    });

    it('should rebuild URL without query params', () => {
      const parsed = {
        protocol: 'https:',
        host: 'example.com',
        pathname: '/path',
      };

      const result = rebuildUrl(parsed);
      expect(result).toBe('https://example.com/path');
    });

    it('should rebuild URL with hashQuery', () => {
      const parsed = {
        protocol: 'https:',
        host: 'example.com',
        pathname: '/',
        hash: '/dashboard',
        hashQuery: 'view=chart&period=week',
      };

      const result = rebuildUrl(parsed);
      expect(result).toBe('https://example.com/#/dashboard?view=chart&period=week');
    });

    it('should rebuild URL with both query and hashQuery', () => {
      const parsed = {
        protocol: 'https:',
        host: 'example.com',
        pathname: '/app',
        query: 'env=prod',
        hash: '/settings',
        hashQuery: 'tab=general',
      };

      const result = rebuildUrl(parsed);
      expect(result).toBe('https://example.com/app?env=prod#/settings?tab=general');
    });
  });

  describe('deepParseJson with URL', () => {
    it('should parse string URL in JSON', () => {
      const input = JSON.stringify({
        pageUrl: 'https://example.com/path?foo=bar#section',
      });

      const result = deepParseJson(input);

      // 单个 query 参数不会被识别为 query string（需要有 &）
      expect(result).toEqual({
        pageUrl: {
          protocol: 'https:',
          host: 'example.com',
          pathname: '/path',
          query: 'foo=bar',
          hash: 'section',
        },
      });
    });

    it('should parse URL when pasted directly', () => {
      const url = 'https://example.com/path?foo=bar&baz=qux#section';
      const result = deepParseJson(url);

      // deepParseJson 会递归解析，query 会被展开为对象
      expect(result).toEqual({
        protocol: 'https:',
        host: 'example.com',
        pathname: '/path',
        query: { foo: 'bar', baz: 'qux' },
        hash: 'section',
      });
    });

    it('should not interfere with JSON parsing', () => {
      const input = JSON.stringify({ foo: 'bar', num: 123 });
      const result = deepParseJson(input);

      expect(result).toEqual({ foo: 'bar', num: 123 });
    });

    it('should not re-parse protocol/host fields in URL parsed structure', () => {
      // 模拟编辑后的 JSON（从 inputText 重新解析）
      const editedJson = JSON.stringify({
        protocol: 'https:',
        host: 'example.com',
        pathname: '/path',
        query: 'foo=modified&bar=new',
      });

      const result = deepParseJson(editedJson);

      // protocol 和 host 应该保持为字符串，不被解析成嵌套对象
      expect(result.protocol).toBe('https:');
      expect(result.host).toBe('example.com');
      // query 字符串会被 tryParseJsonString 识别为 query string 并展开（deepParseJson 的正常行为）
      expect(result.query).toEqual({ foo: 'modified', bar: 'new' });
    });
  });
});
