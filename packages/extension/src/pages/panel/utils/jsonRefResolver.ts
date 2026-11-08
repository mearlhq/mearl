/**
 * Resolve Fastjson-style `$ref` references inside an imported JSON value.
 *
 * Fastjson responses can deduplicate repeated
 * (and circular) object references and emits them as `{ "$ref": "$.a.b[0].c" }`
 * pointers. Imported mock data can be either the original server response
 * rooted at `model`, a client response rooted at `data`, or the unwrapped data
 * payload. The resolver treats `model` and `data` as equivalent wrapper names
 * when the exact path is absent, and can also resolve through an omitted
 * wrapper.
 *
 * Supported path grammar is the Fastjson subset of JSONPath:
 *   - `$`            the root
 *   - `.key`         object property access
 *   - `[index]`      array index
 *   e.g. `$.model.applyDetail`, `$.model.expense.deductDetails[0].oriExpense`
 *
 * Behaviour:
 *   - Exact paths take precedence over wrapper compatibility fallbacks.
 *   - Refs nested inside a resolved target are resolved too.
 *   - Circular references are broken by leaving the inner-most repeat as
 *     `null`, so the result is always a finite, JSON-serializable value.
 *   - A dangling ref is left untouched.
 */
export function resolveJsonRefs<T>(root: T): T {
  if (root == null || typeof root !== 'object') return root;

  const getByTokens = (tokens: string[]): unknown => {
    let cur: unknown = root;
    for (const token of tokens) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[token];
    }
    return cur;
  };

  const getByPath = (path: string): unknown => {
    if (path === '$') return root;
    const tokens = path.replace(/^\$/, '').match(/[^.[\]]+/g);
    if (!tokens) return undefined;

    const exact = getByTokens(tokens);
    if (exact !== undefined) return exact;

    const [wrapper, ...payloadTokens] = tokens;
    if (wrapper !== 'model' && wrapper !== 'data') return undefined;

    const alternateWrapper = wrapper === 'model' ? 'data' : 'model';
    const wrapped = getByTokens([alternateWrapper, ...payloadTokens]);
    if (wrapped !== undefined) return wrapped;

    return getByTokens(payloadTokens);
  };

  const isRefNode = (node: object): node is { $ref: string } => {
    const keys = Object.keys(node);
    return (
      keys.length === 1 &&
      keys[0] === '$ref' &&
      typeof (node as { $ref: unknown }).$ref === 'string'
    );
  };

  // `seen` tracks the ref paths in the current resolution chain so a cycle
  // terminates instead of recursing forever.
  const resolve = (node: unknown, seen: Set<string>): unknown => {
    if (Array.isArray(node)) {
      return node.map(item => resolve(item, seen));
    }
    if (node != null && typeof node === 'object') {
      if (isRefNode(node)) {
        const ref = node.$ref;
        if (seen.has(ref)) return null;
        const target = getByPath(ref);
        if (target === undefined) return node;
        return resolve(target, new Set(seen).add(ref));
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(node)) {
        out[key] = resolve((node as Record<string, unknown>)[key], seen);
      }
      return out;
    }
    return node;
  };

  return resolve(root, new Set()) as T;
}
