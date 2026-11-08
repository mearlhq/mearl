// 源码追溯 hook：picker 选中元素 → 拿到 candidates → 在 requests 里反向值匹配 → 输出 TraceResult
//
// 阶段一仅做运行时值匹配，无需任何编译期支持。匹配精度依赖响应字段值的"足够独特"，
// 适合 dev 环境验证交互。生产精度版本见阶段二的 Vite 插件方案。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CapturedRequest } from '../types';
import { sendMessageSafely } from '../utils/safeChrome';
import {
  ELEMENT_PICKER_SESSION_STARTED_EVENT,
  announceElementPickerSession,
  createElementPickerOwnerId,
  getElementPickerSessionOwner,
} from '../utils/elementPickerSession';

interface SourceLocation {
  fileName: string;
  lineNumber: number;
  columnNumber?: number;
}

interface TraceCandidate {
  value: unknown;
  from: 'props' | 'text';
  propPath: string[];
  depth: number;
}

interface TracePayload {
  ok: boolean;
  reason?: string;
  componentName?: string;
  sourceLocation?: SourceLocation;
  candidates: TraceCandidate[];
  elementInfo: {
    tag: string;
    text: string;
    selector: string;
    semanticSelector: string;
    attrs: Array<{ name: string; value: string }>;
  };
  pageInfo: {
    url: string;
    pathname: string;
  };
}

export type MatchConfidence = 'high' | 'medium' | 'low';

export interface FieldMatch {
  request: CapturedRequest;
  apiName: string;
  path: string[];
  value: unknown;
  candidate: TraceCandidate;
  score: number;
  confidence: MatchConfidence;
  confidenceReasons: string[];
}

export interface TraceResult {
  ok: boolean;
  reason?: string;
  componentName?: string;
  sourceLocation?: SourceLocation;
  elementInfo: TracePayload['elementInfo'];
  pageInfo: TracePayload['pageInfo'];
  matches: FieldMatch[];
  frameId?: number;
}

interface UseSourceTracerOptions {
  // 当前列表筛选后的请求，按时间升序排列。
  getRequests: () => CapturedRequest[];
  // 筛选条件或页面范围变化时更新；后续网络流量沿用本次点选的快照。
  scopeKey: string;
  onResult: (result: TraceResult) => void;
}

const MAX_MATCHES = 8;

const NOISE_STRING_VALUES = new Set(['true', 'false', 'null', 'undefined', 'NaN', '0']);

function isMatchable(v: unknown): boolean {
  if (typeof v === 'string') {
    if (v.length < 2 || v.length > 200) return false;
    if (NOISE_STRING_VALUES.has(v)) return false;
    return true;
  }
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) > 0;
  return false;
}

// 生成值的等价变体，用于处理"DOM 显示格式化 vs 接口原始格式"差异
// "177 0026 9325" → ["177 0026 9325", "17700269325"]
// "+¥139升舱"     → ["+¥139升舱", 139, "139"]
// "2024-05-24"   → ["2024-05-24", "20240524"]（少见，可选）
function expandValueVariants(v: unknown): unknown[] {
  if (typeof v !== 'string') return [v];
  const variants: unknown[] = [v];

  // 1. 纯数字串：去掉空格/破折号/括号/加号（手机号、银行卡、订单号）
  const digits = v.replace(/[\s\-()+]/g, '');
  if (digits !== v && /^\d+$/.test(digits) && digits.length >= 3) {
    variants.push(digits);
  }

  // 2. 提取出第一段数字（价格、计数等场景：'+¥139' / '139元' / '￥1,234.56'）
  const numMatch = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (numMatch) {
    const n = parseFloat(numMatch[0]);
    if (Number.isFinite(n) && Math.abs(n) > 0) {
      if (!variants.includes(n)) variants.push(n);
      if (numMatch[0] !== v && !variants.includes(numMatch[0])) variants.push(numMatch[0]);
    }
  }

  return variants;
}

// 把响应里所有"看着像 JSON 的字符串"递归解析回对象，方便 deepFindPath 能进到里面去找
// 路径表示不变（["trackInfo", "1", "xItemProductName"]），setValueByPathInParsedData
// 会在写回时自动识别 JSON 字符串边界并重新序列化，所以 mock 一样工作
function deepParseJsonStrings(data: unknown, depth = 0): unknown {
  if (depth > 16 || data == null) return data;
  if (typeof data === 'string') {
    if (data.length > 1) {
      const c0 = data.charCodeAt(0);
      // 0x7b = '{', 0x5b = '['
      if (c0 === 0x7b || c0 === 0x5b) {
        try {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed === 'object') {
            return deepParseJsonStrings(parsed, depth + 1);
          }
        } catch {
          // 不是合法 JSON，原样返回
        }
      }
    }
    return data;
  }
  if (typeof data !== 'object') return data;
  if (Array.isArray(data)) {
    const out = new Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = deepParseJsonStrings(data[i], depth + 1);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(data as object)) {
    out[k] = deepParseJsonStrings((data as Record<string, unknown>)[k], depth + 1);
  }
  return out;
}

// 收集所有命中路径（同一值在响应里多次出现时全部返回，供后续按锚点路径去消歧）
// 给个 limit 防止极端情况（如响应里某常量值出现几百次）把内存打爆
const MAX_PATHS_PER_VALUE = 20;

function deepFindAllPaths(
  data: unknown,
  target: unknown,
  pathOut: string[],
  depth: number,
  out: string[][],
): void {
  if (depth > 16) return;
  if (out.length >= MAX_PATHS_PER_VALUE) return;
  if (data === target) {
    out.push(pathOut);
    return;
  }
  if (data == null || typeof data !== 'object') return;
  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      deepFindAllPaths(data[i], target, [...pathOut, String(i)], depth + 1, out);
      if (out.length >= MAX_PATHS_PER_VALUE) return;
    }
    return;
  }
  for (const k of Object.keys(data as object)) {
    deepFindAllPaths((data as any)[k], target, [...pathOut, k], depth + 1, out);
    if (out.length >= MAX_PATHS_PER_VALUE) return;
  }
}

function commonPrefixLen(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// 同一 request 内，为每个候选挑选最优路径，让所有候选尽量「指向同一子树/同一 list item」
// 实现：先用单路径迭代对齐收敛到一组锚点，再为每个 multi-path 候选按对锚点的对齐分数挑选 ——
// - 唯一路径候选 → 始终返回它自己
// - 多路径候选有明显最优 → 返回单条
// - 多路径候选最高分打平（消歧失败，例如 list 各项都无唯一锚点）→ 返回全部打平的路径，
//   让 UI 都展出来，宁可冗余也不要藏掉真实结果
function pickBestPaths(
  hits: Array<{ candidate: TraceCandidate; paths: string[][]; matchedValue: unknown }>,
): string[][][] {
  // 第一阶段：用「每个候选选 1 条」的方式迭代对齐，得到一组收敛后的代表路径
  const repr = hits.map(h => h.paths[0]);
  for (let iter = 0; iter < 3; iter++) {
    let changed = false;
    for (let i = 0; i < hits.length; i++) {
      if (hits[i].paths.length <= 1) continue;
      let bestPath = repr[i];
      let bestScore = -1;
      for (const p of hits[i].paths) {
        let s = 0;
        for (let j = 0; j < hits.length; j++) {
          if (i === j) continue;
          s += commonPrefixLen(p, repr[j]);
        }
        if (s > bestScore) {
          bestScore = s;
          bestPath = p;
        }
      }
      if (bestPath !== repr[i]) {
        repr[i] = bestPath;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 第二阶段：拿收敛后的 repr 当锚点，给每个候选的所有路径打分；最高分打平的全部返回
  return hits.map((h, i) => {
    if (h.paths.length <= 1) return [h.paths[0]];
    let bestScore = -1;
    const scores: number[] = [];
    for (const p of h.paths) {
      let s = 0;
      for (let j = 0; j < hits.length; j++) {
        if (i === j) continue;
        s += commonPrefixLen(p, repr[j]);
      }
      scores.push(s);
      if (s > bestScore) bestScore = s;
    }
    return h.paths.filter((_, k) => scores[k] === bestScore);
  });
}

function scoreMatch(c: TraceCandidate, path: string[]): number {
  let s = 0;
  if (typeof c.value === 'string') s += Math.min(c.value.length, 50);
  if (typeof c.value === 'number') s += 8;
  if (c.from === 'props') s += 10;
  if (c.from === 'text') s += 4;
  s += Math.max(0, 5 - c.depth);
  // path 越短（越靠近响应根），通常越像业务字段
  s += Math.max(0, 6 - path.length);
  return s;
}

// 同一 request 内：当存在"强 text 命中"时，对 props 命中按子树过滤
// - 强 text 命中 = candidate.from='text' 且匹配上的就是候选完整原值（不是 expandValueVariants 退化的片段）
// - 与某条 text path 共同前缀 >= len-1（同父或更深）的 props 命中保留 —— 它们是"同一行/同一子树"
//   的兄弟字段，既能作为消歧输入，也能给用户呈现命中上下文
// - 共同前缀不到 len-1 的 props 命中丢弃 —— 父组件其它兄弟数据（banner 图、track 参数等）的噪声
function foldPropsByTextPerRequest(matches: FieldMatch[]): FieldMatch[] {
  const textPathsByReq = new Map<CapturedRequest['id'], string[][]>();
  for (const m of matches) {
    if (m.candidate.from === 'text' && m.value === m.candidate.value) {
      let arr = textPathsByReq.get(m.request.id);
      if (!arr) {
        arr = [];
        textPathsByReq.set(m.request.id, arr);
      }
      arr.push(m.path);
    }
  }
  if (textPathsByReq.size === 0) return matches;

  return matches.filter(m => {
    if (m.candidate.from === 'text') return true;
    const tps = textPathsByReq.get(m.request.id);
    if (!tps || tps.length === 0) return true;
    return tps.some(tp => commonPrefixLen(m.path, tp) >= tp.length - 1);
  });
}

// 跨 request 去重：同一 apiName + path 的多次命中只保留最近一次（matches 是按 oldest→newest 顺序追加的）
function dedupeByApiAndPath(matches: FieldMatch[]): FieldMatch[] {
  const latest = new Map<string, FieldMatch>();
  for (const m of matches) {
    latest.set(`${m.apiName}::${m.path.join('.')}`, m);
  }
  return [...latest.values()];
}

// 常见"会被渲染出来的字段名"，命中说明这个 path 更可能是真实数据源
const RENDERABLE_LEAF_RE =
  /^(name|title|text|label|desc|description|content|value|nick|nickname|displayName|displayname|price|amount|count|total|url|src|href|icon|image|img|avatar|tag|status|brand|model|category)$/i;

const ID_LIKE_RE = /^[0-9a-f]{16,}$|^[A-Z0-9_-]{10,}$/;

// CJK 一个字 ≈ 一个完整 token，信息量约等于 2 个 Latin 字符；按这个权重折算
// "有效长度"，避免 "上海"/"北京" 这类 2 字中文被当成 "ok" 这种噪音值处理
const CJK_RE = /[㐀-鿿豈-﫿぀-ヿ가-힯]/;
function effectiveStringLength(s: string): number {
  let len = 0;
  for (const ch of s) len += CJK_RE.test(ch) ? 2 : 1;
  return len;
}

function computeConfidence(matches: FieldMatch[]): void {
  // 跨匹配统计：值在多少个 API 里都出现过、同一 API 命中了几个字段
  const valueApiSet = new Map<unknown, Set<string>>();
  const apiClusterSize = new Map<string, number>();
  for (const m of matches) {
    if (!valueApiSet.has(m.value)) valueApiSet.set(m.value, new Set());
    valueApiSet.get(m.value)!.add(m.apiName);
    apiClusterSize.set(m.apiName, (apiClusterSize.get(m.apiName) ?? 0) + 1);
  }

  for (const m of matches) {
    let score = 0;
    const reasons: string[] = [];
    const leafKey = m.path[m.path.length - 1] ?? '';
    const leafIsRenderable = RENDERABLE_LEAF_RE.test(leafKey);

    // ─── value distinctiveness ────────────────────────────────────────
    if (typeof m.value === 'string') {
      const effLen = effectiveStringLength(m.value);
      if (effLen >= 20) {
        score += 3;
        reasons.push('long string (highly distinctive)');
      } else if (effLen >= 8) {
        score += 2;
      } else if (effLen >= 4) {
        score += 1;
      } else if (leafIsRenderable) {
        // 短字符串本身没区分度，但 leaf 是 text/name/title 之类强渲染字段，
        // 已经在 path semantics 加 +2，这里不再叠加短字符串噪音惩罚
      } else {
        score -= 1;
        reasons.push('short string — possible false match');
      }
      if (ID_LIKE_RE.test(m.value)) {
        score += 2;
        reasons.push('looks like an ID/hash');
      }
    } else if (typeof m.value === 'number') {
      if (Math.abs(m.value) >= 1000) {
        score += 1;
      }
      if (Number.isInteger(m.value) && Math.abs(m.value) < 100) {
        score -= 2;
        reasons.push('small integer — multiple APIs may share this value');
      }
    }

    // ─── candidate origin ─────────────────────────────────────────────
    if (m.candidate.from === 'props' && m.candidate.depth <= 1) {
      score += 2;
      reasons.push('direct prop');
    } else if (m.candidate.from === 'text') {
      score += 1;
      reasons.push('element text');
    } else if (m.candidate.depth >= 3) {
      score -= 1;
      reasons.push('deeply nested prop');
    }

    // ─── path semantics ───────────────────────────────────────────────
    if (leafIsRenderable) {
      score += 2;
      reasons.push(`leaf key \`${leafKey}\` is a typical renderable field`);
    }
    if (m.path.length > 8) {
      score -= 1;
      reasons.push('deep path');
    }

    // ─── cross-match signals ──────────────────────────────────────────
    // 精确文本匹配（页面直接展示的文案 === 接口返回原值）是确定性关联，
    // 不因"多个 API 都返回了同一文案"而降级——用户看到的就是这个值
    const isExactTextMatch = m.candidate.from === 'text' && m.value === m.candidate.value;
    const apiCount = valueApiSet.get(m.value)?.size ?? 1;
    if (apiCount > 1 && !isExactTextMatch) {
      score -= 2;
      reasons.push(`value appears in ${apiCount} APIs`);
    }
    const cluster = apiClusterSize.get(m.apiName) ?? 1;
    if (cluster >= 2) {
      score += 1;
      reasons.push(`${cluster} fields hit on the same API (clustering signal)`);
    }

    let confidence: MatchConfidence;
    if (score >= 4) confidence = 'high';
    else if (score >= 1) confidence = 'medium';
    else confidence = 'low';

    m.confidence = confidence;
    m.confidenceReasons = reasons;
    // 把置信度反馈到 score，便于综合排序
    m.score += score * 2;
  }
}

async function matchCandidates(
  candidates: TraceCandidate[],
  requests: CapturedRequest[],
  isCurrent: () => boolean,
): Promise<FieldMatch[] | null> {
  const filtered = candidates.filter(c => isMatchable(c.value));
  // 长字符串优先匹配（更有区分度）
  filtered.sort((a, b) => {
    const al = typeof a.value === 'string' ? a.value.length : 0;
    const bl = typeof b.value === 'string' ? b.value.length : 0;
    return bl - al;
  });

  type RawHit = {
    candidate: TraceCandidate;
    paths: string[][];
    matchedValue: unknown;
  };
  const perRequest = new Map<CapturedRequest['id'], { req: CapturedRequest; hits: RawHit[] }>();
  let sliceStarted = performance.now();
  const yieldIfNeeded = async () => {
    if (performance.now() - sliceStarted >= 8) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      sliceStarted = performance.now();
    }
    return isCurrent();
  };

  // 每个响应仅解析一次；按时间片处理完整列表，使面板仍能响应筛选和取消。
  for (const req of requests) {
    if (!isCurrent()) return null;
    if (req.responseBody == null) continue;
    const body = deepParseJsonStrings(req.responseBody);
    const hits: RawHit[] = [];
    for (const c of filtered) {
      const variants = expandValueVariants(c.value);
      for (const variant of variants) {
        const paths: string[][] = [];
        deepFindAllPaths(body, variant, [], 0, paths);
        if (paths.length) {
          hits.push({ candidate: c, paths, matchedValue: variant });
          break;
        }
      }
      if (!(await yieldIfNeeded())) return null;
    }
    if (hits.length) perRequest.set(req.id, { req, hits });
    if (!(await yieldIfNeeded())) return null;
  }

  const matches: FieldMatch[] = [];
  for (const { req, hits } of perRequest.values()) {
    const picks = pickBestPaths(hits);
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      for (const path of picks[i]) {
        matches.push({
          request: req,
          apiName: req.apiName,
          path,
          value: h.matchedValue,
          candidate: h.candidate,
          score: scoreMatch(h.candidate, path),
          confidence: 'low',
          confidenceReasons: [],
        });
      }
    }
  }

  if (!isCurrent()) return null;

  // 先折叠/去重，再算置信度（样本变小后跨匹配统计才准）
  const folded = dedupeByApiAndPath(foldPropsByTextPerRequest(matches));
  computeConfidence(folded);

  // low 一律不展示 —— 大多是值长度短/小整数/跨 API 散布的弱信号，宁可面板空一行
  const confident = folded.filter(m => m.confidence !== 'low');

  const order: Record<MatchConfidence, number> = { high: 0, medium: 1, low: 2 };
  confident.sort((a, b) => {
    // 精确文本匹配（页面文案 === 接口原值）永远排最前
    const aExact = a.candidate.from === 'text' && a.value === a.candidate.value ? 0 : 1;
    const bExact = b.candidate.from === 'text' && b.value === b.candidate.value ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    return order[a.confidence] - order[b.confidence] || b.score - a.score;
  });
  return confident.slice(0, MAX_MATCHES);
}

export function useSourceTracer({ getRequests, scopeKey, onResult }: UseSourceTracerOptions) {
  const [isPicking, setIsPicking] = useState(false);
  const ownerIdRef = useRef(createElementPickerOwnerId());
  const traceRevisionRef = useRef(0);
  const matchingRevisionRef = useRef<number | null>(null);
  const requestScopeRef = useRef({ getRequests, scopeKey });
  requestScopeRef.current = { getRequests, scopeKey };

  useEffect(() => () => { traceRevisionRef.current++; }, []);

  const cancel = useCallback(() => {
    traceRevisionRef.current++;
    setIsPicking(false);
    try {
      const tabId = chrome.devtools.inspectedWindow.tabId;
      sendMessageSafely({ action: 'cancelElementPicker', tabId });
    } catch {
      // not in devtools context
    }
  }, []);

  const start = useCallback(() => {
    traceRevisionRef.current++;
    try {
      const tabId = chrome.devtools.inspectedWindow.tabId;
      announceElementPickerSession(ownerIdRef.current);
      setIsPicking(true);
      void sendMessageSafely<{ success?: boolean }>({
        action: 'startElementPicker',
        tabId,
        traceMode: true,
      })
        .then(response => {
          if (response?.success !== true) setIsPicking(false);
        })
        .catch(() => setIsPicking(false));
    } catch {
      // not in devtools context
    }
  }, []);

  const toggle = useCallback(() => {
    if (isPicking) cancel();
    else start();
  }, [isPicking, cancel, start]);

  useEffect(() => {
    const handleSessionStarted = (event: Event) => {
      if (getElementPickerSessionOwner(event) === ownerIdRef.current) return;
      traceRevisionRef.current++;
      setIsPicking(false);
    };
    const handleNavigation = () => {
      traceRevisionRef.current++;
      setIsPicking(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (isPicking || matchingRevisionRef.current === traceRevisionRef.current)) cancel();
    };
    window.addEventListener(ELEMENT_PICKER_SESSION_STARTED_EVENT, handleSessionStarted);
    window.addEventListener('mearl-main-frame-committed', handleNavigation);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener(ELEMENT_PICKER_SESSION_STARTED_EVENT, handleSessionStarted);
      window.removeEventListener('mearl-main-frame-committed', handleNavigation);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [cancel, isPicking]);

  useEffect(() => {
    if (!isPicking) return;

    const handleTraced = (e: Event) => {
      const detail = (e as CustomEvent<{ tagId: string; payload: TracePayload; frameId?: number }>)
        .detail;
      setIsPicking(false);
      if (!detail?.payload) return;
      const payload = detail.payload;

      const revision = ++traceRevisionRef.current;
      matchingRevisionRef.current = revision;
      const isCurrent = () => traceRevisionRef.current === revision;
      const matchCurrentScope = async () => {
        let scope = requestScopeRef.current;
        let requests = scope.getRequests();
        while (isCurrent()) {
          const matches = payload.ok
            ? await matchCandidates(payload.candidates, requests, isCurrent)
            : [];
          if (!matches || !isCurrent()) return;
          const current = requestScopeRef.current;
          if (current.scopeKey !== scope.scopeKey) {
            scope = current;
            requests = current.getRequests();
            continue;
          }
          matchingRevisionRef.current = null;
          onResult({
            ok: payload.ok,
            reason: payload.reason,
            componentName: payload.componentName,
            sourceLocation: payload.sourceLocation,
            elementInfo: payload.elementInfo,
            pageInfo: payload.pageInfo,
            matches,
            ...(typeof detail.frameId === 'number' ? { frameId: detail.frameId } : {}),
          });
          return;
        }
      };
      void matchCurrentScope().catch(error => {
        if (isCurrent()) matchingRevisionRef.current = null;
        console.warn('Source trace matching failed', error);
      });
    };

    const handleCancelled = () => {
      traceRevisionRef.current++;
      setIsPicking(false);
    };

    window.addEventListener('mearl-element-traced', handleTraced);
    window.addEventListener('mearl-element-pick-cancelled', handleCancelled);

    return () => {
      window.removeEventListener('mearl-element-traced', handleTraced);
      window.removeEventListener('mearl-element-pick-cancelled', handleCancelled);
    };
  }, [isPicking, getRequests, onResult, cancel]);

  return { isPicking, start, cancel, toggle };
}
