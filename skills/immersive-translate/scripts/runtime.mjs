import { createLinkMarkup } from './links.mjs';

/** The document owns text identities and rendering; background commands own translation. */
export function installTranslation(host, createBrowserTranslation, createFloatingSwitch, linkMarkup = createLinkMarkup()) {
  const blockSelector = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,td,th,dd,dt';
  const ownedSelector = '[data-mearl-translation],[data-mearl-translation-loading],[data-mearl-translation-floating]';
  const excluded = 'script,style,noscript,template,svg,pre,input,textarea,select,button,summary,footer,[hidden],[aria-hidden="true"],[inert],[role="banner"],[role="menu"],[role="toolbar"],[role="tooltip"],[role="button"],[role="tab"],[role="menuitem"],[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,' + ownedSelector;
  const navigation = 'nav,[role="navigation"]', readingRoot = 'main,article,aside,[role="main"],[role="complementary"]';
  const heading = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
  let contentsLinks = new Set();
  const ignored = element => !element || Boolean(element.closest(excluded)) || Boolean(element.closest(navigation) && !contentsLinks.has(element.closest('a[href]')));
  const concealedSource = new WeakSet();
  let sourceVisibility = new WeakMap();
  const sourceAppearance = element => {
    if (!element) return { hidden: false, invisible: false };
    if (sourceVisibility.has(element)) return sourceVisibility.get(element);
    const style = getComputedStyle(element), parent = sourceAppearance(element.parentElement);
    const clip = style.clip !== 'auto' ? style.clip?.match(/-?\d*\.?\d+/g)?.map(Number) : null;
    const positioned = ['absolute','fixed'].includes(style.position);
    const clipped = positioned && (clip?.length === 4 && (clip[0] >= clip[2] || clip[3] >= clip[1]) || style.clipPath?.startsWith('inset(50%') || parseFloat(style.width) <= 1 && parseFloat(style.height) <= 1 && ['hidden','clip'].includes(style.overflow));
    const result = {
      hidden: parent.hidden || !concealedSource.has(element) && style.display === 'none' || style.contentVisibility === 'hidden' || clipped || style.opacity === '0',
      invisible: ['hidden','collapse'].includes(style.visibility) || style.fontSize === '0px',
    };
    sourceVisibility.set(element, result); return result;
  };
  const readable = element => { if (ignored(element)) return false; const appearance = sourceAppearance(element); return !appearance.hidden && !appearance.invisible; };
  const blocks = new Map(), parts = new Map();
  let observed = new Set(), candidates = [], dirty = true;
  const memory = new Map(); let memoryBytes = 0;
  const memoryKey = (part, lane = engine) => JSON.stringify([targetLang, lane === 'browser' ? ['browser', part.sourceLanguage] : model || 'default', part.text, part.codeLiterals, part.links]);
  const remember = (part, lane = engine) => {
    const output = lane === 'browser' && engine === 'auto' ? part.fallback.output : part.output;
    const key = memoryKey(part, lane), previous = memory.get(key);
    if (previous) memoryBytes -= previous.bytes;
    memory.delete(key);
    const bytes = (key.length + output.length) * 2;
    if (bytes > 2 * 1024 * 1024) return;
    memory.set(key, { text: output, bytes, expires: Date.now() + 7 * 86400000 }); memoryBytes += bytes;
    while (memory.size > 512 || memoryBytes > 2 * 1024 * 1024) { const oldest = memory.keys().next().value; memoryBytes -= memory.get(oldest).bytes; memory.delete(oldest); }
  };
  let enabled = false, disposed = false, generation = 0, sequence = 0;
  let targetLang = 'zh-CN', maxParagraphs = 200, mode = 'bilingual', model, reasoningEffort = 'low', engine = 'codex';
  let browserTranslation, browserState, browserJob, browserController = new AbortController();
  let busy = false, announced = false, cacheAnnounced = false, error = null, timer, loadingTimer, url = location.href;
  let quickBusy = false, quickAnnounced = false, quickBatches = 0, codexError = null, browserError = null;
  let floatingSwitch;
  const lanePart = (part, lane) => engine === 'auto' && lane === 'browser' ? part.fallback : part;
  const nativeNeeded = part => document.visibilityState !== 'hidden' && parts.get(part.id) === part && part.state !== 'done' && !part.fallback?.output && inViewport(part.block.element) && text(part.block.element) === part.block.source;
  const cancelBrowserJob = () => { if (engine === 'auto' && browserJob && !browserJob.ids.some(id => { const part = parts.get(id); return part && nativeNeeded(part); })) browserJob.controller.abort(); };
  let batches = 0, skipped = 0, detected = 0, limited = 0, deferred = 0;
  const text = element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, { acceptNode: node => readable(node.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
    let value = '', node;
    while ((node = walker.nextNode())) value += node.textContent;
    return value.replace(/\s+/g, ' ').trim();
  };
  const linkedSource = element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, { acceptNode: node => readable(node.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
    const anchors = [], ranges = []; let value = '', node;
    while ((node = walker.nextNode())) {
      let chunk = node.textContent.replace(/\s+/g, ' ');
      if (!value) chunk = chunk.trimStart(); else if (value.endsWith(' ')) chunk = chunk.replace(/^ /, '');
      const start = value.length; value += chunk;
      const anchor = node.parentElement.closest('a[href]');
      if (!anchor || anchor === element || !element.contains(anchor) || anchor.closest('code') || !chunk.trim()) continue;
      try { if (!['http:', 'https:', 'mailto:', 'tel:', 'ftp:'].includes(new URL(anchor.getAttribute('href'), document.baseURI).protocol)) continue; } catch { continue; }
      if (!anchors.includes(anchor)) anchors.push(anchor);
      const id = anchors.indexOf(anchor), previous = ranges.at(-1);
      if (previous?.id === id && !value.slice(previous.end, start).trim()) previous.end = value.length;
      else ranges.push({ id, start, end: value.length });
    }
    value = value.trimEnd();
    return { anchors, ranges: ranges.map(range => ({ ...range, end: Math.min(range.end, value.length) })) };
  };
  const codeLiterals = element => [...element.querySelectorAll('code')]
    .filter(node => readable(node))
    .map(node => ({ node, text: node.textContent.replace(/\s+/g, ' ').trim() }))
    .filter(code => code.text);
  const visible = element => {
    if (!element.isConnected || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const inViewport = element => { const rect = element.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight; };
  const nearViewport = element => { const rect = element.getBoundingClientRect(); return visible(element) && rect.bottom > 0 && rect.top < innerHeight * 2; };
  const complete = block => block.parts.every(part => part.state === 'done' || part.fallback?.state === 'done');
  const failed = block => !complete(block) && block.parts.some(part => engine === 'auto' ? part.state !== 'done' && part.fallback?.state !== 'done' && (part.state === 'error' || codexError) && (part.fallback?.state === 'error' || browserError) : part.state === 'error');
  const displayed = part => part.state === 'done' ? part.output : part.fallback?.output ?? part.preview ?? part.fallback?.preview;
  const renderable = block => block.parts.every(part => displayed(part) !== undefined);
  const removeLoading = block => {
    block.loadingAnimation?.cancel(); block.loading?.remove();
    block.loading = null; block.loadingAnimation = null;
  };
  const updateLoading = () => {
    sourceVisibility = new WeakMap();
    clearTimeout(loadingTimer);
    let delay = Infinity;
    for (const block of blocks.values()) {
      const inflight = !renderable(block) && !complete(block) && !failed(block) && block.parts.some(part => ['pending', 'inflight'].includes(part.state) || engine === 'auto' && ['pending', 'inflight'].includes(part.fallback.state));
      if (inflight) block.loadingSince ??= Date.now(); else block.loadingSince = undefined;
      if (!enabled || disposed || mode === 'original' || error || !inflight || !visible(block.element) || text(block.element) !== block.source) { removeLoading(block); continue; }
      const remaining = 180 - (Date.now() - block.loadingSince);
      // One shared delay avoids flashing indicators for cache hits.
      if (remaining > 0) { delay = Math.min(delay, remaining); continue; }
      const walker = document.createTreeWalker(block.element, NodeFilter.SHOW_TEXT, { acceptNode: node => node.textContent.trim() && readable(node.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
      let label, node;
      while ((node = walker.nextNode())) label = node.parentElement;
      if (!label) { removeLoading(block); continue; }
      if (!block.loading) {
        const indicator = document.createElement('span'); indicator.dataset.mearlTranslationLoading = host.identity.instanceId;
        indicator.setAttribute('aria-hidden', 'true');
        indicator.style.cssText = 'display:inline-block;width:.65em;height:.65em;max-width:10px;max-height:10px;margin-inline-start:.4em;vertical-align:-.05em;box-sizing:border-box;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;color:light-dark(#155dfc, #51a2ff);pointer-events:none;flex-shrink:0';
        block.loading = indicator;
        if (typeof indicator.animate === 'function' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) block.loadingAnimation = indicator.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 850, iterations: Infinity });
      }
      if (block.loading.parentElement !== label) label.append(block.loading);
    }
    if (delay < Infinity) loadingTimer = setTimeout(updateLoading, delay);
  };
  const summary = () => {
    const values = [...blocks.values()];
    const failures = values.filter(failed);
    const pending = values.filter(block => !complete(block) && !failed(block) && block.parts.some(part => ['pending', 'inflight'].includes(part.state) || engine === 'auto' && ['pending', 'inflight'].includes(part.fallback.state))).length;
    return { enabled, generation, url: location.href, title: document.title, targetLang, maxParagraphs, mode, model, reasoningEffort, engine, browserState,
      paragraphs: blocks.size, detected, translated: values.filter(complete).length, pending,
      cached: values.filter(block => complete(block) && block.parts.every(part => part.state === 'done' ? part.cached : part.fallback?.cached)).length,
      batches, skipped, limited, deferred, busy: busy || quickBusy, error,
      ...(engine === 'auto' ? { refined: values.filter(block => block.parts.every(part => part.state === 'done')).length, refining: values.filter(block => !codexError && block.parts.some(part => ['pending','inflight'].includes(part.state))).length, warning: codexError || browserError, warningEngine: codexError ? 'codex' : browserError ? 'browser' : undefined, quickBatches } : {}), failed: failures.length, failureError: failures[0]?.parts.find(part => part.state === 'error')?.error,
      status: !enabled ? 'idle' : error ? 'error' : engine === 'auto' && document.visibilityState === 'hidden' ? 'paused' : pending ? busy || quickBusy ? 'translating' : 'queued' : engine === 'auto' && !codexError && values.some(block => block.parts.some(part => ['pending','inflight'].includes(part.state))) ? 'refining' : busy || quickBusy ? 'translating' : failures.length ? 'partial' : !blocks.size && !detected ? 'empty' : limited ? 'limited' : 'watching' };
  };
  const sameLanguage = (element, value) => {
    const primary = targetLang.split('-')[0], declared = element.closest('[lang]')?.lang?.split('-')[0];
    if (declared === primary) return true;
    if (primary !== 'zh' || /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)) return false;
    const letters = value.match(/\p{L}/gu)?.length ?? 0;
    return letters > 0 && (value.match(/\p{Script=Han}/gu)?.length ?? 0) / letters > 0.65;
  };
  const split = (value, codes = []) => {
    const chunks = [];
    while (value.length > 1600) {
      let end = value.lastIndexOf(' ', 1600);
      if (end < 800) end = 1600;
      for (const code of codes) {
        const index = value.lastIndexOf(code.text, end - 1);
        if (index >= 0 && index + code.text.length > end) end = index || code.text.length;
      }
      if (/[\uD800-\uDBFF]/.test(value[end - 1])) end--;
      chunks.push(value.slice(0, end)); value = value.slice(end);
    }
    if (value) chunks.push(value);
    return chunks;
  };
  const restoreLayout = block => {
    const change = block.layout;
    if (!change) return;
    const style = block.element.style;
    if (style.getPropertyValue('flex-wrap') === 'wrap' && style.getPropertyPriority('flex-wrap') === 'important') {
      if (change.value) style.setProperty('flex-wrap', change.value, change.priority);
      else style.removeProperty('flex-wrap');
    }
    block.layout = null;
  };
  const restoreClamping = block => {
    if (!block.clamping) return;
    const style = block.element.style;
    if (style.getPropertyValue('-webkit-line-clamp') === 'none' && style.getPropertyPriority('-webkit-line-clamp') === 'important') {
      if (block.clamping.value) style.setProperty('-webkit-line-clamp', block.clamping.value, block.clamping.priority);
      else style.removeProperty('-webkit-line-clamp');
    }
    block.clamping = null;
  };
  const restoreSource = block => {
    for (const [element, saved] of block.hiddenSource ?? []) {
      concealedSource.delete(element);
      if (element.style.getPropertyValue('display') === 'none' && element.style.getPropertyPriority('display') === 'important') {
        if (saved.value) element.style.setProperty('display', saved.value, saved.priority);
        else element.style.removeProperty('display');
      }
    }
    block.hiddenSource?.clear();
    for (const wrapper of block.sourceText ?? []) { concealedSource.delete(wrapper); wrapper.replaceWith(...wrapper.childNodes); }
    block.sourceText?.clear();
  };
  const hideSource = block => {
    block.hiddenSource ??= new Map(); block.sourceText ??= new Set();
    for (const child of [...block.element.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
        // Preserve text node identities so switching modes can restore the original DOM.
        const wrapper = document.createElement('span'); wrapper.dataset.mearlTranslationSource = host.identity.instanceId;
        child.replaceWith(wrapper); wrapper.append(child); wrapper.style.setProperty('display', 'none', 'important');
        block.sourceText.add(wrapper); concealedSource.add(wrapper);
      } else if (child.nodeType === Node.ELEMENT_NODE && !child.matches(ownedSelector) && !block.sourceText.has(child) && (text(child) || child.matches('br,wbr'))) {
        if (block.hiddenSource.has(child) && child.style.getPropertyValue('display') === 'none' && child.style.getPropertyPriority('display') === 'important') continue;
        block.hiddenSource.set(child, { value: child.style.getPropertyValue('display'), priority: child.style.getPropertyPriority('display') });
        concealedSource.add(child);
        child.style.setProperty('display', 'none', 'important');
      }
    }
  };
  const place = block => {
    const node = block.node, element = block.element, style = getComputedStyle(element);
    const flex = ['flex', 'inline-flex'].includes(style.display), grid = ['grid', 'inline-grid'].includes(style.display);
    const row = flex && !style.flexDirection.startsWith('column');
    if (mode === 'original') restoreClamping(block);
    else if (parseInt(style.getPropertyValue('-webkit-line-clamp')) > 0) {
      block.clamping = { value: element.style.getPropertyValue('-webkit-line-clamp'), priority: element.style.getPropertyPriority('-webkit-line-clamp') };
      // A line clamp must allow room for both the source and its translation.
      element.style.setProperty('-webkit-line-clamp', 'none', 'important');
    }
    if (!row || mode !== 'bilingual') restoreLayout(block);
    else if (style.flexWrap !== 'wrap') {
      block.layout = { value: element.style.getPropertyValue('flex-wrap'), priority: element.style.getPropertyPriority('flex-wrap') };
      // A full-width flex item needs wrapping to occupy a separate translation row.
      element.style.setProperty('flex-wrap', 'wrap', 'important');
    }
    node.style.flex = row ? '0 0 100%' : '';
    node.style.width = row ? '100%' : '';
    node.style.minWidth = flex || grid ? '0' : '';
    node.style.gridColumn = grid ? '1 / -1' : '';
    const walker = flex || grid ? document.createTreeWalker(element, NodeFilter.SHOW_TEXT, { acceptNode: node => node.textContent.trim() && readable(node.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT }) : null;
    const label = walker?.nextNode()?.parentElement, typography = label ? getComputedStyle(label) : null;
    // Layout wrappers can have heading typography while their visible labels use smaller type.
    for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing']) node.style[property] = typography?.[property] || 'inherit';
    node.hidden = mode === 'original'; node.style.display = mode === 'original' ? 'none' : 'block';
    node.style.marginTop = mode === 'translated' ? '0' : '.5em';
    if (node.parentElement !== element) element.append(node);
    if (mode === 'translated') hideSource(block); else restoreSource(block);
  };
  const remove = block => { restoreSource(block); block.node?.remove(); removeLoading(block); restoreLayout(block); restoreClamping(block); block.parts.forEach(part => parts.delete(part.id)); blocks.delete(block.element); };
  const reset = () => {
    clearTimeout(loadingTimer);
    browserController.abort(); browserTranslation?.dispose(); browserTranslation = undefined; browserState = undefined; browserController = new AbortController();
    browserJob = undefined; quickBusy = false; quickAnnounced = false; quickBatches = 0; codexError = null; browserError = null;
    generation++; busy = false; announced = false; cacheAnnounced = false; dirty = true; candidates = []; error = null; batches = 0; skipped = 0; detected = 0; limited = 0; deferred = 0;
    for (const block of [...blocks.values()]) remove(block);
  };
  const render = block => {
    if (!block.element.isConnected || text(block.element) !== block.source || !renderable(block)) return;
    if (!block.node) {
      const node = document.createElement('span'); node.dataset.mearlTranslation = host.identity.instanceId; node.lang = targetLang;
      node.style.cssText = 'display:block;margin:.5em 0 0;padding:0;border:0;color:light-dark(#155dfc, #51a2ff);font:inherit;line-height:inherit;letter-spacing:inherit;text-align:inherit;white-space:normal;overflow-wrap:break-word;word-break:normal';
      block.node = node;
    }
    // Only source links and code literals become elements; model output remains text.
    const codes = codeLiterals(block.element).sort((a, b) => b.text.length - a.text.length);
    const fragment = document.createDocumentFragment();
    for (const [index, part] of block.parts.entries()) {
      if (index) fragment.append(document.createTextNode(' '));
      const outputText = displayed(part).trim();
      const segments = linkMarkup.decode(outputText, part.links) ?? [{ text: outputText }];
      for (const segment of segments) {
        let container = fragment;
        if (segment.id !== undefined) {
          const original = block.links[segment.id], anchor = document.createElement('a');
          let destination;
          try { if (original.hasAttribute('href')) destination = new URL(original.getAttribute('href'), document.baseURI); } catch { /* Malformed destinations remain plain text. */ }
          if (destination && ['http:', 'https:', 'mailto:', 'tel:', 'ftp:'].includes(destination.protocol)) {
            anchor.href = destination.href;
            for (const attribute of ['target', 'rel', 'title', 'hreflang', 'download', 'referrerpolicy', 'class']) if (original.hasAttribute(attribute)) anchor.setAttribute(attribute, original.getAttribute(attribute));
            fragment.append(anchor); container = anchor;
          }
        }
        const output = segment.text;
        let offset = 0;
        while (offset < output.length) {
          let found;
          for (const code of codes) {
            if (segment.id === undefined ? block.links.some(link => link.contains(code.node)) : !block.links[segment.id].contains(code.node)) continue;
            let index = output.indexOf(code.text, offset);
            while (index >= 0) {
              const before = output[index - 1] || '', after = output[index + code.text.length] || '';
              if (!(/[a-zA-Z0-9_$]/.test(code.text[0]) && /[a-zA-Z0-9_$]/.test(before)) && !(/[a-zA-Z0-9_$]/.test(code.text.at(-1)) && /[a-zA-Z0-9_$]/.test(after))) break;
              index = output.indexOf(code.text, index + 1);
            }
            if (index >= 0 && (!found || index < found.index)) found = { ...code, index };
          }
          if (!found) { container.append(document.createTextNode(output.slice(offset))); break; }
          container.append(document.createTextNode(output.slice(offset, found.index)));
          const node = document.createElement('code'), style = getComputedStyle(found.node);
          node.textContent = found.text;
          for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'backgroundColor', 'borderRadius', 'padding']) node.style[property] = style[property];
          node.style.color = 'inherit'; node.style.whiteSpace = 'normal'; node.style.overflowWrap = 'break-word'; node.style.boxDecorationBreak = 'clone';
          container.append(node); offset = found.index + found.text.length;
          codes.splice(codes.findIndex(code => code.node === found.node), 1);
        }
      }
    }
    block.node.replaceChildren(fragment);
    place(block);
    const provisional = engine === 'auto' && block.parts.some(part => part.state !== 'done');
    block.node.style.textDecoration = provisional ? 'underline dashed' : 'none';
    block.node.style.textUnderlineOffset = '.2em';
    block.node.style.textDecorationThickness = '1px';
  };
  const discard = (ids, lane) => {
    const changed = new Set();
    for (const id of ids) {
      const part = parts.get(id);
      const value = part && lanePart(part, lane);
      if (!value || value.preview === undefined) continue;
      delete value.preview; changed.add(part.block);
    }
    for (const block of changed) {
      if (renderable(block)) render(block);
      else { restoreSource(block); block.node?.remove(); block.node = null; restoreLayout(block); restoreClamping(block); }
    }
    updateLoading();
  };
  const notify = () => {
    if (!enabled || disposed || engine === 'auto' && document.visibilityState === 'hidden') return;
    const current = generation, values = [...parts.values()];
    if ((engine === 'auto' || busy || error) && !cacheAnnounced && values.some(part => part.state === 'pending' && !part.cacheProbed && nearViewport(part.block.element))) {
      cacheAnnounced = true;
      void host.emit('cache', { generation }).catch(() => { if (current === generation) cacheAnnounced = false; });
    }
    if (engine === 'auto' && !quickBusy && !quickAnnounced && !browserError && values.some(part => part.fallback.state === 'pending' && nativeNeeded(part))) {
      quickAnnounced = true;
      void host.emit('quick', { generation, auto: true }).catch(failure => { if (current !== generation) return; quickAnnounced = false; if (!disposed && enabled) browserError = String(failure.message || failure).slice(0,500); });
    }
    if (error || codexError || busy || announced || !values.some(part => part.state === 'pending' && nearViewport(part.block.element))) return;
    announced = true;
    void host.emit('work', { generation, ...(engine === 'auto' ? { auto: true } : {}) }).catch(failure => {
      if (current !== generation) return;
      announced = false;
      if (!disposed && enabled) { if (engine === 'auto') codexError = String(failure.message || failure).slice(0,500); else error = String(failure.message || failure).slice(0,500); }
    });
  };
  const scan = () => {
    if (!enabled || disposed) return;
    sourceVisibility = new WeakMap();
    if (url !== location.href) { url = location.href; reset(); }
    const root = document.body;
    if (!root) return;
    const discover = dirty;
    if (dirty) {
      dirty = false;
      const links = [...root.querySelectorAll('a[href]')].slice(0, 2500);
      contentsLinks = new Set(links.filter(link => {
        if (link.closest(excluded) || !link.closest(navigation)) return false;
        try {
          const destination = new URL(link.getAttribute('href'), document.baseURI), current = new URL(location.href);
          if (!destination.hash) return false;
          const id = decodeURIComponent(destination.hash.slice(1));
          destination.hash = ''; current.hash = '';
          if (destination.href !== current.href) return false;
          const target = document.getElementById(id);
          // A section link is reading navigation only when it points at a content heading.
          const title = target?.matches(heading) ? target : target?.firstElementChild?.matches(heading) ? target.firstElementChild : null;
          return Boolean(title?.closest(readingRoot) && !title.closest(excluded + ',' + navigation));
        } catch { return false; }
      }));
      // Semantic blocks and leaf text containers cover articles as well as card feeds.
      const elements = new Set([...root.querySelectorAll(blockSelector)].slice(0, 2500).filter(element => !ignored(element) && !sourceAppearance(element).hidden));
      const styles = new WeakMap();
      const style = element => { if (!styles.has(element)) styles.set(element, getComputedStyle(element)); return styles.get(element); };
      for (const link of links) {
        const contents = contentsLinks.has(link);
        if (ignored(link) || link.querySelector(blockSelector)) continue;
        const enclosing = link.closest(blockSelector), blockLink = ['block','flow-root','-webkit-box'].includes(style(link).display);
        if (!contents && (!link.closest(readingRoot) || enclosing && !enclosing.matches('li,blockquote') || !blockLink)) continue;
        // Keep the translation with the label, rather than adding a flex item beside its icon.
        const source = text(link);
        if (!source) continue;
        let label = link, child;
        while ((child = [...label.children].find(element => !ignored(element) && text(element) === source))) label = child;
        if (!['flex', 'inline-flex', 'grid', 'inline-grid'].includes(style(label).display)) elements.add(label);
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node, inspected = 0;
      while ((node = walker.nextNode()) && ++inspected <= 15000) {
        if (!node.textContent.trim() || !readable(node.parentElement) || node.parentElement.closest(blockSelector + ',a,code')) continue;
        let element = node.parentElement;
        while (element && element !== root && ['inline', 'contents', ''].includes(style(element).display)) element = element.parentElement;
        if (element && element !== root && !ignored(element) && !element.querySelector(blockSelector)) elements.add(element);
        if (elements.size >= 2500) break;
      }
      const leaves = new Set(elements);
      for (const element of elements) {
        let parent = element.parentElement;
        while (parent && parent !== root) { leaves.delete(parent); parent = parent.parentElement; }
      }
      candidates = [];
      for (const element of leaves) {
        if (ignored(element) || element.closest('code,[data-mearl-translation-source]') || !visible(element)) continue;
        const source = text(element);
        if (source.length < 12 || !/\p{L}/u.test(source) || sameLanguage(element, source)) continue;
        candidates.push({ element, source });
      }
      if (viewportObserver) {
        const next = new Set(candidates.map(candidate => candidate.element));
        for (const element of observed) if (!next.has(element)) viewportObserver.unobserve(element);
        for (const element of next) if (!observed.has(element)) viewportObserver.observe(element);
        observed = next;
      }
    }
    for (const block of [...blocks.values()]) {
      if (!block.element.isConnected || text(block.element) !== block.source || ignored(block.element) || !complete(block) && !failed(block) && !block.parts.some(part => part.state === 'inflight' || part.fallback?.state === 'inflight') && !nearViewport(block.element)) remove(block);
      else {
        if (discover) {
          const linked = linkedSource(block.element);
          if (JSON.stringify(linked.ranges) !== JSON.stringify(block.linkRanges)) { remove(block); continue; }
          block.links = linked.anchors;
        }
        if (discover || !block.node?.isConnected) render(block);
        else place(block);
      }
    }
    const distance = element => { const rect = element.getBoundingClientRect(); return rect.bottom < 0 ? -rect.bottom : Math.max(0, rect.top - innerHeight); };
    candidates.sort((a, b) => distance(a.element) - distance(b.element));
    detected = candidates.length; skipped = 0; limited = 0; deferred = 0;
    for (const { element, source } of candidates) {
      if (blocks.has(element)) continue;
      if (!nearViewport(element)) { deferred++; continue; }
      const codes = codeLiterals(element);
      if (source.length > 12000 || codes.length > 64 || codes.some(code => code.text.length > 1600)) { skipped++; continue; }
      if (blocks.size >= maxParagraphs) { skipped++; limited++; continue; }
      const linked = linkedSource(element);
      if (linked.anchors.length > 64 || linked.anchors.length && (source.includes('[[mearl-link:') || source.includes('[[/mearl-link:'))) { skipped++; continue; }
      const block = { element, source, links: linked.anchors, linkRanges: linked.ranges, parts: [], node: null };
      let offset = 0;
      block.parts = split(source, codes).map(value => {
        const links = linked.ranges.filter(range => range.start < offset + value.length && range.end > offset).map(range => ({ id: range.id, start: Math.max(0, range.start - offset), end: Math.min(value.length, range.end - offset) })).filter(range => value.slice(range.start, range.end).trim());
        offset += value.length;
        return ({ id: String(++sequence), text: value, ...(engine !== 'codex' ? { sourceLanguage: element.closest('[lang]')?.lang || '' } : {}), codeLiterals: [...new Set(codes.filter(code => value.includes(code.text)).map(code => code.text))], ...(links.length ? { links } : {}), state: 'pending', ...(engine === 'auto' ? { fallback: { state: 'pending' } } : {}), block });
      });
      blocks.set(element, block); block.parts.forEach(part => {
        parts.set(part.id, part);
        const key = memoryKey(part), saved = memory.get(key);
        if (saved && saved.expires > Date.now()) {
          part.state = 'done'; part.output = saved.text; part.cached = true; remember(part);
        } else if (engine === 'auto') {
          const fallback = memory.get(memoryKey(part, 'browser'));
          if (fallback && fallback.expires > Date.now()) { part.fallback = { state: 'done', output: fallback.text, cached: true }; }
        }
      });
      if (complete(block)) render(block);
    }
    cancelBrowserJob(); updateLoading();
    notify();
  };
  // Coalesce events without moving the deadline while scrolling or mutations continue.
  const schedule = (discover = false) => {
    dirty ||= discover;
    if (!disposed && enabled && timer === undefined) timer = setTimeout(() => { timer = undefined; scan(); }, 60);
  };
  const scheduleViewport = () => schedule();
  const scheduleLayout = () => schedule(true);
  const viewportObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(scheduleViewport, { rootMargin: '0px 0px 100% 0px' }) : null;
  const observer = new MutationObserver(changes => {
    const own = node => (node.nodeType === 1 ? node : node.parentElement)?.closest?.(ownedSelector);
    if (changes.some(change => !own(change.target) && [...change.addedNodes, ...change.removedNodes].some(node => !own(node)) || ['characterData', 'attributes'].includes(change.type) && !own(change.target))) schedule(true);
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class','style','hidden','aria-hidden','inert','lang','translate','href','id','role'] });
  document.addEventListener('scroll', scheduleViewport, { passive: true, capture: true });
  document.addEventListener('visibilitychange', scheduleViewport);
  window.addEventListener('focus', scheduleViewport);
  window.addEventListener('scroll', scheduleViewport, { passive: true, capture: true }); window.addEventListener('resize', scheduleLayout);
  return {
    receive(message, request = {}) {
      if (disposed) throw new Error('Translation runtime is disposed');
      sourceVisibility = new WeakMap();
      if (message.type === 'FLOATING') {
        if (typeof message.enabled !== 'boolean') throw new Error('Invalid floating switch setting');
        if (!message.enabled) { floatingSwitch?.dispose(); floatingSwitch = undefined; }
        else {
          floatingSwitch ??= createFloatingSwitch(host);
          floatingSwitch.configure(message.position); floatingSwitch.update({ enabled, mode, pending: false, error: '' });
        }
        return summary();
      }
      if (message.type === 'FLOATING_ERROR') { floatingSwitch?.update({ pending: false, error: String(message.error || '').slice(0, 500) }); return summary(); }
      if (message.type === 'START') {
        if (message.engine !== undefined && !['auto','codex','browser'].includes(message.engine)) throw new Error('Invalid translation engine');
        reset(); targetLang = message.targetLang; maxParagraphs = message.maxParagraphs; model = message.model; reasoningEffort = message.reasoningEffort ?? 'low'; engine = message.engine ?? 'codex'; enabled = true; mode = 'bilingual'; url = location.href;
        scan(); floatingSwitch?.update({ enabled, mode, pending: false, error: '' }); return summary();
      }
      if (message.type === 'STATE') return summary();
      if (message.type === 'host:navigation') { schedule(true); return summary(); }
      if (message.type === 'DISPLAY') {
        if (!['original', 'bilingual', 'translated'].includes(message.mode)) throw new Error('Invalid display mode');
        mode = message.mode; for (const block of blocks.values()) if (block.node) place(block);
        floatingSwitch?.update({ enabled, mode, pending: false, error: '' });
        updateLoading();
        return summary();
      }
      if (message.type === 'RETRY') {
        error = null; codexError = null; browserError = null;
        for (const part of parts.values()) { for (const value of [part, ...(part.fallback ? [part.fallback] : [])]) if (value.state === 'error') { value.state = 'pending'; delete value.error; } }
        schedule(); return summary();
      }
      if (message.generation !== generation || !enabled) return { stale: true };
      const lane = engine === 'auto' ? message.lane ?? 'codex' : engine;
      if (engine === 'auto' && !['codex','browser'].includes(lane)) throw new Error('Invalid translation lane');
      if (message.type === 'BROWSER_TRANSLATE') {
        if (!['browser','auto'].includes(engine) || typeof createBrowserTranslation !== 'function') throw new Error('BROWSER_TRANSLATION_UNAVAILABLE');
        if (!Array.isArray(message.ids) || !message.ids.length || message.ids.length > 8 || new Set(message.ids).size !== message.ids.length) throw new Error('Invalid browser translation batch');
        const items = message.ids.map(id => parts.get(id));
        if (items.some(part => !part || lanePart(part, 'browser').state !== 'inflight' || text(part.block.element) !== part.block.source)) return { stale: true };
        const current = generation, job = { ids: message.ids, controller: new AbortController() };
        const signal = AbortSignal.any([browserController.signal, job.controller.signal, ...(request.signal ? [request.signal] : [])]);
        if (engine === 'auto') browserJob = job;
        if (!browserTranslation) { const helper = createBrowserTranslation(value => { if (browserTranslation === helper && generation === current && !disposed) browserState = value; }, linkMarkup); browserTranslation = helper; }
        return browserTranslation.translate(items, targetLang, signal, item => {
          if (disposed || current !== generation || signal.aborted) return;
          sourceVisibility = new WeakMap();
          const part = parts.get(item.id); if (!part || engine === 'auto' && part.state === 'done' || text(part.block.element) !== part.block.source) return;
          lanePart(part, 'browser').preview = item.text; render(part.block); updateLoading();
        }, engine === 'auto' ? nativeNeeded : undefined).catch(failure => {
          if (job.controller.signal.aborted && !browserController.signal.aborted && !request.signal?.aborted && current === generation) {
            browserTranslation?.dispose(); browserTranslation = undefined; browserState = undefined;
            return { translations: [], skipped: message.ids };
          }
          throw failure;
        }).finally(() => { if (browserJob === job) browserJob = undefined; });
      }
      if (message.type === 'CACHE_FINISH') { cacheAnnounced = false; notify(); return summary(); }
      if (message.type === 'PEEK') {
        const items = [...parts.values()].filter(part => part.state === 'pending' && !part.cacheProbed && nearViewport(part.block.element) && text(part.block.element) === part.block.source)
          .sort((a,b) => Number(inViewport(b.block.element)) - Number(inViewport(a.block.element))).slice(0, 16)
          .map(part => { part.cacheProbed = true; return { id: part.id, text: part.text, ...(engine !== 'codex' ? { sourceLanguage: part.sourceLanguage } : {}), ...(part.codeLiterals.length ? { codeLiterals: part.codeLiterals } : {}), ...(part.links ? { links: part.links } : {}) }; });
        return { items, generation, targetLang, model, reasoningEffort, engine };
      }
      if (message.type === 'TAKE') {
        const quick = engine === 'auto' && lane === 'browser';
        if (quick) quickAnnounced = false; else announced = false;
        const config = { generation, targetLang, model, reasoningEffort, engine: engine === 'auto' ? lane : engine, ...(engine === 'auto' ? { automatic: true } : {}) };
        if ((engine === 'auto' && document.visibilityState === 'hidden') || ((quick ? quickBusy : busy) && !message.afterBatch) || error || (quick ? browserError : codexError)) return { items: [], ...config };
        const values = [...parts.values()];
        const current = values.some(part => ['pending', 'inflight'].includes(lanePart(part, lane).state) && inViewport(part.block.element));
        const candidates = values.filter(part => lanePart(part, lane).state === 'pending' && (quick ? nativeNeeded(part) : nearViewport(part.block.element) && (!current || inViewport(part.block.element))) && text(part.block.element) === part.block.source);
        const distance = part => { const r = part.block.element.getBoundingClientRect(); return r.bottom < 0 ? -r.bottom : r.top > innerHeight ? r.top - innerHeight : 0; };
        candidates.sort((a, b) => distance(a) - distance(b));
        const first = (quick ? quickBatches : batches) === 0 && candidates[0]?.block.parts.length === 1;
        const items = []; let characters = 0;
        for (const part of candidates) {
          if (items.length >= (first ? 4 : 8) || characters + part.text.length > (first ? 3000 : 6000)) break;
          lanePart(part, lane).state = 'inflight'; characters += part.text.length; items.push({ id: part.id, text: part.text, ...(engine !== 'codex' ? { sourceLanguage: part.sourceLanguage } : {}), ...(part.codeLiterals.length ? { codeLiterals: part.codeLiterals } : {}), ...(part.links ? { links: part.links } : {}) });
        }
        if (quick) { quickBusy ||= items.length > 0; if (items.length) quickBatches++; }
        else { busy ||= items.length > 0; if (items.length) batches++; }
        updateLoading(); return { items, ...config };
      }
      if (message.type === 'DISCARD') { discard(message.ids, lane); return summary(); }
      if (message.type === 'PREVIEW' || message.type === 'APPLY') {
        const changed = new Set();
        for (const item of message.items) {
          const part = parts.get(item.id);
          const value = part && lanePart(part, lane);
          if (!part || engine === 'auto' && lane === 'browser' && part.state === 'done' || !(value.state === 'inflight' || item.cached && ['pending','error'].includes(value.state)) || !part.block.element.isConnected || text(part.block.element) !== part.block.source) continue;
          if (message.type === 'PREVIEW') value.preview = item.text;
          else { delete value.preview; delete value.error; value.output = item.text; value.state = 'done'; value.cached = Boolean(item.cached); remember(part, lane); }
          changed.add(part.block);
        }
        cancelBrowserJob(); updateLoading(); changed.forEach(render); return summary();
      }
      if (message.type === 'FAIL_ITEMS') {
        discard(message.items.map(item => item.id), lane);
        for (const item of message.items) {
          const part = parts.get(item.id);
          const value = part && lanePart(part, lane);
          if (value?.state === 'inflight') { value.state = 'error'; value.error = String(item.error || 'Translation failed').slice(0, 500); }
        }
        updateLoading(); return summary();
      }
      if (message.type === 'RELEASE_ITEMS') {
        discard(message.ids, lane);
        for (const id of message.ids) { const part = parts.get(id), value = part && lanePart(part, lane); if (value?.state === 'inflight') value.state = 'pending'; }
        return summary();
      }
      if (message.type === 'FAIL') {
        discard([...parts.keys()], lane);
        const failure = String(message.error || 'Translation failed').slice(0, 500);
        for (const part of parts.values()) { const value = lanePart(part, lane); if (value.state === 'inflight') { value.state = 'error'; value.error = failure; } }
        if (engine === 'auto') { if (lane === 'browser') browserError = failure; else codexError = failure; }
        else error = failure;
        updateLoading(); return summary();
      }
      if (message.type === 'FINISH') { if (engine === 'auto' && lane === 'browser') quickBusy = false; else busy = false; scan(); return summary(); }
      throw new Error('Unknown translation runtime message');
    },
    dispose() {
      disposed = true; enabled = false; clearTimeout(timer); observer.disconnect(); viewportObserver?.disconnect(); observed.clear();
      document.removeEventListener('scroll', scheduleViewport, true);
      document.removeEventListener('visibilitychange', scheduleViewport); window.removeEventListener('focus', scheduleViewport);
      window.removeEventListener('scroll', scheduleViewport, true); window.removeEventListener('resize', scheduleLayout);
      reset(); memory.clear(); memoryBytes = 0;
      floatingSwitch?.dispose(); floatingSwitch = undefined;
    },
  };
}
