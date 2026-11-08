/**
 * 在 CDP `Accessibility.getFullAXTree` 的输出里按可见文本（AX name）定位元素。
 * extension 与 native-host 共用，避免 page_click `text` 分支两边实现飘移。
 */

export interface AXTextMatchNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  backendDOMNodeId?: number;
}

export interface AXTextMatchOptions {
  text: string;
  /** 限定 AX role 消歧（如 "button"、"link"）。 */
  role?: string;
  /** 默认 true（精确匹配）；false 时按子串匹配。 */
  exact?: boolean;
}

export interface AXTextMatchHit {
  backendNodeId: number;
  role: string;
  name: string;
}

export interface AXTextMatchResult {
  hits: AXTextMatchHit[];
}

const DEFAULT_EXACT = true;

export function matchAXNodesByText(
  nodes: AXTextMatchNode[],
  options: AXTextMatchOptions,
): AXTextMatchResult {
  const { text, role, exact = DEFAULT_EXACT } = options;
  if (typeof text !== 'string' || text.length === 0) {
    return { hits: [] };
  }

  const hits: AXTextMatchHit[] = [];
  for (const node of nodes) {
    if (node.ignored) continue;
    if (node.backendDOMNodeId === undefined) continue;
    const name = node.name?.value;
    if (typeof name !== 'string' || name.length === 0) continue;

    const matched = exact ? name === text : name.includes(text);
    if (!matched) continue;

    const nodeRole = node.role?.value ?? '';
    if (role && nodeRole !== role) continue;

    hits.push({
      backendNodeId: node.backendDOMNodeId,
      role: nodeRole,
      name,
    });
  }

  return { hits };
}

/** 把多匹配候选格式化为面向 agent 的提示行。 */
export function formatAXTextMatchCandidates(hits: AXTextMatchHit[], limit = 5): string {
  return hits
    .slice(0, limit)
    .map((hit, idx) => {
      const name = hit.name.length > 60 ? `${hit.name.slice(0, 60)}…` : hit.name;
      const role = hit.role || '(no-role)';
      return `  ${idx + 1}. ${role} "${name}"`;
    })
    .join('\n');
}
