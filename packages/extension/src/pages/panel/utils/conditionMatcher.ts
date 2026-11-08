import { ResponseOverride } from '../../../shared/types';
import { isSubset } from '../../../shared/isSubset';
import { splitMockConditions } from '../../../shared/mockConditions';

/**
 * 检查请求数据是否满足 override 的生效条件（panel 侧使用）
 * postData: 已解析的请求体对象，或原始字符串（form-encoded / JSON）
 * queryString: HAR 格式的 query 参数数组
 */
export function matchesOverrideConditions(
  override: ResponseOverride,
  postData: any,
  queryString?: Array<{ name: string; value: string }>,
): boolean {
  const { requestConditions } = splitMockConditions(override.conditions);
  if (!requestConditions) return true;

  const requestData: Record<string, any> = {};

  if (queryString) {
    for (const { name, value } of queryString) {
      try {
        requestData[name] = JSON.parse(value);
      } catch {
        requestData[name] = value;
      }
    }
  }

  if (postData && typeof postData === 'object') {
    Object.assign(requestData, postData);
  } else if (typeof postData === 'string' && postData) {
    try {
      const json = JSON.parse(postData);
      if (typeof json === 'object' && json !== null) {
        Object.assign(requestData, json);
      }
    } catch {
      try {
        const decoded = new URLSearchParams(postData);
        decoded.forEach((value, key) => {
          try {
            requestData[key] = JSON.parse(value);
          } catch {
            requestData[key] = value;
          }
        });
      } catch {
        /* ignore */
      }
    }
  }

  if (isSubset(requestConditions, requestData)) return true;
  // 兼容简写：条件直接写 data 内层字段时，也尝试匹配 requestData.data
  if (requestData.data && typeof requestData.data === 'object') {
    return isSubset(requestConditions, requestData.data);
  }
  return false;
}

/**
 * 从 override 数组中找到第一个条件匹配的
 */
export function findMatchingOverride(
  overrides: ResponseOverride[] | undefined,
  postData: any,
  queryString?: Array<{ name: string; value: string }>,
): ResponseOverride | undefined {
  if (!overrides || overrides.length === 0) return undefined;
  return overrides.find(o => matchesOverrideConditions(o, postData, queryString));
}
