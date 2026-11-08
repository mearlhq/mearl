/**
 * 深度子集匹配：subset 中的每个字段必须在 superset 中存在且值匹配
 * 用于 override conditions 与请求数据的匹配判断
 */
export function isSubset(subset: any, superset: any): boolean {
  if (subset === superset) return true;
  if (subset == null || superset == null) return subset === superset;
  if (typeof subset !== 'object' || typeof superset !== 'object') {
    return String(subset) === String(superset);
  }
  if (Array.isArray(subset)) {
    return Array.isArray(superset) && JSON.stringify(subset) === JSON.stringify(superset);
  }
  return Object.entries(subset).every(([key, value]) => {
    if (!(key in superset)) return false;
    return isSubset(value, superset[key]);
  });
}
