globalThis.mearlFormatCodec = (() => {
  const MAX_BYTES = 8 * 1024 * 1024;
  const fail = code => { const error = new Error(code); error.code = code; throw error; };
  const bytesToBase64 = bytes => {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return btoa(binary);
  };
  const base64Bytes = value => {
    const normalized = value.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1 || (normalized.includes('=') && normalized.length % 4)) fail('INVALID_BASE64');
    let binary;
    try { binary = atob(normalized); } catch { fail('INVALID_BASE64'); }
    if (binary.length > MAX_BYTES) fail('TOO_LARGE');
    if (btoa(binary).replace(/=+$/, '') !== normalized.replace(/=+$/, '')) fail('INVALID_BASE64');
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  };
  const imageFromBytes = bytes => {
    if (!(bytes instanceof Uint8Array) || !bytes.length) fail('INVALID_IMAGE');
    if (bytes.length > MAX_BYTES) fail('TOO_LARGE');
    const starts = values => values.every((value, index) => bytes[index] === value);
    const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
    let mime;
    if (bytes.length >= 24 && starts([137, 80, 78, 71, 13, 10, 26, 10])) mime = 'image/png';
    else if (starts([255, 216, 255])) mime = 'image/jpeg';
    else if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) mime = 'image/gif';
    else if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') mime = 'image/webp';
    else fail('INVALID_IMAGE');
    const base64 = bytesToBase64(bytes), value = `data:${mime};base64,${base64}`;
    return { value, image: { mime, bytes: bytes.length, base64 } };
  };
  const imageFromText = value => {
    const trimmed = value.trim();
    if (!/^data:/i.test(trimmed)) return imageFromBytes(base64Bytes(trimmed));
    const match = trimmed.match(/^data:([^,]*);base64,([\s\S]*)$/i);
    if (!match) fail('INVALID_IMAGE');
    return imageFromBytes(base64Bytes(match[2]));
  };
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  function dateText(date, zone) {
    const get = part => date[`${zone === 'utc' ? 'getUTC' : 'get'}${part}`]();
    const year = get('FullYear');
    if (year < 0 || year > 9999) fail('INVALID_TIMESTAMP');
    return `${pad(year, 4)}-${pad(get('Month') + 1)}-${pad(get('Date'))} ${pad(get('Hours'))}:${pad(get('Minutes'))}:${pad(get('Seconds'))}.${pad(get('Milliseconds'), 3)}`;
  }
  function parseDate(value, zone) {
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/i);
    if (!match) fail('INVALID_DATE');
    const [, y, mo, d, h = '0', mi = '0', s = '0', fraction = '0', offset] = match;
    const parts = [+y, +mo - 1, +d, +h, +mi, +s, +(fraction.padEnd(3, '0'))];
    const date = new Date(0), utc = offset || zone === 'utc';
    date[utc ? 'setUTCFullYear' : 'setFullYear'](parts[0], parts[1], parts[2]);
    date[utc ? 'setUTCHours' : 'setHours'](...parts.slice(3));
    const get = part => date[`${utc ? 'getUTC' : 'get'}${part}`]();
    if (['FullYear', 'Month', 'Date', 'Hours', 'Minutes', 'Seconds', 'Milliseconds'].some((part, index) => get(part) !== parts[index])) fail('INVALID_DATE');
    if (offset && offset.toUpperCase() !== 'Z') {
      const digits = offset.slice(1).replace(':', ''), hours = +digits.slice(0, 2), minutes = +digits.slice(2);
      if (hours > 23 || minutes > 59) fail('INVALID_DATE');
      date.setTime(date.getTime() - (offset[0] === '+' ? 1 : -1) * (hours * 60 + minutes) * 60000);
    }
    return date;
  }
  function isUrl(value) {
    if (!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) return false;
    try { new URL(value, 'https://example.invalid'); return true; } catch { return false; }
  }
  function encodeUrl(value) {
    if (!isUrl(value)) return encodeURIComponent(value);
    // URL separators, IPv6 brackets and existing escapes carry structural meaning.
    return encodeURI(value).replace(/%25([a-f\d]{2})/gi, '%$1').replace(/%5B/gi, '[').replace(/%5D/gi, ']');
  }
  function convert(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['format', 'direction', 'value', 'unit', 'zone'].includes(key))) fail('INVALID_OPTIONS');
    const { format, direction, value, unit = 'auto', zone = 'local' } = input;
    if (!['timestamp', 'base64', 'image', 'url'].includes(format) || !['encode', 'decode'].includes(direction) || !['auto', 'seconds', 'milliseconds'].includes(unit) || !['local', 'utc'].includes(zone) || typeof value !== 'string') fail('INVALID_OPTIONS');
    if (value.length > MAX_BYTES * (format === 'url' && direction === 'decode' ? 3 : 1.5)) fail('TOO_LARGE');
    if (!value) return { value: '' };
    if (format === 'image') return imageFromText(value);
    if (format === 'base64') {
      if (direction === 'decode') {
        const bytes = base64Bytes(value);
        try { return { value: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }; } catch { fail('INVALID_UTF8'); }
      }
      const bytes = new TextEncoder().encode(value);
      if (bytes.length > MAX_BYTES) fail('TOO_LARGE');
      return { value: bytesToBase64(bytes) };
    }
    if (format === 'url') {
      let result;
      try { result = direction === 'encode' ? encodeUrl(value) : isUrl(value) ? decodeURI(value) : decodeURIComponent(value); } catch { fail('INVALID_URL'); }
      if (new TextEncoder().encode(direction === 'encode' ? value : result).length > MAX_BYTES) fail('TOO_LARGE');
      return { value: result };
    }
    if (direction === 'decode') {
      const numeric = value.trim();
      if (numeric.length > 24 || !/^-?\d+(?:\.\d{1,3})?$/.test(numeric)) fail('INVALID_TIMESTAMP');
      const timestamp = Number(numeric), detectedUnit = unit === 'auto' ? Math.abs(timestamp) < 1e11 ? 'seconds' : 'milliseconds' : unit;
      const [whole, fraction = ''] = numeric.split('.');
      const milliseconds = detectedUnit === 'seconds' ? Number(BigInt(whole) * 1000n + (numeric.startsWith('-') ? -1n : 1n) * BigInt(fraction.padEnd(3, '0'))) : timestamp;
      if (!Number.isSafeInteger(milliseconds) || Math.abs(milliseconds) > 8.64e15) fail('INVALID_TIMESTAMP');
      const date = new Date(milliseconds);
      return { value: dateText(date, zone), unit: detectedUnit, milliseconds, iso: date.toISOString(), offset: zone === 'utc' ? 0 : -date.getTimezoneOffset() };
    }
    const date = parseDate(value, zone), detectedUnit = unit === 'seconds' ? 'seconds' : 'milliseconds';
    return { value: String(date.getTime() / (detectedUnit === 'seconds' ? 1000 : 1)), unit: detectedUnit, milliseconds: date.getTime(), iso: date.toISOString(), offset: zone === 'utc' ? 0 : -date.getTimezoneOffset() };
  }
  function textResults(value) {
    return { kind: 'text', fields: [
      { id: 'base64', value: convert({ format: 'base64', direction: 'encode', value }).value },
      { id: 'url', value: convert({ format: 'url', direction: 'encode', value }).value },
    ] };
  }
  function analyze(input) {
    if (!input || Object.keys(input).some(key => !['value', 'zone'].includes(key)) || typeof input.value !== 'string' || !['local', 'utc'].includes(input.zone ?? 'local')) fail('INVALID_OPTIONS');
    const { value, zone = 'local' } = input, trimmed = value.trim();
    if (value.length > MAX_BYTES * 3) fail('TOO_LARGE');
    if (!value) return { kind: 'text', fields: [] };
    if (!trimmed) return textResults(value);
    if (/^-?(?:\d{9,13}(?:\.\d{1,3})?|0(?:\.\d{1,3})?|\d+\.\d{1,3})$/.test(trimmed)) {
      const result = convert({ format: 'timestamp', direction: 'decode', value, zone });
      return { kind: 'timestamp', fields: [{ id: 'date', value: result.value }], meta: result };
    }
    if (/^\d{4}-\d{2}-\d{2}(?:[T ]|$)/.test(trimmed)) {
      const result = convert({ format: 'timestamp', direction: 'encode', value, zone });
      return { kind: 'date', fields: [{ id: 'seconds', value: String(result.milliseconds / 1000) }, { id: 'milliseconds', value: result.value }], meta: result };
    }
    if (/^data:/i.test(trimmed)) {
      const result = imageFromText(trimmed);
      return { kind: 'image', fields: [], image: result.value, meta: result.image };
    }
    if (/%[a-f0-9]{2}/i.test(trimmed)) return { kind: 'url', fields: [{ id: 'text', value: convert({ format: 'url', direction: 'decode', value }).value }] };
    let bytes;
    try { bytes = base64Bytes(trimmed); } catch (error) { if (error.code === 'TOO_LARGE') throw error; }
    if (bytes?.length) {
      try {
        const result = imageFromBytes(bytes);
        return { kind: 'image', fields: [], image: result.value, meta: result.image };
      } catch (error) { if (error.code === 'TOO_LARGE') throw error; }
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        if (!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(decoded)) return { kind: 'base64', fields: [{ id: 'text', value: decoded }] };
      } catch { /* Unpadded words may also be plain text, so binary data needs stronger evidence. */ }
      if (/=\s*$/.test(trimmed)) fail('INVALID_UTF8');
    }
    return textResults(value);
  }
  function reverse({ kind, field, value, zone = 'local', unit = 'milliseconds' }) {
    if (typeof value !== 'string') fail('INVALID_OPTIONS');
    if (kind === 'text' && ['base64', 'url'].includes(field)) {
      const input = convert({ format: field, direction: 'decode', value }).value;
      return { input, analysis: textResults(input) };
    }
    if (['base64', 'url'].includes(kind) && field === 'text') {
      const input = convert({ format: kind, direction: 'encode', value }).value;
      return { input, analysis: { kind, fields: [{ id: field, value }] } };
    }
    if (kind === 'timestamp' && field === 'date') {
      const result = convert({ format: 'timestamp', direction: 'encode', value, zone, unit });
      return { input: result.value, analysis: { kind, fields: [{ id: field, value }], meta: result.value ? result : { unit } } };
    }
    if (kind === 'date' && ['seconds', 'milliseconds'].includes(field)) {
      const result = convert({ format: 'timestamp', direction: 'decode', value, zone, unit: field });
      return { input: result.value, analysis: result.value ? analyze({ value: result.value, zone }) : { kind, fields: [{ id: 'seconds', value: '' }, { id: 'milliseconds', value: '' }] } };
    }
    fail('INVALID_OPTIONS');
  }
  return { convert, analyze, reverse, imageFromBytes, MAX_BYTES };
})();
