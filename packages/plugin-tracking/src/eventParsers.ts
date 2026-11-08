/**
 * Pure parsers for tracking requests. Callers provide the request URL/body and
 * may provide a stable sequence and timestamp when deterministic IDs are needed.
 */

import type { RumEvent } from '@mearl/browser-core';

// ─── URL patterns ─────────────────────────────────────────────────────────────

export const APLUS_URL_PATTERN = /\.mmstat\.com\//;
export const RUM_URL_PATTERN = /\.rum\.aliyuncs\.com\//;
export const ARMS_URL_PATTERN = /^arms-retcode\.aliyuncs\.com\//;

function trackingHostname(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : '';
  } catch { return ''; }
}

function matchesTrackingHost(url: string, pattern: RegExp): boolean {
  return pattern.test(`${trackingHostname(url)}/`);
}

export function isTrackingUrl(url: string): boolean {
  const hostname = trackingHostname(url);
  return (
    matchesTrackingHost(url, APLUS_URL_PATTERN) ||
    matchesTrackingHost(url, RUM_URL_PATTERN) ||
    matchesTrackingHost(url, ARMS_URL_PATTERN) ||
    /^(?:retcode\.alicdn\.com|beacon\.taobao\.com)$|(?:^|\.)tbsec\./i.test(hostname)
  );
}

export interface TrackingParseOptions {
  /** Event receive time in milliseconds. Defaults to Date.now(). */
  now?: number;
  /** Stable request sequence supplied by the owning per-tab/session buffer. */
  sequence?: number;
}

export interface AplusSpmResolution {
  mainSpm: string;
  highlightSpm: string;
}

let aplusCounter = 0;
let armsCounter = 0;
let rumCounter = 0;

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseParams(value: string): Record<string, string> {
  const params: Record<string, string> = {};
  value.split('&').forEach(pair => {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) return;
    const rawKey = pair.slice(0, eqIndex);
    const rawValue = pair.slice(eqIndex + 1);
    try {
      params[decodeURIComponent(rawKey)] = rawValue;
    } catch {
      params[rawKey] = rawValue;
    }
  });
  return params;
}

function decodeParamValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseJsonParamValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    const decoded = decodeParamValue(value);
    if (decoded === value) return undefined;
    try {
      return JSON.parse(decoded);
    } catch {
      return undefined;
    }
  }
}

function parseUrlParams(search: string): Record<string, string> {
  const encodedParams = parseParams(search.startsWith('?') ? search.slice(1) : search);
  return Object.fromEntries(
    Object.entries(encodedParams).map(([key, value]) => [key, decodeParamValue(value)]),
  );
}

/** If spm-url is a full URL, return its spm query parameter. */
export function extractSpmFromUrl(spmOrUrl: string): string {
  if (!/^https?:\/\//i.test(spmOrUrl)) return spmOrUrl;

  try {
    return new URL(spmOrUrl).searchParams.get('spm') ?? spmOrUrl;
  } catch {
    return spmOrUrl;
  }
}

/**
 * Resolve the point SPM according to event semantics.
 * CLK uses gokey.spm, EXP uses expdata[0].spm, and PV uses spm-url.
 */
export function resolveAplusSpm(
  eventType: string | undefined,
  raw: Record<string, any>,
): AplusSpmResolution {
  const expdata = Array.isArray(raw.expdata) ? raw.expdata : [];
  const expSpm: string = expdata[0]?.spm || '';
  const gokeyParams = parseParams(raw.gokey || '');
  const gokeySpm = decodeParamValue(gokeyParams.spm || '');
  const rawSpmUrl: string = raw['spm-url'] || decodeParamValue(gokeyParams['spm-url'] || '');
  const spmUrl = extractSpmFromUrl(rawSpmUrl);

  let pointSpm: string;
  switch (eventType) {
    case 'CLK':
      pointSpm = gokeySpm || expSpm;
      break;
    case 'EXP':
      pointSpm = expSpm;
      break;
    case 'PV':
      pointSpm = spmUrl;
      break;
    default:
      pointSpm = gokeySpm || expSpm;
  }

  return {
    mainSpm: pointSpm,
    highlightSpm: pointSpm,
  };
}

// ─── Aplus parser ─────────────────────────────────────────────────────────────

export function parseAplusRequest(
  url: string,
  options: TrackingParseOptions = {},
): RumEvent | null {
  if (!matchesTrackingHost(url, APLUS_URL_PATTERN)) return null;

  let urlObj: URL;
  try {
    urlObj = new URL(url);
  } catch {
    return null;
  }

  // Tracking identifiers can contain an unescaped "+". Decode raw query pairs so
  // it remains a plus sign instead of application/x-www-form-urlencoded whitespace.
  const params = parseUrlParams(urlObj.search);

  const gmkey = params.gmkey ?? 'UNKNOWN';
  const urlPathName = urlObj.pathname.slice(1);
  const pathCategory = urlPathName.split('.')[1];
  const eventType = pathCategory === 'selfdefine' ? 'SDF' : gmkey;
  const gokeyRaw = params.gokey ?? '';
  const gokeyParams = parseParams(gokeyRaw);

  let expdata: any[] = [];
  if (gokeyParams.expdata) {
    const parsedExpdata = parseJsonParamValue(gokeyParams.expdata);
    if (Array.isArray(parsedExpdata)) {
      expdata = parsedExpdata.map((item: any) => {
        if (!item?.exargs || typeof item.exargs !== 'object') return item;

        const decoded: Record<string, any> = {};
        for (const [key, value] of Object.entries(item.exargs)) {
          if (typeof value !== 'string') {
            decoded[key] = value;
            continue;
          }
          const parsedValue = parseJsonParamValue(value);
          decoded[key] = parsedValue === undefined ? value : parsedValue;
        }
        return { ...item, exargs: decoded };
      });
    }
  }

  const rawBizArgs = gokeyParams.bizArgs;
  const parsedBizArgs = rawBizArgs === undefined ? undefined : parseJsonParamValue(rawBizArgs);
  const bizArgs = parsedBizArgs === undefined ? rawBizArgs : parsedBizArgs;

  const pageUrl =
    params['_p_url'] ?? (gokeyParams['_p_url'] ? decodeParamValue(gokeyParams['_p_url']) : '');
  const { gokey: rawGokey, ...topLevelParams } = params;
  const rawData: Record<string, any> = {
    ...topLevelParams,
    _path: urlPathName,
    _url: url,
    gokey: rawGokey,
    ...(expdata.length > 0 ? { expdata } : {}),
    ...(bizArgs !== undefined ? { bizArgs } : {}),
  };
  const spm = resolveAplusSpm(eventType, rawData).mainSpm;
  const pathName = urlPathName.split('.').slice(1).join('.');
  const eventName = eventType === 'SDF' ? pathName : spm || pathName || pageUrl;
  const now = options.now ?? Date.now();
  const sequence = options.sequence ?? ++aplusCounter;

  return {
    id: `aplus-${sequence}-${now}`,
    source: 'aplus',
    batchId: 0,
    batchTimestampMs: now,
    batchTimestamp: formatTimestamp(now),
    event_type: eventType,
    name: eventName,
    url,
    timestamp: now,
    _raw: rawData,
    _context: {
      requestUrl: url,
      app: {},
      user: {
        ...(params.uidaplus ? { uidaplus: params.uidaplus } : {}),
        ...(params['_gr_uid_'] ? { _gr_uid_: params['_gr_uid_'] } : {}),
      },
      session: {},
      view: {
        ...(params['spm-url'] ? { 'spm-url': params['spm-url'] } : {}),
        ...(params['spm-pre'] ? { 'spm-pre': params['spm-pre'] } : {}),
        ...(params['spm-cnt'] ? { 'spm-cnt': params['spm-cnt'] } : {}),
        ...(pageUrl ? { page_url: pageUrl } : {}),
      },
      properties: {},
      os: {},
      net: {},
    },
  };
}

// ─── RUM parser ───────────────────────────────────────────────────────────────

const RUM_TYPE_ALIAS: Record<string, string> = {
  cst: 'custom',
};

const I18N_TRACKER_TYPE_MAP: Record<string, string> = {
  'i18n-tracker-exp': 'EXP',
  'i18n-tracker-clk': 'CLK',
};

function parseRumBody(postData: string | Record<string, any> | null | undefined) {
  if (!postData) return null;
  if (typeof postData === 'object') return postData;
  try {
    return JSON.parse(postData) as Record<string, any>;
  } catch {
    return null;
  }
}

function tryConvertI18nTracker(
  event: Record<string, any>,
  base: Omit<RumEvent, 'event_type' | 'name' | '_raw' | 'validation'>,
): RumEvent | null {
  const normalizedType = RUM_TYPE_ALIAS[event.type] ?? event.type;
  if (event.event_type !== 'action' || normalizedType !== 'custom') return null;

  let snapshots: Record<string, any>;
  try {
    snapshots = typeof event.snapshots === 'string' ? JSON.parse(event.snapshots) : event.snapshots;
  } catch {
    return null;
  }
  if (!snapshots || typeof snapshots !== 'object') return null;

  const eventType = I18N_TRACKER_TYPE_MAP[snapshots.message];
  if (!eventType) return null;

  const spm = [snapshots.c1 ?? '', snapshots.c2 ?? ''].filter(Boolean).join('.');
  const exargs: Record<string, any> = {};
  if (typeof snapshots.c3 === 'string') {
    snapshots.c3.split('&').forEach((pair: string) => {
      const eqIndex = pair.indexOf('=');
      if (eqIndex === -1) return;
      const key = pair.slice(0, eqIndex);
      const rawValue = pair.slice(eqIndex + 1);
      try {
        exargs[key] = JSON.parse(decodeURIComponent(rawValue));
      } catch {
        exargs[key] = rawValue;
      }
    });
  }

  const dataAttrs = snapshots.trackerInfo?.dataAttrs;
  if (dataAttrs && typeof dataAttrs === 'object' && dataAttrs['data-biz-args'] && !exargs.bizArgs) {
    try {
      exargs.bizArgs = JSON.parse(dataAttrs['data-biz-args']);
    } catch {
      exargs.bizArgs = dataAttrs['data-biz-args'];
    }
  }

  return {
    ...base,
    event_type: eventType,
    name: spm,
    _raw: {
      ...event,
      expdata: [
        {
          spm,
          ...(Object.keys(exargs).length > 0 ? { exargs } : {}),
        },
      ],
      'spm-url': spm,
    },
  };
}

export function parseRumRequest(
  url: string,
  postData: string | Record<string, any> | null | undefined,
  options: TrackingParseOptions = {},
): RumEvent[] {
  if (!matchesTrackingHost(url, RUM_URL_PATTERN)) return [];

  const parsed = parseRumBody(postData);
  const rawEvents = Array.isArray(parsed?.events) ? parsed.events : [];
  if (rawEvents.length === 0) return [];

  const now = options.now ?? Date.now();
  const batchId = options.sequence ?? ++rumCounter;
  const context = {
    requestUrl: url,
    app: parsed?.app ?? {},
    user: parsed?.user ?? {},
    session: parsed?.session ?? {},
    view: parsed?.view ?? {},
    properties: parsed?.properties ?? {},
    os: parsed?.os ?? {},
    net: parsed?.net ?? {},
  };

  return rawEvents.flatMap((rawEvent: unknown, index: number) => {
    if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) return [];
    const event = rawEvent as Record<string, any>;
    const normalizedType = RUM_TYPE_ALIAS[event.type] ?? event.type;
    const base = {
      id: `${batchId}-${event.event_id ?? index}`,
      batchId,
      batchTimestampMs: now,
      batchTimestamp: formatTimestamp(now),
      type: normalizedType,
      url: event.url,
      timestamp: event.timestamp ?? now,
      success: event.success,
      status_code: event.status_code,
      method: event.method,
      duration: event.duration,
      source: 'rum' as const,
      _context: context,
    };
    const converted = tryConvertI18nTracker(event, base);
    if (converted) return [converted];

    return [
      {
        ...base,
        event_type: event.event_type ?? 'unknown',
        name: event.name,
        _raw: event,
      },
    ];
  });
}

// ─── ARMS parser ──────────────────────────────────────────────────────────────

export function parseArmsRequest(url: string, options: TrackingParseOptions = {}): RumEvent | null {
  if (!matchesTrackingHost(url, ARMS_URL_PATTERN)) return null;

  let urlObj: URL;
  try {
    urlObj = new URL(url);
  } catch {
    return null;
  }

  const params: Record<string, string> = {};
  urlObj.searchParams.forEach((value, key) => {
    params[key] = value;
  });

  const eventType = (params.t ?? 'unknown').toLowerCase();
  const page = params.page ?? '';
  const now = options.now ?? Date.now();
  const sequence = options.sequence ?? ++armsCounter;
  const parsedTimestamp = params.begin ? Number.parseInt(params.begin, 10) : now;
  const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : now;

  return {
    id: `arms-${sequence}-${now}`,
    source: 'arms',
    batchId: 0,
    batchTimestampMs: now,
    batchTimestamp: formatTimestamp(now),
    event_type: eventType,
    name: page || url,
    url,
    timestamp,
    _raw: { ...params, _url: url },
    _context: {
      requestUrl: url,
      app: {
        ...(params.pid ? { pid: params.pid } : {}),
        ...(params.release ? { release: params.release } : {}),
        ...(params.environment ? { environment: params.environment } : {}),
        ...(params._v ? { sdk_version: params._v } : {}),
      },
      user: {
        ...(params.uid ? { uid: params.uid } : {}),
      },
      session: {
        ...(params.sid ? { sid: params.sid } : {}),
      },
      view: {
        ...(page ? { page } : {}),
        ...(params.tag ? { tag: params.tag } : {}),
      },
      properties: {},
      os: {},
      net: {
        ...(params.ct ? { ct: params.ct } : {}),
      },
    },
  };
}

/** Parse any supported tracking request into zero or more normalized events. */
export function parseTrackingRequest(
  url: string,
  postData?: string | Record<string, any> | null,
  options: TrackingParseOptions = {},
): RumEvent[] {
  const rumEvents = parseRumRequest(url, postData, options);
  if (rumEvents.length > 0) return rumEvents;

  const aplusEvent = parseAplusRequest(url, options);
  if (aplusEvent) return [aplusEvent];

  const armsEvent = parseArmsRequest(url, options);
  return armsEvent ? [armsEvent] : [];
}
