// Playwright/jQuery 私有伪类，原生 document.querySelector 不支持。
const UNSUPPORTED_NATIVE_SELECTOR_PSEUDOS = [
  ':has-text',
  ':text(',
  ':text-is(',
  ':text-matches(',
  ':visible',
  ':hidden',
  ':nth-match(',
  ':light(',
  ':above(',
  ':below(',
  ':near(',
  ':left-of(',
  ':right-of(',
  ':contains(',
];

export const INVALID_NATIVE_SELECTOR_HINT =
  'Only native CSS is supported (no Playwright extensions like :has-text/:visible). ' +
  'Use page_snapshot to get an "@eN" ref for complex matching.';

/**
 * Validates selectors accepted by page element actions before they reach
 * document.querySelector or the snapshot ref registry.
 */
export function validatePageElementSelector(
  selector: unknown,
  toolName: string,
): asserts selector is string {
  if (!selector || typeof selector !== 'string') {
    throw new Error(
      `${toolName}: "selector" must be a non-empty string. ` +
        `Pass a native CSS selector (e.g. "[aria-label='提交']") or a snapshot ref like "@e3". ` +
        `Note: the field name is "selector", not "ref".`,
    );
  }

  if (/^e\d+$/.test(selector)) {
    throw new Error(
      `${toolName}: selector "${selector}" looks like a snapshot ref but is missing the "@" prefix. ` +
        `Use "@${selector}" instead. If you don't have refs yet, call page_snapshot first.`,
    );
  }

  for (const pseudo of UNSUPPORTED_NATIVE_SELECTOR_PSEUDOS) {
    if (selector.includes(pseudo)) {
      throw new Error(
        `${toolName}: selector contains unsupported pseudo "${pseudo}". ` +
          `Only native CSS selectors are supported (no Playwright/jQuery extensions). ` +
          `For text-based matching, run page_snapshot and use the returned "@eN" ref. ` +
          `For attribute matching, prefer "[aria-label='...']", "[title='...']", "[data-testid='...']" etc.`,
      );
    }
  }
}
