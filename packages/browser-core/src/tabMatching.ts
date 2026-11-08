export type TabReuseMode = 'never' | 'prefer' | 'require';
export type TabMultipleMatchBehavior = 'error' | 'first';

export interface TabMatchOptions {
  /** Full URL glob. `*` matches any number of characters. Defaults to the requested URL. */
  urlPattern?: string;
  ignoreSearch?: boolean;
  ignoreHash?: boolean;
  onMultiple?: TabMultipleMatchBehavior;
}

export interface TabMatchCandidate {
  url?: string;
}

function normalizeUrl(value: string, options: TabMatchOptions): string {
  try {
    const url = new URL(value);
    if (options.ignoreSearch) url.search = '';
    if (options.ignoreHash) url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function globPattern(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map(part => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

export function findMatchingTabs<T extends TabMatchCandidate>(
  tabs: T[],
  requestedUrl: string,
  options: TabMatchOptions = {},
): T[] {
  const normalizedPattern = options.urlPattern
    ? normalizeUrl(options.urlPattern, options)
    : normalizeUrl(requestedUrl, options);
  const matcher = options.urlPattern ? globPattern(normalizedPattern) : undefined;

  return tabs.filter(tab => {
    if (!tab.url) return false;
    const candidate = normalizeUrl(tab.url, options);
    return matcher ? matcher.test(candidate) : candidate === normalizedPattern;
  });
}

export function selectMatchingTab<T extends TabMatchCandidate>(
  tabs: T[],
  requestedUrl: string,
  options: TabMatchOptions = {},
): T | undefined {
  const matches = findMatchingTabs(tabs, requestedUrl, options);
  if (matches.length <= 1) return matches[0];
  if (options.onMultiple === 'first') return matches[0];
  throw new Error(
    `tab_open matched ${matches.length} existing tabs. Refine match.urlPattern or set match.onMultiple to "first".`,
  );
}
