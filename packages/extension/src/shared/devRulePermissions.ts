import type { StoredRuleForm } from './devRulesUtils';

export interface RulePermissionCheck {
  missingOrigins: string[];
  hasUnscopedRules: boolean;
}

function hostOrigin(host: string, subdomains = false, scheme = '*'): string | undefined {
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(host)) {
    return;
  }
  const wildcard = subdomains && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
  return `${scheme}://${wildcard ? '*.' : ''}${host.toLowerCase()}/*`;
}

/** Only expand literal host alternatives; arbitrary regexes must not become permission scopes. */
function regexHosts(authority: string, scheme: string): string[] | undefined {
  let hosts = [authority];
  while (hosts.some(host => host.includes('('))) {
    const expanded: string[] = [];
    for (const host of hosts) {
      const group = host.match(/\((?:\?:)?([^()]*)\)/);
      if (!group) {
        if (host.includes('(')) return;
        expanded.push(host);
        continue;
      }
      if (/^[?*+{]/.test(host.slice(group.index! + group[0].length))) return;
      expanded.push(...group[1].split('|').map(value => host.replace(group[0], value)));
      if (expanded.length > 32) return;
    }
    hosts = expanded;
  }
  const origins: string[] = [];
  for (const authority of hosts) {
    // Dots must be literal in a regex host. Ports do not restrict Chrome host permissions.
    const host = authority.replace(/:\d+$/, '');
    if (host.replace(/\\\./g, '').includes('.')) return;
    const origin = hostOrigin(host.replace(/\\\./g, '.'), false, scheme);
    if (!origin) return;
    origins.push(origin);
  }
  return origins;
}

function hasTopLevelAlternative(pattern: string): boolean {
  let depth = 0;
  let inCharacterClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '\\') {
      if (pattern[index + 1] === 'Q') return true;
      index++;
      continue;
    }
    if (inCharacterClass) {
      if (character === ']') inCharacterClass = false;
      continue;
    }
    if (character === '[') inCharacterClass = true;
    else if (character === '(') depth++;
    else if (character === ')') depth--;
    else if (character === '|' && depth === 0) return true;
  }
  return false;
}

function filterOrigins(form: StoredRuleForm): string[] | undefined {
  if (form.filterType === 'regexFilter') {
    const pattern = form.regexFilter.replace(/\\\//g, '/');
    const prefix = pattern.match(/^\^(?:\(\?:)?(https\?|https|http)\)?:\/\//);
    if (!prefix) return;
    const rest = pattern.slice(prefix[0].length);
    const boundary = rest.search(/\/|\(\?:\[/);
    if (boundary < 0) return;
    const tail = rest.slice(boundary);
    const token = tail.startsWith('(?:[/?]|$)')
      ? '(?:[/?]|$)'
      : tail.startsWith('/')
        ? '/'
        : undefined;
    if (!token || /^[?*{]/.test(tail.slice(token.length))) return;
    const scheme = prefix[1] === 'https?' ? '*' : prefix[1];
    return regexHosts(rest.slice(0, boundary), scheme);
  }
  const pattern = form.urlFilter;
  const domainAnchor = pattern.startsWith('||');
  const rest = domainAnchor ? pattern.slice(2) : pattern.replace(/^\|?(?:https?|\*):\/\//, '');
  if (!domainAnchor && rest === pattern) return;
  // The delimiter ensures example.com cannot also match example.company.
  const match = rest.match(/^(\*\.)?([^/:^|*]+)(?::\d+)?(?:[/^]|\|$)/);
  if (!match) return;
  const scheme = domainAnchor ? '*' : (pattern.match(/^\|?(https?|\*):\/\//)?.[1] ?? '*');
  const origin = hostOrigin(match[2], domainAnchor || Boolean(match[1]), scheme);
  return origin ? [origin] : undefined;
}

export async function checkDevRulePermissions(
  forms: StoredRuleForm[],
): Promise<RulePermissionCheck> {
  const origins = new Set<string>();
  let hasUnscopedRules = false;
  for (const form of forms) {
    if (form.enabled === false || !['redirect', 'modifyHeaders'].includes(form.actionType))
      continue;
    const filter = form.filterType === 'regexFilter' ? form.regexFilter : form.urlFilter;
    if (!filter.trim()) continue;
    const targets = filterOrigins(form);
    if (targets) targets.forEach(origin => origins.add(origin));
    if (
      !targets ||
      (form.filterType === 'urlFilter' && !filter.startsWith('|')) ||
      (form.filterType === 'regexFilter' && hasTopLevelAlternative(filter))
    ) {
      hasUnscopedRules = true;
    }
    if (
      !form.resourceTypes.length ||
      form.resourceTypes.some(type => !['main_frame', 'sub_frame'].includes(type))
    ) {
      for (const entry of form.initiatorDomains.split(/[,\n]/).filter(value => value.trim())) {
        const origin = hostOrigin(entry.trim().split('/')[0], true);
        if (origin) origins.add(origin);
        else hasUnscopedRules = true;
      }
    }
  }
  const scopes = [...origins];
  const granted = await Promise.all(
    scopes.map(origin => chrome.permissions.contains({ origins: [origin] })),
  );
  if (hasUnscopedRules && (await chrome.permissions.contains({ origins: ['<all_urls>'] }))) {
    hasUnscopedRules = false;
  }
  return { missingOrigins: scopes.filter((_, index) => !granted[index]), hasUnscopedRules };
}
