import type { AddRuleParams, RulesResult } from './browserActionProtocol.js';

const RESOURCE_TYPES = new Set(['main_frame', 'sub_frame', 'xmlhttprequest']);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export interface CompiledHeaderRule {
  actionType: 'modifyHeaders';
  filter: string;
  regex: RegExp;
  requestHeaders: Array<{ header: string; operation: 'set'; value: string }>;
  resourceTypes: string[];
  priority: number;
  description: string;
}

export interface StoredHeaderRule extends CompiledHeaderRule {
  ruleId: number;
  enabled: true;
}

/** Validate one modifyHeaders rule. Transports keep their own intercept session. */
export function compileHeaderRule(data: AddRuleParams, label = 'set_rule'): CompiledHeaderRule {
  if (data?.actionType !== 'modifyHeaders') {
    throw new Error(`${label} supports modifyHeaders request headers only`);
  }
  if (typeof data.filter !== 'string' || !data.filter.trim() || data.filter.length > 2048) {
    throw new Error(`${label} requires a non-empty regex filter (max 2048 characters)`);
  }
  let regex: RegExp;
  try {
    regex = new RegExp(data.filter);
  } catch {
    throw new Error(`${label} filter is not a valid regex`);
  }
  if (data.responseHeaders?.length || data.initiatorDomains) {
    throw new Error(`${label} does not support responseHeaders or initiatorDomains`);
  }
  if (!Array.isArray(data.requestHeaders) || data.requestHeaders.length === 0) {
    throw new Error(`${label} requires requestHeaders`);
  }
  const requestHeaders = data.requestHeaders.map(header => {
    if (
      !header ||
      typeof header.header !== 'string' ||
      !HEADER_NAME.test(header.header) ||
      header.operation !== 'set' ||
      typeof header.value !== 'string' ||
      /[\r\n\0]/.test(header.value)
    ) {
      throw new Error(
        `${label} supports request header set operations with valid names and values`,
      );
    }
    return { header: header.header, operation: 'set' as const, value: header.value };
  });
  const resourceTypes = data.resourceTypes ?? ['main_frame', 'sub_frame', 'xmlhttprequest'];
  if (
    !Array.isArray(resourceTypes) ||
    resourceTypes.length === 0 ||
    resourceTypes.some(type => !RESOURCE_TYPES.has(type))
  ) {
    throw new Error(`${label} supports main_frame, sub_frame, and xmlhttprequest resource types`);
  }
  const priority = data.priority ?? 1;
  if (!Number.isInteger(priority) || priority < 1) {
    throw new Error(`${label} priority must be a positive integer`);
  }
  return {
    actionType: 'modifyHeaders',
    filter: data.filter,
    regex,
    requestHeaders,
    resourceTypes: [...resourceTypes],
    priority,
    description: data.description ?? 'Rule added via MCP/Skill',
  };
}

/** Browser-session header rules. Matching is pure; the transport continues the request. */
export class HeaderRuleSet {
  private rules: StoredHeaderRule[] = [];
  private nextRuleId = 1;

  get size(): number {
    return this.rules.length;
  }

  add(data: AddRuleParams, label = 'set_rule') {
    const rule: StoredHeaderRule = {
      ...compileHeaderRule(data, label),
      ruleId: this.nextRuleId++,
      enabled: true,
    };
    this.rules.push(rule);
    return {
      success: true,
      ruleId: rule.ruleId,
      affectedCount: 1,
      message: `Rule #${rule.ruleId} added for the current browser session.`,
    };
  }

  remove(ruleId: number, label = 'set_rule') {
    if (!Number.isSafeInteger(ruleId) || ruleId < 1) {
      throw new Error(`${label} requires a positive integer ruleId when enabled is false`);
    }
    const index = this.rules.findIndex(rule => rule.ruleId === ruleId);
    if (index < 0)
      return { success: true, ruleId, affectedCount: 0, message: `Rule #${ruleId} not found.` };
    this.rules.splice(index, 1);
    return { success: true, ruleId, affectedCount: 1, message: `Rule #${ruleId} removed.` };
  }

  list(): RulesResult {
    return {
      enabled: true,
      rules: this.rules.map(({ regex: _regex, ...rule }) => ({ ...rule })),
    };
  }

  /** Return the replacement header list when at least one rule matches. */
  apply(
    url: string,
    resourceType: string,
    headers: ReadonlyArray<{ name: string; value: string }>,
  ): Array<{ name: string; value: string }> | undefined {
    const matched = this.rules
      .filter(rule => rule.resourceTypes.includes(resourceType) && rule.regex.test(url))
      .sort((left, right) => left.priority - right.priority || left.ruleId - right.ruleId);
    if (!matched.length) return undefined;
    const next = new Map<string, { name: string; value: string }>();
    for (const header of headers)
      next.set(header.name.toLowerCase(), { name: header.name, value: header.value });
    for (const rule of matched) {
      for (const header of rule.requestHeaders) {
        next.set(header.header.toLowerCase(), { name: header.header, value: header.value });
      }
    }
    return [...next.values()];
  }
}
