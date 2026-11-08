import { SSEMessage } from '../types';

/**
 * 把多条 SSE 消息聚合成一个「大对象」。
 *
 * 典型流式接口（如 mtop 的 AI chat）每帧只带一小段增量数据，
 * 真正有用的字段（如 message 正文）被拆散在几十帧里，逐条看很难还原全貌。
 * 本函数把「主事件」的所有帧按字段合并成一个对象：
 *   - 流式文本字段（message / content / thinking 等，见 CONCAT_TEXT_KEYS）→ 按帧拼接还原正文，
 *     并用 startsWith 自动区分「增量下发」与「全量快照下发」两种流式协议
 *   - 其它字符串 / 标量 → 取最后一帧的值
 *     （避免 faiEventType / status / showName 等枚举、状态字段被拼成乱码）
 *   - 对象 → 递归深合并
 *   - 数组 → 元素带稳定身份键（id/key 等）时按 id 累积（新 id 追加、同 id 深合并），
 *     否则取更「长」的一方（覆盖 [] → [{...}] 这类逐步填充）
 * 同时会自动 JSON.parse 嵌套的 JSON 字符串（如 data.result 的双层编码），
 * 并跳过心跳帧（heartBeat / keepAlive / ping）。
 *
 * 这是纯展示层派生，不改动原始捕获数据。
 */

const isPlainObject = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** 递归把「看起来像 JSON 的字符串」再解析一层，处理双层/多层 JSON 编码 */
export const deepParseJson = (value: any): any => {
  if (typeof value === 'string') {
    const s = value.trim();
    const looksLikeJson =
      s.length > 1 &&
      ((s[0] === '{' && s[s.length - 1] === '}') || (s[0] === '[' && s[s.length - 1] === ']'));
    if (looksLikeJson) {
      try {
        return deepParseJson(JSON.parse(s));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(deepParseJson);
  if (isPlainObject(value)) {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value)) out[k] = deepParseJson(value[k]);
    return out;
  }
  return value;
};

/** 递归判断是否为心跳/保活帧（携带 heartBeat / keepAlive / ping 且为真值） */
const looksLikeHeartbeat = (value: any): boolean => {
  if (Array.isArray(value)) return value.some(looksLikeHeartbeat);
  if (!isPlainObject(value)) return false;
  for (const k of Object.keys(value)) {
    if (/^(heart\s*beat|keep\s*alive|ping)$/i.test(k) && value[k]) return true;
    if (looksLikeHeartbeat(value[k])) return true;
  }
  return false;
};

/**
 * 流式文本字段白名单（key 名大小写不敏感）：只有这些 key 的字符串值才按帧拼接。
 * 其余字符串（如 faiEventType / status / showName 等枚举、状态字段）逐帧不同，
 * 拼接会得到乱码，故一律取最后一帧的值。
 */
const CONCAT_TEXT_KEYS = new Set([
  'message',
  'content',
  'text',
  'thinking',
  'delta',
  'reasoning_content',
  'reasoningcontent',
  'answer',
  'response',
  'chunk',
  'token',
  'output',
  'completion',
]);

const isConcatTextKey = (key?: string): boolean => !!key && CONCAT_TEXT_KEYS.has(key.toLowerCase());

/**
 * 数组元素的候选身份键（大小写不敏感）。元素若都是对象且共享其中某个键、
 * 且该键在两个数组内各自唯一，就用它把跨帧下发的元素按身份累积。
 */
const ARRAY_ID_KEYS = ['id', 'key', 'uuid', 'uid', 'messageId', 'msgId', 'itemId', 'componentId'];

/**
 * 为两个数组挑一个可用的身份键：要求两数组元素全为对象、都带该键、且键值在各自数组内唯一。
 * 找不到返回 undefined（退回「取更长」）。
 */
const pickArrayIdKey = (a: any[], b: any[]): string | undefined => {
  if (!a.length || !b.length) return undefined;
  for (const key of ARRAY_ID_KEYS) {
    const usableIn = (arr: any[]) => {
      if (!arr.every(el => isPlainObject(el) && el[key] !== undefined)) return false;
      const ids = arr.map(el => String(el[key]));
      return new Set(ids).size === ids.length;
    };
    if (usableIn(a) && usableIn(b)) return key;
  }
  return undefined;
};

/**
 * 按身份键累积两个数组：保持首次出现顺序，新身份追加、同身份深合并。
 * 支持「每帧 append 一个新元素」（长度不增长但内容各异）与「同一元素跨帧流式填充」两种协议。
 */
const mergeArraysById = (acc: any[], next: any[], idKey: string): any[] => {
  const byId = new Map<string, any>();
  const order: string[] = [];
  const put = (el: any) => {
    const id = String(el[idKey]);
    if (byId.has(id)) byId.set(id, mergeSseValue(byId.get(id), el));
    else {
      order.push(id);
      byId.set(id, el);
    }
  };
  acc.forEach(put);
  next.forEach(put);
  return order.map(id => byId.get(id));
};

/**
 * 合并两个值：
 * - 流式文本字段（见 CONCAT_TEXT_KEYS）：next 以 acc 为前缀视为「全量快照」直接覆盖，否则视为增量拼接
 * - 其它字符串 / 标量：取最后一帧的值
 * - 对象：按字段递归深合并
 * - 数组：元素带稳定身份键时按 id 累积，否则取更「长」的一方
 * @param key 当前值所在的属性名，用于判断是否属于流式文本字段（顶层与数组元素为 undefined）
 */
export const mergeSseValue = (acc: any, next: any, key?: string): any => {
  if (acc === undefined) return next;
  if (next === undefined) return acc;
  if (typeof acc === 'string' && typeof next === 'string') {
    if (!isConcatTextKey(key)) return next;
    return next.startsWith(acc) ? next : acc + next;
  }
  if (Array.isArray(acc) && Array.isArray(next)) {
    const idKey = pickArrayIdKey(acc, next);
    if (idKey) return mergeArraysById(acc, next, idKey);
    return next.length >= acc.length ? next : acc;
  }
  if (isPlainObject(acc) && isPlainObject(next)) {
    const out: Record<string, any> = { ...acc };
    for (const k of Object.keys(next)) out[k] = mergeSseValue(out[k], next[k], k);
    return out;
  }
  // 类型不一致或标量：取后者
  return next;
};

export interface SseAggregateResult {
  /** 合并后的大对象；无可合并帧时为 null */
  merged: any;
  /** 主事件名（参与合并的帧的事件类型，取出现次数最多者） */
  primaryEvent: string;
  /** 全部帧数（含心跳与其它事件） */
  totalFrames: number;
  /** 实际参与合并的帧数 */
  mergedFrames: number;
  /** 跳过的心跳帧数 */
  heartbeatFrames: number;
  /** 非主事件的帧（如 trailer / error），不参与合并、原样保留 */
  otherEvents: Array<{ event: string; data: any }>;
}

/** 取出现次数最多的事件名，平局时取最先出现者 */
const pickPrimaryEvent = (events: string[]): string => {
  const counts = new Map<string, number>();
  let best = events[0] ?? 'message';
  let bestCount = 0;
  for (const e of events) {
    const c = (counts.get(e) ?? 0) + 1;
    counts.set(e, c);
    if (c > bestCount) {
      bestCount = c;
      best = e;
    }
  }
  return best;
};

/** 单帧解析结果：事件名 + 已 deepParse 的数据 */
export interface ParsedSseFrame {
  event: string;
  data: any;
}

/**
 * 把原始 SSE 消息解析为帧（每帧 data 已 deepParse）。
 * 解析与合并拆开：拖动调整聚合帧数时对同一份解析结果按 slice 重新合并，无需每次重新 JSON.parse。
 */
export const parseSseFrames = (messages: SSEMessage[] | undefined): ParsedSseFrame[] =>
  (messages ?? []).map(m => ({ event: m.event || 'message', data: deepParseJson(m.data) }));

/** 对已解析的帧做聚合；调整帧数时传入前 N 帧的 slice 即可 */
export const aggregateParsedFrames = (frames: ParsedSseFrame[]): SseAggregateResult => {
  const primaryEvent = pickPrimaryEvent(frames.map(f => f.event));

  let merged: any;
  let mergedFrames = 0;
  let heartbeatFrames = 0;
  const otherEvents: Array<{ event: string; data: any }> = [];

  for (const frame of frames) {
    if (frame.event !== primaryEvent) {
      otherEvents.push(frame);
      continue;
    }
    if (looksLikeHeartbeat(frame.data)) {
      heartbeatFrames++;
      continue;
    }
    merged = merged === undefined ? frame.data : mergeSseValue(merged, frame.data);
    mergedFrames++;
  }

  return {
    merged: merged === undefined ? null : merged,
    primaryEvent,
    totalFrames: frames.length,
    mergedFrames,
    heartbeatFrames,
    otherEvents,
  };
};

export const aggregateSseMessages = (messages: SSEMessage[] | undefined): SseAggregateResult =>
  aggregateParsedFrames(parseSseFrames(messages));
