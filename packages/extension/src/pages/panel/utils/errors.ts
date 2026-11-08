function readErrorProperty(value: object, key: 'message' | 'name' | 'stack'): string {
  try {
    const property = (value as Record<string, unknown>)[key];
    return typeof property === 'string' ? property.trim() : '';
  } catch {
    return '';
  }
}

function stringifyObject(value: object): string {
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (_key, nestedValue: unknown) => {
      if (typeof nestedValue === 'bigint') return `${nestedValue}n`;
      if (!nestedValue || typeof nestedValue !== 'object') return nestedValue;
      if (seen.has(nestedValue)) return '[Circular]';
      seen.add(nestedValue);
      return nestedValue;
    });
    if (json) return json;
  } catch {
    // Fall through to a type-based description when the value cannot be serialized.
  }

  try {
    const stringValue = String(value);
    if (stringValue !== '[object Object]') return stringValue;
  } catch {
    // Fall through to the stable fallback below.
  }

  return 'Unknown object error';
}

export function formatUnknownError(value: unknown): string {
  if (value instanceof Error) return value.message || value.name || 'Unknown error';

  if (value && typeof value === 'object') {
    return readErrorProperty(value, 'message') || stringifyObject(value);
  }

  if (typeof value === 'string') return value || 'Unknown error';
  if (value === undefined) return 'Unknown error';
  return String(value);
}

export function toError(value: unknown): Error {
  if (value instanceof Error) return value;

  const error = new Error(formatUnknownError(value));
  if (value && typeof value === 'object') {
    const name = readErrorProperty(value, 'name');
    const stack = readErrorProperty(value, 'stack');
    if (name) error.name = name;
    if (stack) error.stack = stack;
  }
  return error;
}
