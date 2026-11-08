/**
 * URL query 快捷参数预设
 *
 * 针对客户端 WebView 的常用 query 开关（如沉浸式标题栏），提供一键添加/移除能力。
 * 预设由若干 key=value 参数组成，value 存明文（未编码），写回 query 时按需编码。
 */

export interface QueryPresetParam {
  key: string;
  /** 明文值（未编码），写回 query 时用 encodeURIComponent 处理 */
  value: string;
}

export interface UrlQueryPreset {
  id: string;
  /** 用户自定义名称；内置预设不带 label，由调用方按 id 用 t() 字面量解析文案 */
  label?: string;
  params: QueryPresetParam[];
}

/**
 * 内置默认预设，作为配置的初始种子写入 storage 后即可被用户编辑/删除。
 * 不带 label 的项由调用方按 id 用 t() 字面量解析文案，保持 t() key 为字符串字面量的约定。
 */
export const DEFAULT_QUERY_PRESETS: UrlQueryPreset[] = [];

/**
 * 将用户尚未见过的内置预设合并进其已存储的预设列表。
 *
 * 预设持久化到 storage 后，新增的内置项默认不会出现在老用户列表里；
 * 用 seenIds 记录"已呈现过的内置 id"，仅补入既未存在、也从未呈现过的内置项，
 * 从而既能让新内置项自动出现，又不会让用户已删除的内置项复活。
 */
export const mergeMissingBuiltinPresets = (
  presets: UrlQueryPreset[],
  seenIds: string[],
  defaults: UrlQueryPreset[] = DEFAULT_QUERY_PRESETS,
): { presets: UrlQueryPreset[]; seenIds: string[]; changed: boolean } => {
  const seen = new Set(seenIds);
  const existing = new Set(presets.map(p => p.id));
  const toAdd = defaults.filter(p => !seen.has(p.id) && !existing.has(p.id));
  const nextSeen = Array.from(new Set([...seenIds, ...defaults.map(p => p.id)]));
  const changed = toAdd.length > 0 || nextSeen.length !== seen.size;
  return {
    presets: toAdd.length > 0 ? [...presets, ...toAdd] : presets,
    seenIds: nextSeen,
    changed,
  };
};

/**
 * 解析用户输入的 query 片段为参数列表。
 * 接受可选的前导 ? 或 &，按 & 分段，每段以首个 = 拆 key/value，value 解码为明文。
 */
export const parseParamsInput = (input: string): QueryPresetParam[] => {
  const trimmed = input.trim().replace(/^[?&]+/, '');
  if (!trimmed) return [];
  const params: QueryPresetParam[] = [];
  for (const seg of trimmed.split('&')) {
    if (!seg) continue;
    const i = seg.indexOf('=');
    const key = (i === -1 ? seg : seg.slice(0, i)).trim();
    if (!key) continue;
    const rawValue = i === -1 ? '' : seg.slice(i + 1);
    let value: string;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      value = rawValue;
    }
    params.push({ key, value });
  }
  return params;
};

const splitQuery = (query: string): string[] =>
  query ? query.split('&').filter(seg => seg.length > 0) : [];

const segKey = (seg: string): string => {
  const i = seg.indexOf('=');
  return i === -1 ? seg : seg.slice(0, i);
};

const segDecodedValue = (seg: string): string => {
  const i = seg.indexOf('=');
  if (i === -1) return '';
  const raw = seg.slice(i + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/**
 * 预设是否处于激活态：任一预设参数（key 与明文 value 均匹配）在 query 中存在即视为激活。
 * 多个参数只要命中一个就算激活，便于识别只写了部分开关的历史链接。
 */
export const isPresetActive = (query: string, preset: UrlQueryPreset): boolean => {
  const segs = splitQuery(query);
  return preset.params.some(p =>
    segs.some(seg => segKey(seg) === p.key && segDecodedValue(seg) === p.value),
  );
};

/**
 * 移除预设涉及的所有 key（不论其值），返回新的 query 字符串。
 * 其余参数保持原始顺序与编码不变。
 */
export const removePresetParams = (query: string, preset: UrlQueryPreset): string => {
  const keys = new Set(preset.params.map(p => p.key));
  return splitQuery(query)
    .filter(seg => !keys.has(segKey(seg)))
    .join('&');
};

/**
 * 添加预设参数：已存在同 key 的段替换为预设值，其余追加到末尾。
 * value 用 encodeURIComponent 编码，保证含 = 等字符的值（如 fullscreen=YES）能被正确还原。
 */
export const addPresetParams = (query: string, preset: UrlQueryPreset): string => {
  const segs = splitQuery(query);
  for (const p of preset.params) {
    const seg = `${p.key}=${encodeURIComponent(p.value)}`;
    const idx = segs.findIndex(s => segKey(s) === p.key);
    if (idx === -1) segs.push(seg);
    else segs[idx] = seg;
  }
  return segs.join('&');
};

/** 切换预设：激活则移除全部相关 key，否则写入全部预设参数 */
export const togglePresetInQuery = (query: string, preset: UrlQueryPreset): string =>
  isPresetActive(query, preset)
    ? removePresetParams(query, preset)
    : addPresetParams(query, preset);
