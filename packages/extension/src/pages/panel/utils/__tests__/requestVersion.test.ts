import { describe, expect, it } from 'vitest';
import { resolveRequestVersion } from '../requestVersion';

const createRequest = (
  url: string,
  options: { proxyRequestUrl?: string | null; versionQuery?: string } = {},
) => ({
  url,
  proxyRequestUrl: options.proxyRequestUrl ?? null,
  queryString: options.versionQuery ? [{ name: 'v', value: options.versionQuery }] : [],
});

describe('resolveRequestVersion', () => {
  it.each([
    ['版本后有斜杠', 'https://h5api.m.shop.com/h5/mtop.test.api/2.0/', '2.0'],
    [
      '版本后直接跟查询参数',
      'https://h5api.wapa.shop.com/h5/mtop.test.api/2.0?type=originaljson',
      '2.0',
    ],
    ['版本位于 URL 末尾', 'https://h5api.m.shop.com/h5/mtop.test.api/3.1', '3.1'],
  ])('应从%s的 URL 中提取版本', (_caseName, url, expected) => {
    expect(resolveRequestVersion(createRequest(url))).toBe(expected);
  });

  it('应优先从代理请求 URL 中提取版本', () => {
    const request = createRequest('https://proxy.example.com/request', {
      proxyRequestUrl: 'https://h5api.m.shop.com/h5/mtop.test.api/2.0?type=originaljson',
    });

    expect(resolveRequestVersion(request)).toBe('2.0');
  });

  it('应优先使用请求参数中的版本', () => {
    const request = createRequest('https://h5api.m.shop.com/h5/mtop.test.api/2.0/', {
      versionQuery: '3.0',
    });

    expect(resolveRequestVersion(request)).toBe('3.0');
  });

  it('无法提取版本时应回退到 1.0', () => {
    expect(resolveRequestVersion(createRequest('https://example.com/request'))).toBe('1.0');
  });
});
