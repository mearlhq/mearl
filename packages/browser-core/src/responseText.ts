/** Decodes JSON or a JSONP wrapper; other response text remains unchanged. */
export function parseJsonResponseText(text: string): unknown {
  try { return JSON.parse(text); }
  catch {
    const wrapper = text.match(/^[^(]*\((.*)\)\s*;?\s*$/s);
    if (!wrapper?.[1]) return text;
    try { return JSON.parse(wrapper[1]); } catch { return text; }
  }
}
