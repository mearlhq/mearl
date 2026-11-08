import { createLinkMarkup } from './links.mjs';

/** Native translation resources belong to the document and never call a remote fallback. */
export function createBrowserTranslation(onStatus = () => {}, linkMarkup = createLinkMarkup()) {
  const translators = new Map();
  let detector, disposed = false;
  const language = value => {
    if (typeof value !== 'string' || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value) || /^(und|mul|zxx)(-|$)/i.test(value)) return undefined;
    if (/^zh-(?:tw|hk|hant)/i.test(value)) return 'zh-Hant';
    return value.split('-')[0].toLowerCase();
  };
  const abortable = (promise, signal) => {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException('Translation cancelled', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  };
  const create = async (api, options, signal) => {
    const availability = await api.availability(options); signal.throwIfAborted();
    if (availability === 'unavailable') throw new Error('BROWSER_TRANSLATION_UNAVAILABLE');
    const start = () => api.create({ ...options, signal, monitor: monitor => monitor.addEventListener('downloadprogress', event => {
      onStatus({ status: 'downloading', progress: event.total > 0 ? event.loaded / event.total : event.loaded });
    }) });
    let resource;
    try { resource = await start(); }
    catch (error) {
      if (error.name !== 'NotAllowedError') throw error;
      // Chrome requires an interaction in this document before downloading a language pack.
      onStatus({ status: 'activation-required' });
      resource = await new Promise((resolve, reject) => {
        let starting = false;
        const clean = () => { document.removeEventListener('pointerdown', activate, true); document.removeEventListener('keydown', activate, true); signal.removeEventListener('abort', abort); };
        const abort = () => { clean(); reject(signal.reason ?? new DOMException('Translation cancelled', 'AbortError')); };
        const activate = () => {
          if (starting) return; starting = true;
          void start().then(value => { clean(); if (signal.aborted || disposed) { value.destroy(); reject(signal.reason ?? new Error('Browser translation disposed')); } else resolve(value); }, failure => { starting = false; if (failure.name !== 'NotAllowedError') { clean(); reject(failure); } });
        };
        document.addEventListener('pointerdown', activate, true); document.addEventListener('keydown', activate, true);
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      });
    }
    if (disposed || signal.aborted) { resource.destroy(); signal.throwIfAborted(); throw new Error('Browser translation disposed'); }
    onStatus({ status: 'ready' }); return resource;
  };
  const recoverable = error => ['UnknownError', 'OperationError', 'InvalidStateError', 'NotReadableError'].includes(error?.name);
  const destroy = resource => { if (resource) void resource.then(value => value.destroy()).catch(() => {}); };
  const detect = async (text, declared, signal) => {
    if (typeof globalThis.LanguageDetector?.create === 'function' && typeof globalThis.LanguageDetector?.availability === 'function') {
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            detector ??= create(globalThis.LanguageDetector, {}, signal).catch(error => { detector = undefined; throw error; });
            const value = await abortable(detector, signal), results = await abortable(value.detect(text, { signal }), signal);
            const detected = results.find(result => result.confidence >= (language(declared) ? .9 : .5) && language(result.detectedLanguage));
            if (detected) return language(detected.detectedLanguage);
            break;
          } catch (error) {
            destroy(detector); detector = undefined; signal.throwIfAborted();
            if (attempt || !recoverable(error)) throw error;
          }
        }
      } catch (error) { if (signal.aborted || error.message !== 'BROWSER_TRANSLATION_UNAVAILABLE' || !language(declared)) throw error; }
    }
    const fallback = language(declared);
    if (fallback) return fallback;
    throw new Error('BROWSER_TRANSLATION_LANGUAGE_UNKNOWN');
  };
  const translateProse = async (translator, item, signal) => {
    // Translate prose around code so native models cannot alter protected literals.
    const codes = [...new Set(item.codeLiterals ?? [])].sort((a, b) => b.length - a.length);
    let offset = 0, output = '';
    while (offset < item.text.length) {
      let found;
      for (const code of codes) { const index = item.text.indexOf(code, offset); if (index >= 0 && (!found || index < found.index)) found = { code, index }; }
      const prose = item.text.slice(offset, found?.index ?? item.text.length);
      if (/\p{L}/u.test(prose)) {
        const translated = await abortable(translator.translate(prose.trim(), { signal }), signal);
        if (typeof translated !== 'string' || !translated.trim()) throw new Error('BROWSER_TRANSLATION_EMPTY');
        output += (prose.match(/^\s*/)[0]) + translated + (prose.match(/\s*$/)[0]);
      } else output += prose;
      if (!found) break;
      output += found.code; offset = found.index + found.code.length;
    }
    if (!output.trim()) throw new Error('BROWSER_TRANSLATION_EMPTY');
    if (output.length > 12000) throw new Error('Browser translation exceeds the paragraph limit');
    return output;
  };
  const translateText = async (translator, item, signal) => {
    const segments = [];
    for (const segment of linkMarkup.source(item)) {
      const text = segment.text.trim() ? await translateProse(translator, { ...item, text: segment.text }, signal) : segment.text;
      segments.push(segment.id === undefined ? text : linkMarkup.marker(segment.id) + text + linkMarkup.marker(segment.id, true));
    }
    const output = segments.join('');
    if (output.length > 12000) throw new Error('Browser translation exceeds the paragraph limit');
    return output;
  };
  return {
    async translate(items, targetLang, signal, onResult = () => {}, needed = () => true) {
      if (disposed) throw new Error('Browser translation disposed');
      if (typeof globalThis.Translator?.create !== 'function' || typeof globalThis.Translator?.availability !== 'function') throw new Error('BROWSER_TRANSLATION_UNAVAILABLE');
      const targetLanguage = language(targetLang), translations = [], failures = [], skipped = [];
      for (const item of items) {
        signal.throwIfAborted();
        if (!needed(item)) { skipped.push(item.id); continue; }
        let text;
        try {
          const sourceLanguage = await detect(item.text, item.sourceLanguage, signal);
          text = linkMarkup.encode(item);
          if (sourceLanguage !== targetLanguage) {
            const key = `${sourceLanguage}:${targetLanguage}`;
            // A failed native session can remain unusable; retry once with a fresh resource.
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                if (!translators.has(key)) {
                  if (translators.size >= 8) { const oldest = translators.keys().next().value; destroy(translators.get(oldest)); translators.delete(oldest); }
                  translators.set(key, create(globalThis.Translator, { sourceLanguage, targetLanguage }, signal).catch(error => { translators.delete(key); throw error; }));
                }
                const translator = await abortable(translators.get(key), signal);
                text = await translateText(translator, item, signal);
                break;
              } catch (error) {
                destroy(translators.get(key)); translators.delete(key); signal.throwIfAborted();
                if (attempt || !recoverable(error)) throw error;
              }
            }
          }
        } catch (error) {
          signal.throwIfAborted();
          if (disposed || error.name === 'AbortError') throw error;
          failures.push({ id: item.id, error: String(error.message || error).slice(0, 500) });
          continue;
        }
        signal.throwIfAborted(); const result = { id: item.id, text }; translations.push(result); onResult(result);
      }
      return { translations, ...(failures.length ? { failures } : {}), ...(skipped.length ? { skipped } : {}) };
    },
    dispose() {
      disposed = true;
      for (const resource of [...translators.values(), ...(detector ? [detector] : [])]) void resource.then(value => value.destroy()).catch(() => {});
      translators.clear(); detector = undefined;
    },
  };
}
