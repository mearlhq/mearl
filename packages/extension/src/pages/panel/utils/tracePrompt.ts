// Convert a TraceResult into a prompt for an AI coding agent.
// Principle: every section must help the agent narrow its search; otherwise omit it.

import type { TraceResult, FieldMatch } from '../hooks/useSourceTracer';
import { formatFieldPath } from './sourceLocator';

const CONFIDENCE_TAG: Record<string, string> = {
  high: '[high]',
  medium: '[medium]',
  low: '[low]',
};

function previewValue(v: unknown): string {
  if (typeof v === 'string') {
    if (v.length > 120) return JSON.stringify(v.slice(0, 120) + '…');
    return JSON.stringify(v);
  }
  return JSON.stringify(v);
}

// Keep the HTTP location while dropping potentially sensitive query parameters.
function shortenRequestUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.length > 120 ? url.slice(0, 120) + '…' : url;
  }
}

// Drop risk-control fields and overly long values from postData.
const NOISE_KEYS = new Set([
  'sign',
  'sg',
  'token',
  '_csrf',
  'umtoken',
  'umt',
  'asac',
  'x5sec',
  'wua',
  'utdid',
  'umidToken',
  'uniqId',
  '__t__',
]);

function summarizePostData(data: unknown): string | null {
  if (data == null) return null;
  let obj: any = data;
  if (typeof data === 'string') {
    try {
      obj = JSON.parse(data);
    } catch {
      return data.length > 200 ? data.slice(0, 200) + '…' : data;
    }
  }
  if (typeof obj !== 'object') return String(obj);

  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const k of Object.keys(obj)) {
    if (NOISE_KEYS.has(k)) continue;
    const v = obj[k];
    if (v == null) continue;
    if (typeof v === 'object') {
      out[k] = `{${Object.keys(v).slice(0, 6).join(',')}}`;
    } else {
      const s = String(v);
      out[k] = s.length > 80 ? s.slice(0, 80) + '…' : v;
    }
    kept++;
    if (kept >= 10) break;
  }
  if (!kept) return null;
  return JSON.stringify(out);
}

function formatMatch(m: FieldMatch, idx: number): string {
  const lines: string[] = [];
  const tag = CONFIDENCE_TAG[m.confidence] ?? '';
  lines.push(`${idx + 1}. ${tag} ${m.apiName}`);
  lines.push(`   field: ${formatFieldPath(m.path)}`);
  lines.push(`   value: ${previewValue(m.value)}`);
  if (m.request?.url) {
    lines.push(`   request: ${m.request.method ?? 'POST'} ${shortenRequestUrl(m.request.url)}`);
  }
  const params = summarizePostData(m.request?.postData);
  if (params) {
    lines.push(`   params: ${params}`);
  }
  if (m.confidence !== 'high' && m.confidenceReasons.length) {
    lines.push(`   note:   ${m.confidenceReasons.join(' / ')}`);
  }
  return lines.join('\n');
}

export function buildAgentPrompt(result: TraceResult): string {
  const lines: string[] = [];
  lines.push(
    'I clicked an element in the browser. Help me locate the rendering source and data flow in the codebase.',
  );

  // ─── Element ────────────────────────────────────────────────────────────
  const el = result.elementInfo;
  const elBlock: string[] = ['', '## Element'];
  elBlock.push(`- text: ${el.text ? JSON.stringify(el.text) : '(empty)'}`);
  if (el.semanticSelector && el.semanticSelector !== el.tag) {
    elBlock.push(`- selector: ${el.semanticSelector}`);
  }
  if (el.attrs && el.attrs.length) {
    const attrStr = el.attrs.map(a => `${a.name}=${JSON.stringify(a.value)}`).join(' ');
    elBlock.push(`- attrs: ${attrStr}`);
  }
  lines.push(...elBlock);

  // ─── Page ───────────────────────────────────────────────────────────────
  if (result.pageInfo?.url) {
    lines.push('', '## Page');
    lines.push(`- URL: ${result.pageInfo.url}`);
    if (result.pageInfo.pathname) {
      lines.push(`- pathname: ${result.pageInfo.pathname}`);
    }
  }

  // ─── Component (only if known) ──────────────────────────────────────────
  if (result.componentName) {
    lines.push('', '## React component', `- <${result.componentName}>`);
  }

  // ─── Source location (only if known) ────────────────────────────────────
  if (result.sourceLocation) {
    const { fileName, lineNumber, columnNumber } = result.sourceLocation;
    lines.push(
      '',
      '## Source location (from React fiber _debugSource)',
      `- ${fileName}:${lineNumber}${columnNumber ? `:${columnNumber}` : ''}`,
    );
  }

  // ─── Candidate data sources ─────────────────────────────────────────────
  lines.push('', '## Candidate data sources (sorted by confidence)');
  if (result.matches.length === 0) {
    lines.push('(No matches — could be a computed/derived value, or the API was not called.)');
  } else {
    lines.push(result.matches.map(formatMatch).join('\n\n'));
  }

  // ─── Task ───────────────────────────────────────────────────────────────
  lines.push(
    '',
    '## Please',
    '1. Locate the component file:line that renders this element. Search hints (in priority order):',
    '   - the literal element text',
    '   - the leaf segment of a candidate field path above (e.g. `passengers[0].basicInfos.name` → search for `basicInfos.name` or `basicInfos`)',
    '   - the API name — find the call site, then trace forward to the render',
    '   - the page pathname, mapped to a route config',
    '2. Outline the "API response → render" data flow (hook / store / props / JSX).',
  );

  return lines.join('\n');
}
