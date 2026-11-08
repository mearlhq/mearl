export interface StructureOptions {
  maxDepth?: number;
  maxKeys?: number;
  arraySamples?: number;
  maxNodes?: number;
}

/** Describes a bounded sample of a value without invoking accessors or exposing leaf values. */
export function getStructure(data: unknown, options: StructureOptions = {}): unknown {
  const { maxDepth = 5, maxKeys = 50, arraySamples = 1, maxNodes = 2000 } = options;
  for (const [name, value, limit] of [
    ['maxDepth', maxDepth, 20],
    ['maxKeys', maxKeys, 1000],
    ['arraySamples', arraySamples, 20],
    ['maxNodes', maxNodes, 10000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > limit)
      throw new Error(`${name} must be an integer between 1 and ${limit}`);
  }
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > maxNodes) return '<max nodes reached>';
    if (depth >= maxDepth) return '<max depth reached>';
    if (value === null) return 'null';
    if (typeof value !== 'object') return typeof value;
    if (ancestors.has(value)) return '<circular>';
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (!value.length) return 'array[0]';
        const samples = Array.from({ length: Math.min(value.length, arraySamples) }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, index);
          return descriptor && 'value' in descriptor
            ? visit(descriptor.value, depth + 1)
            : descriptor
              ? '<accessor>'
              : 'undefined';
        });
        return {
          _type: `array[${value.length}]`,
          ...(arraySamples === 1 ? { _sample: samples[0] } : { _samples: samples }),
        };
      }
      const keys = Object.keys(value);
      const entries = keys.slice(0, maxKeys).map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        return [key, 'value' in descriptor ? visit(descriptor.value, depth + 1) : '<accessor>'];
      });
      if (keys.length > maxKeys) entries.push(['<truncated keys>', keys.length - maxKeys]);
      return Object.fromEntries(entries);
    } finally {
      ancestors.delete(value);
    }
  };
  return visit(data, 0);
}
