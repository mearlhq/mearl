/** Markers carry translated labels; destinations remain in the document. */
export function createLinkMarkup() {
  const marker = (id, closing = false) => `[[${closing ? '/' : ''}mearl-link:${id}]]`;
  const source = item => {
    const segments = []; let offset = 0;
    const seen = new Set();
    if (item.links !== undefined && (!Array.isArray(item.links) || item.links.length > 64)) throw new Error('Invalid translation links');
    for (const link of item.links ?? []) {
      if (!link || !Number.isSafeInteger(link.id) || link.id < 0 || link.id >= 64 || seen.has(link.id) || !Number.isSafeInteger(link.start) || !Number.isSafeInteger(link.end) || link.start < offset || link.end <= link.start || link.end > item.text.length || !item.text.slice(link.start, link.end).trim()) throw new Error('Invalid translation link range');
      if (link.start > offset) segments.push({ text: item.text.slice(offset, link.start) });
      segments.push({ text: item.text.slice(link.start, link.end), id: link.id });
      seen.add(link.id); offset = link.end;
    }
    if (offset < item.text.length) segments.push({ text: item.text.slice(offset) });
    return segments;
  };
  const encode = item => source(item).map(segment => segment.id === undefined ? segment.text : marker(segment.id) + segment.text + marker(segment.id, true)).join('');
  const decode = (value, links) => {
    if (!links?.length) return [{ text: value }];
    const expected = new Set(links.map(link => link.id)), seen = new Set(), segments = [];
    const tokens = /\[\[(\/?)mearl-link:(\d+)\]\]/g;
    let offset = 0, active;
    for (const token of value.matchAll(tokens)) {
      const id = Number(token[2]);
      if (!expected.has(id)) return null;
      if (!token[1]) {
        if (active !== undefined || seen.has(id)) return null;
        if (token.index > offset) segments.push({ text: value.slice(offset, token.index) });
        active = id;
      } else {
        if (active !== id || !value.slice(offset, token.index).trim()) return null;
        segments.push({ id, text: value.slice(offset, token.index) }); seen.add(id); active = undefined;
      }
      offset = token.index + token[0].length;
    }
    if (active !== undefined || seen.size !== expected.size) return null;
    if (offset < value.length) segments.push({ text: value.slice(offset) });
    return segments;
  };
  return { source, encode, decode, marker };
}
