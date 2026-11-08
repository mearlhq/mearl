import { createLinkMarkup } from './links.mjs';
const linkMarkup = createLinkMarkup();

/** Frames complete translation objects in one pass; final JSON remains authoritative. */
export function translationStream() {
  let stage = 'prefix', prefix = '', object = '', depth = 0, quoted = false, escaped = false, bytes = 0;
  return delta => {
    bytes += delta.length;
    if (bytes > 128 * 1024) throw new Error('Translation stream exceeds its limit');
    const records = [];
    for (const char of delta) {
      if (stage === 'prefix') {
        prefix += char;
        if (prefix.length > 256) throw new Error('Invalid translation stream prefix');
        if (char === '[') {
          if (!/^\s*\{\s*"translations"\s*:\s*\[$/.test(prefix)) throw new Error('Invalid translation stream prefix');
          stage = 'entry';
        }
      } else if (stage === 'object') {
        object += char;
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '{' || char === '[') depth++;
        else if (char === '}' || char === ']') {
          if (--depth === 0) {
            records.push(JSON.parse(object)); object = ''; stage = 'separator';
          }
        }
      } else if (/\s/.test(char)) continue;
      else if ((stage === 'entry' || stage === 'next') && char === '{') {
        object = '{'; depth = 1; quoted = false; escaped = false; stage = 'object';
      } else if (stage === 'separator' && char === ',') stage = 'next';
      else if ((stage === 'entry' || stage === 'separator') && char === ']') stage = 'end';
      else if (stage === 'end' && char === '}') stage = 'closed';
      else throw new Error('Invalid translation stream structure');
    }
    return records;
  };
}


/** Provisional text is serialized to the page and never enters either translation cache. */
export function translationPreview(missing, send, signal) {
  const groupsById = new Map(missing.map(group => [group.item.id, group]));
  const previewIds = missing.flatMap(group => group.ids);
  let parse = translationStream(), seen = new Set(), index = 0, itemId, disabled = false, closed = false, confirmed = false, writeError;
  let writes = Promise.resolve();
  const enqueue = message => {
    writes = writes.then(async () => {
      if (writeError) return;
      signal.throwIfAborted();
      await send(message);
    }).catch(error => { writeError = error; });
  };
  const valid = item => {
    const group = groupsById.get(item?.id);
    return group && Object.keys(item).length === 2 && typeof item.text === 'string' && item.text.length <= 12000 && item.text.trim() && !group.item.codeLiterals?.some(code => !item.text.includes(code)) && Boolean(linkMarkup.decode(item.text, group.item.links));
  };
  const onProgress = progress => {
    if (closed || signal.aborted || writeError || progress?.message !== 'model.delta') return;
    const data = progress.data;
    if (!data || typeof data.delta !== 'string' || !Number.isSafeInteger(data.index)) return;
    if (data.itemId !== itemId) {
      if (seen.size) enqueue({ type: 'DISCARD', ids: previewIds });
      parse = translationStream(); seen = new Set(); disabled = false; itemId = data.itemId;
    }
    if (data.index !== index + 1) { disabled = true; enqueue({ type: 'DISCARD', ids: previewIds }); }
    index = data.index;
    if (data.phase === 'commentary' || disabled) return;
    try {
      const records = parse(data.delta);
      const items = [];
      for (const item of records) {
        if (!valid(item) || seen.has(item.id)) throw new Error('Invalid streamed translation');
        seen.add(item.id);
        items.push(...groupsById.get(item.id).ids.map(id => ({ id, text: item.text })));
      }
      if (items.length) enqueue({ type: 'PREVIEW', items });
    } catch {
      disabled = true;
      enqueue({ type: 'DISCARD', ids: previewIds });
    }
  };
  return {
    onProgress,
    async close() {
      closed = true;
      await writes;
      if (writeError) throw writeError;
    },
    confirm() { confirmed = true; },
    async finish() {
      closed = true;
      await writes;
      if (!confirmed) await send({ type: 'DISCARD', ids: previewIds }).catch(() => {});
    },
  };
}
