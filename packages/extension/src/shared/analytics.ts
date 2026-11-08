import { getExtensionVersion } from './extensionVersion';
declare const __MEARL_BUILD_CHANNEL__: string;

const MEASUREMENT_ID = import.meta.env.VITE_MEARL_ANALYTICS_ID as string | undefined;
const API_SECRET = import.meta.env.VITE_MEARL_ANALYTICS_SECRET as string | undefined;
const ENDPOINT = MEASUREMENT_ID && API_SECRET ? `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(MEASUREMENT_ID)}&api_secret=${encodeURIComponent(API_SECRET)}` : undefined;

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const PAGE_ORIGIN = 'https://mearl-extension.local';
const CLIENT_ID_PATTERN = /^\d+\.\d+$/;
const BUILD_CHANNEL =
  typeof __MEARL_BUILD_CHANNEL__ !== 'undefined' ? __MEARL_BUILD_CHANNEL__ : 'development';

type AnalyticsParams = Record<string, string | number | boolean>;

interface TrackEventOptions {
  engagementTime?: number;
  includeEngagement?: boolean;
}

// --- Client ID (persistent, shared across all extension pages) ---

let clientIdCache: string | null = null;

function createClientId(seed: string = crypto.randomUUID()): string {
  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < seed.length; index++) {
    const code = seed.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619) >>> 0;
    second = Math.imul(second ^ code, 3266489917) >>> 0;
  }
  return `${first || 1}.${second || 1}`;
}

export async function getAnalyticsClientId(): Promise<string> {
  if (clientIdCache) return clientIdCache;
  const { ga_client_id } = await chrome.storage.local.get('ga_client_id');
  if (typeof ga_client_id === 'string' && CLIENT_ID_PATTERN.test(ga_client_id)) {
    clientIdCache = ga_client_id;
    return ga_client_id;
  }
  const id = createClientId(typeof ga_client_id === 'string' ? ga_client_id : undefined);
  await chrome.storage.local.set({ ga_client_id: id });
  clientIdCache = id;
  return id;
}

// --- Session management (shared across pages, 30min inactivity timeout) ---

interface StoredSession {
  id: string;
  timestamp: number;
}

async function getOrCreateSession(): Promise<string> {
  const now = Date.now();
  const { ga_session } = await chrome.storage.session.get('ga_session');

  if (ga_session) {
    const data = ga_session as StoredSession;
    if (now - data.timestamp < SESSION_TIMEOUT_MS) {
      await chrome.storage.session.set({ ga_session: { id: data.id, timestamp: now } });
      return data.id;
    }
  }

  const newSession: StoredSession = { id: String(now), timestamp: now };
  await chrome.storage.session.set({ ga_session: newSession });
  return newSession.id;
}

// --- Engagement time tracking (visibility-based, per page) ---

let engagementStart = 0;
let accumulatedEngagement = 0;
let isVisible = false;
let engagementTrackingStarted = false;
let pageContext: AnalyticsParams = {};

function pauseEngagementTimer() {
  if (isVisible) {
    accumulatedEngagement += Date.now() - engagementStart;
  }
  isVisible = false;
}

function resumeEngagementTimer() {
  engagementStart = Date.now();
  isVisible = true;
}

function startEngagementTimer(page: string) {
  pageContext = {
    page_title: page,
    page_location: `${PAGE_ORIGIN}/${encodeURIComponent(page)}`,
  };
  if (engagementTrackingStarted) return;

  engagementTrackingStarted = true;
  engagementStart = Date.now();
  isVisible = document.visibilityState === 'visible';

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      resumeEngagementTimer();
    } else {
      pauseEngagementTimer();
      flushPageEngagement();
    }
  });

  window.addEventListener('pagehide', () => {
    pauseEngagementTimer();
    flushPageEngagement();
  });
}

function consumeEngagementTime(): number {
  if (!engagementTrackingStarted) return 0;

  let total = accumulatedEngagement;
  if (isVisible) {
    total += Date.now() - engagementStart;
  }
  accumulatedEngagement = 0;
  engagementStart = Date.now();
  return Math.max(total, 0);
}

function flushPageEngagement() {
  const engagementTime = consumeEngagementTime();
  if (engagementTime <= 0) return;
  void trackEvent('page_engagement', undefined, {
    engagementTime,
    includeEngagement: false,
  });
}

// --- Event sending ---

export async function trackEvent(
  name: string,
  params?: AnalyticsParams,
  options: TrackEventOptions = {},
) {
  if (!ENDPOINT) return;
  try {
    const engagementTime =
      options.engagementTime ?? (options.includeEngagement === false ? 0 : consumeEngagementTime());
    const [clientId, sessionId] = await Promise.all([getAnalyticsClientId(), getOrCreateSession()]);

    const commonParams: AnalyticsParams = {
      session_id: sessionId,
      mearl_version: getExtensionVersion(),
      runtime: 'extension',
      build_channel: BUILD_CHANNEL,
    };

    const eventParams = { ...pageContext, ...params, ...commonParams };
    delete eventParams.engagement_time_msec;
    if (engagementTime > 0) eventParams.engagement_time_msec = engagementTime;

    const payload = {
      client_id: clientId,
      events: [{ name, params: eventParams }],
    };

    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch {
    // Analytics is best-effort and must never affect product behavior.
  }
}

// --- Page initialization (replaces gtag.js auto page_view) ---

export function initAnalytics(page: string) {
  startEngagementTimer(page);
  return trackEvent('page_view', undefined, { includeEngagement: false });
}

export function sanitizeAnalyticsText(value: string, maxLength: number): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b(Bearer\s+)[A-Z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(
      /((?:access[_-]?token|token|authorization|cookie|password|passwd|secret|api[_-]?key)["']?\s*[:=]\s*["']?)[^"',;\s}&]+/gi,
      '$1[redacted]',
    )
    .replace(/([?&][^=\s&]+)=([^&#\s]+)/g, '$1=[redacted]')
    .replace(/(https?:\/\/[^\s#]+)#[^\s)]*/g, '$1#[redacted]')
    .replace(/\/Users\/[^/\s]+/g, '/Users/[user]')
    .replace(/C:\\Users\\[^\\\s]+/gi, 'C:\\Users\\[user]')
    .slice(0, maxLength);
}
