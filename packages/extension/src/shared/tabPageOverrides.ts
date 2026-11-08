export const TAB_PAGE_OVERRIDES_GET_ACTION = 'tabPageOverridesGet';
export const TAB_PAGE_OVERRIDES_SET_ACTION = 'tabPageOverridesSet';
export const TAB_PAGE_OVERRIDES_STORAGE_PREFIX = 'tabPageOverridesV1:';

export const TAB_CUSTOM_TIMEZONES = [
  '',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
] as const;

export type TabCustomTimezone = (typeof TAB_CUSTOM_TIMEZONES)[number];

const TAB_CUSTOM_TIMEZONE_SET = new Set<string>(TAB_CUSTOM_TIMEZONES);

export interface TabPageOverrides {
  customUserAgent: string;
  customUserAgentEnabled: boolean;
  customTimezone: TabCustomTimezone;
  customTime: number | null;
}

export const DEFAULT_TAB_PAGE_OVERRIDES: TabPageOverrides = {
  customUserAgent: '',
  customUserAgentEnabled: false,
  customTimezone: '',
  customTime: null,
};

export const tabPageOverridesStorageKey = (tabId: number): string =>
  `${TAB_PAGE_OVERRIDES_STORAGE_PREFIX}${tabId}`;

export function normalizeTabPageOverrides(value: unknown): TabPageOverrides {
  const candidate = (value ?? {}) as Partial<TabPageOverrides>;
  const customTime = candidate.customTime;
  return {
    customUserAgent: typeof candidate.customUserAgent === 'string' ? candidate.customUserAgent : '',
    customUserAgentEnabled: candidate.customUserAgentEnabled === true,
    customTimezone:
      typeof candidate.customTimezone === 'string' &&
      TAB_CUSTOM_TIMEZONE_SET.has(candidate.customTimezone)
        ? (candidate.customTimezone as TabCustomTimezone)
        : '',
    customTime: typeof customTime === 'number' && Number.isFinite(customTime) ? customTime : null,
  };
}

export interface TabPageOverridesResponse {
  success: boolean;
  overrides?: TabPageOverrides;
  error?: string;
}
