/** Parse display query values without decoding JSON string literals twice. */
export const parseQueryString = (queryStr: string): Record<string, string> => {
  const params: Record<string, string> = {};
  if (!queryStr) return params;

  const pairs = queryStr.split('&');
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) {
      if (pair) params[pair] = '';
    } else {
      const key = pair.substring(0, eqIndex);
      const value = pair.substring(eqIndex + 1);
      if (key) {
        try {
          const isJsonValue =
            ((value.startsWith('{') && value.endsWith('}')) ||
              (value.startsWith('[') && value.endsWith(']'))) &&
            typeof JSON.parse(value) === 'object';
          params[key] = isJsonValue ? value : decodeURIComponent(value);
        } catch {
          params[key] = value;
        }
      }
    }
  }

  return params;
};
