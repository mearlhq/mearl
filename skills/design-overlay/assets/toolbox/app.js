(async () => {
  const bridge = window.mearl;
  let context = await bridge.ready();
  const { h, html, render, useState, useEffect, useRef } = bridge.ui;
  const messagesFor = locale => String(locale).startsWith('zh') ? {
    retry: '重试', initializationFailed: '覆盖层读取失败',
    noPage: '请先打开要对比的网页，再从浏览器工具栏打开 Mearl',
    density: '像素密度', densityHint: '截图使用屏幕像素密度；普通图片可选择 1×', design: '设计内容', replace: '替换设计稿', paste: '粘贴设计稿', file: '选择文件', importSvg: '应用 SVG', placeholder: '粘贴 SVG 代码，也可直接粘贴图片或拖入文件',
    clear: '清除', visible: '可见', hidden: '隐藏', locked: '锁定', unlock: '解锁', opacity: '透明度', scale: '缩放比例',
    blend: '差值模式', normal: '正常', difference: '差值', multiply: '正片叠底', screen: '滤色', overlay: '叠加', darken: '变暗', lighten: '变亮',
    anchor: '锚定元素', pick: '从网页选择元素', picking: '点击网页中的元素完成锚定，重新打开工具可继续调整', cancel: '取消选择', follow: '跟随滚动',
    offset: '位置偏移', crop: '裁切', top: '上', right: '右', bottom: '下', left: '左', reset: '重置', resetOpacity: '重置透明度', resetScale: '重置缩放', resetPosition: '重置位置偏移', resetCrop: '重置裁切', dragValue: '拖动调整数值', editValue: '点击输入精确数值',
    compare: '像素对比', comparing: '正在截图并计算差异…', importing: '正在导入设计稿…', loading: '正在读取覆盖层…',
    diff: '差异像素', diffRefresh: '重新对比', close: '收起差异图', imported: '设计稿已应用到网页', invalid: '请选择 SVG、PNG 或 JPG，单份资源最多 16 MiB',
    importFailed: '设计稿导入失败', failed: '操作失败', captured: '像素对比已完成', hint: '拖拽覆盖层调整位置；方向键微调，Shift 加速；拖拽边缘裁切。',
  } : {
    retry: 'Retry', initializationFailed: 'Could not load the overlay',
    noPage: 'Open the web page to compare, then open Mearl from the browser toolbar',
    density: 'Pixel density', densityHint: 'Screenshots use the screen pixel density; choose 1× for ordinary images', design: 'Design content', replace: 'Replace design', paste: 'Paste design', file: 'Choose file', importSvg: 'Apply SVG', placeholder: 'Paste SVG code, paste an image, or drop a file',
    clear: 'Clear', visible: 'Visible', hidden: 'Hidden', locked: 'Lock', unlock: 'Unlock', opacity: 'Opacity', scale: 'Scale',
    blend: 'Difference mode', normal: 'Normal', difference: 'Difference', multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', darken: 'Darken', lighten: 'Lighten',
    anchor: 'Anchor element', pick: 'Pick an element on the page', picking: 'Click a page element to anchor, then reopen this tool to adjust', cancel: 'Cancel selection', follow: 'Follow page scroll',
    offset: 'Position offset', crop: 'Crop', top: 'Top', right: 'Right', bottom: 'Bottom', left: 'Left', reset: 'Reset', resetOpacity: 'Reset opacity', resetScale: 'Reset scale', resetPosition: 'Reset position', resetCrop: 'Reset crop', dragValue: 'Drag to change value', editValue: 'Click to enter a precise value',
    compare: 'Compare pixels', comparing: 'Capturing and comparing pixels…', importing: 'Importing design…', loading: 'Loading overlay…',
    diff: 'Different pixels', diffRefresh: 'Compare again', close: 'Close diff', imported: 'Design applied to the page', invalid: 'Choose SVG, PNG or JPG. Each resource must fit within 16 MiB',
    importFailed: 'Design import failed', failed: 'Operation failed', captured: 'Pixel comparison complete', hint: 'Drag to position; use arrow keys to nudge and Shift to move faster. Drag edges to crop.',
  };
  let messages = messagesFor(context.locale);
  const t = key => messages[key];
  document.documentElement.lang = String(context.locale).startsWith('zh') ? 'zh-CN' : 'en';
  const fieldClass = 'field';
  const adjustmentCardClass = 'adjustment-card';
  const buttonClass = 'tool-button';
  const textChunkSize = 48 * 1024;
  const imageChunkSize = 192 * 1024;
  const maxBytes = 16 * 1024 * 1024;

  function icon(type) {
    return html`<svg class="icon-large" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      ${window.designOverlayIcons[type].map(([tag, attributes]) => h(tag, attributes))}
    </svg>`;
  }

  async function readResource(resource, tabId) {
    if (!resource?.id) return '';
    const first = await bridge.invoke('resource-chunk', { tabId, id: resource.id, index: 0 });
    if (!Number.isSafeInteger(first.bytes) || first.bytes < 1 || first.bytes > maxBytes || first.chunks !== Math.ceil(first.bytes / (144 * 1024))) throw new Error(t('invalid'));
    const bytes = new Uint8Array(first.bytes);
    let offset = 0;
    for (let index = 0; index < first.chunks; index += 1) {
      const part = index === 0 ? first : await bridge.invoke('resource-chunk', { tabId, id: resource.id, index });
      if (part.encoding !== 'base64' || part.bytes !== first.bytes || part.chunks !== first.chunks) throw new Error(t('invalid'));
      const data = Uint8Array.from(atob(part.data), character => character.charCodeAt(0));
      if (data.length !== Math.min(144 * 1024, first.bytes - offset)) throw new Error(t('invalid'));
      bytes.set(data, offset); offset += data.length;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  const readFile = file => new Promise((resolve, reject) => {
    if (!file || file.size > maxBytes || !/\.(svg|png|jpe?g)$/i.test(file.name)) return reject(new Error(t('invalid')));
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    if (/\.svg$/i.test(file.name)) reader.readAsText(file); else reader.readAsDataURL(file);
  });

  async function compareImages(capture, content, settings, tabId) {
    const [screenshot, cropped] = await Promise.all([readResource(capture.screenshot, tabId), readResource(capture.croppedDesign, tabId)]);
    return window.designOverlayCompare(screenshot, cropped, content, settings, capture.viewport, window.designOverlayDiff);
  }

  function PercentInput({ value, min, max, onChange }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const input = useRef(null), committing = useRef(false);
    useEffect(() => { if (editing) input.current?.select(); }, [editing]);
    const commit = () => {
      if (!committing.current) return;
      committing.current = false;
      const number = parseFloat(draft);
      if (Number.isFinite(number)) onChange(Math.round(Math.min(max, Math.max(min, number)) * 10) / 10);
      setEditing(false);
    };
    if (!editing) return html`<button type="button" class="percent-value" title=${t('editValue')}
      onClick=${() => { committing.current = true; setDraft(String(Math.round(value * 10) / 10)); setEditing(true); }}>${Math.round(value * 10) / 10}%</button>`;
    return html`<input ref=${input} class="percent-input" type="number" min=${min} max=${max} step="0.1" value=${draft}
      onInput=${event => setDraft(event.target.value)} onBlur=${commit} onKeyDown=${event => {
        event.stopPropagation();
        if (event.key === 'Enter') { event.preventDefault(); commit(); }
        if (event.key === 'Escape') { committing.current = false; setEditing(false); }
      }} />`;
  }

  function ScrubLabel({ value, min, onChange, label, centered = false }) {
    const drag = useRef(null);
    return html`<span class=${centered ? 'scrub-label is-centered' : 'scrub-label'}
      title=${t('dragValue')} onPointerDown=${event => {
        drag.current = { x: event.clientX, value };
        event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
      }} onPointerMove=${event => {
        if (drag.current) onChange(Math.max(min, Math.min(100000, Math.round(drag.current.value + event.clientX - drag.current.x))));
      }} onPointerUp=${() => { drag.current = null; }} onPointerCancel=${() => { drag.current = null; }}>${label}</span>`;
  }

  function VisibilityLock({ settings, update }) {
    const hold = useRef(null), timer = useRef(null);
    useEffect(() => () => clearTimeout(timer.current), []);
    const release = () => {
      clearTimeout(timer.current);
      if (hold.current?.long) update({ visible: hold.current.original });
      hold.current = null;
    };
    return html`<div class="button-row">
      <button type="button" class=${settings.visible ? 'visibility-button is-active' : 'visibility-button'}
        onPointerDown=${event => {
          event.currentTarget.setPointerCapture(event.pointerId);
          hold.current = { original: settings.visible, long: false };
          update({ visible: !settings.visible });
          timer.current = setTimeout(() => { if (hold.current) hold.current.long = true; }, 300);
        }} onPointerUp=${release} onPointerCancel=${release}
        onClick=${event => { if (event.detail === 0) update({ visible: !settings.visible }); }}>
        ${icon(settings.visible ? 'eye' : 'hidden')}${t(settings.visible ? 'visible' : 'hidden')}
      </button>
      <button class="lock-button"
        aria-label=${t(settings.locked ? 'unlock' : 'locked')} title=${t(settings.locked ? 'unlock' : 'locked')}
        onClick=${() => update({ locked: !settings.locked })}>${icon(settings.locked ? 'lock' : 'unlock')}</button>
    </div>`;
  }

  function App() {
    const [, setLocale] = useState(context.locale);
    useEffect(() => bridge.onContextChange?.(next => {
      context = next;
      messages = messagesFor(next.locale);
      document.documentElement.lang = String(next.locale).startsWith('zh') ? 'zh-CN' : 'en';
      setLocale(next.locale);
    }), []);
    const [tabId, setTabId] = useState(null);
    const [pageConnected, setPageConnected] = useState(false);
    const [pageInstanceId, setPageInstanceId] = useState(null);
    const [settings, setSettings] = useState(null);
    const [content, setContent] = useState('');
    const [busy, setBusy] = useState('loading');
    const [showInitialLoading, setShowInitialLoading] = useState(false);
    const [failure, setFailure] = useState(null);
    const [picking, setPicking] = useState(false);
    const [diff, setDiff] = useState(null);
    const target = useRef(null);
    const pagePixelRatio = useRef(1);
    const activeAsset = useRef(null);
    const assetLoadRevision = useRef(0);
    const generation = useRef(0);
    const writes = useRef(Promise.resolve());
    const writing = useRef(0);
    const fileInput = useRef(null);
    const busyRef = useRef(busy);
    busyRef.current = busy;
    const initializing = busy === 'loading' && !settings;
    useEffect(() => {
      setShowInitialLoading(false);
      if (!initializing) return;
      const timer = setTimeout(() => setShowInitialLoading(true), 300);
      return () => clearTimeout(timer);
    }, [initializing]);
    const payload = extra => ({ tabId: target.current, locale: context.locale || 'zh_CN', ...extra });
    const report = failure => {
      const detail = String(failure.message || failure);
      if (failure.handledByHost) return;
      const message = `${t('failed')}：${detail}`;
      bridge.invoke('host.toast', { message, type: 'error' });
    };

    async function selectTab(id) {
      const current = ++generation.current;
      target.current = id;
      activeAsset.current = null; assetLoadRevision.current += 1;
      setTabId(id); setPageConnected(false); setPageInstanceId(null); setFailure(null); setSettings(null); setContent(''); setDiff(null); setPicking(false);
      if (!id) { setBusy(''); return; }
      setBusy('loading');
      try {
        const state = await bridge.invoke('state', { tabId: id, locale: context.locale });
        const asset = state.settings.assetId ? await readResource({ id: state.settings.assetId }, id) : '';
        if (current !== generation.current) return;
        pagePixelRatio.current = Math.max(1, Math.min(4, state.devicePixelRatio || 1));
        activeAsset.current = state.settings.assetId;
        setPageInstanceId(state.instanceId); setSettings(state.settings); setPicking(state.picking); setContent(asset); setPageConnected(true);
      } catch (failure) {
        if (current === generation.current) {
          if (!failure.handledByHost) setFailure({ detail: String(failure.message || failure) });
          report(failure);
        }
      }
      finally { if (current === generation.current) setBusy(''); }
    }

    async function openCurrentPage() {
      try {
        const active = await bridge.invoke('host.tab.active');
        await selectTab(active?.tabId ?? null);
      } catch (failure) { report(failure); setBusy(''); }
    }

    useEffect(() => { void openCurrentPage(); return () => { generation.current += 1; }; }, []);
    useEffect(() => {
      if (!tabId || !pageConnected) return;
      let cancelled = false, refreshing = false, unsubscribe;
      const refresh = async () => {
        if (cancelled || refreshing || writing.current || busyRef.current) return;
        refreshing = true;
        const current = generation.current;
        try {
          const state = await bridge.invoke('state', { tabId, locale: context.locale });
          if (!cancelled && current === generation.current && !writing.current && !busyRef.current) {
            pagePixelRatio.current = Math.max(1, Math.min(4, state.devicePixelRatio || 1));
            setPageInstanceId(state.instanceId); setFailure(null); setSettings(state.settings); setPicking(state.picking);
            if (state.settings.assetId !== activeAsset.current) {
              const assetLoad = ++assetLoadRevision.current;
              const asset = state.settings.assetId ? await readResource({ id: state.settings.assetId }, tabId) : '';
              if (!cancelled && current === generation.current && assetLoadRevision.current === assetLoad && !writing.current && !busyRef.current) { activeAsset.current = state.settings.assetId; setContent(asset); }
            }
          }
        } catch (failure) { if (!cancelled) report(failure); }
        finally { refreshing = false; }
      };
      const receive = (event, metadata) => {
        if (cancelled || target.current !== tabId) return;
        if (event?.type === 'navigation' || event?.type === 'invalidated') { void refresh(); return; }
        if (event?.type !== 'received' || event.name !== 'state' || !event.payload?.settings || writing.current || busyRef.current) return;
        const state = event.payload;
        pagePixelRatio.current = Math.max(1, Math.min(4, state.devicePixelRatio || 1));
        setSettings(state.settings); setPicking(state.picking); setDiff(null);
        if (state.settings.assetId !== activeAsset.current) {
          const current = generation.current, assetId = state.settings.assetId;
          const assetLoad = ++assetLoadRevision.current;
          void readResource({ id: assetId }, tabId).then(asset => {
            if (!cancelled && current === generation.current && assetLoadRevision.current === assetLoad && !writing.current && !busyRef.current) { activeAsset.current = assetId; setContent(asset); }
          }).catch(report);
        }

      };
      void (async () => {
        try {
          const current = pageInstanceId ? { instanceId: pageInstanceId } : await bridge.invoke('state', { tabId, locale: context.locale });
          if (!pageInstanceId) setPageInstanceId(current.instanceId);
          const stop = await bridge.subscribe('page', { instanceId: current.instanceId }, receive);
          if (cancelled) stop(); else { unsubscribe = stop; void refresh(); }
        } catch (failure) { if (!cancelled) report(failure); }
      })();
      const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
      window.addEventListener('focus', refresh);
      document.addEventListener('visibilitychange', visible);
      return () => {
        cancelled = true; unsubscribe?.();
        window.removeEventListener('focus', refresh);
        document.removeEventListener('visibilitychange', visible);
      };
    }, [tabId, pageConnected, pageInstanceId]);

    function update(patch) {
      const id = target.current, current = generation.current;
      setSettings(previous => ({ ...previous, ...patch })); setDiff(null);
      writing.current += 1;
      writes.current = writes.current.then(async () => {
        try {
          const state = await bridge.invoke('update', { tabId: id, settings: patch });
          if (current === generation.current) {
            setPageConnected(true);
            if (writing.current === 1) setSettings(state.settings);
          }
        } catch (failure) { if (current === generation.current) report(failure); }
        finally { writing.current -= 1; }
      });
    }

    async function importDesign(value, fromClipboard = false) {
      if (!target.current || busyRef.current) return;
      const current = generation.current;
      setBusy('importing');
      try {
        await writes.current;
        const data = typeof value === 'string' ? value.trim() : await readFile(value);
        if (new TextEncoder().encode(data).byteLength > maxBytes) throw new Error(t('invalid'));
        if (!/^data:image\/(png|jpeg);base64,/.test(data) && !/^\s*(<svg\b|<\?xml\b)/.test(data)) throw new Error(t('invalid'));
        const pageState = await bridge.invoke('state', payload());
        if (current !== generation.current) return;
        pagePixelRatio.current = Math.max(1, Math.min(4, pageState.devicePixelRatio || 1));
        setPageConnected(true);
        const chunkSize = data.startsWith('data:image/') ? imageChunkSize : textChunkSize;
        const chunks = Math.ceil(data.length / chunkSize);
        const { uploadId } = await bridge.invoke('begin-import', payload({ chunks }));
        let resource;
        for (let index = 0; index < chunks; index += 1) {
          resource = (await bridge.invoke('import-chunk', payload({ uploadId, index, data: data.slice(index * chunkSize, (index + 1) * chunkSize) }))).resource;
        }
        const pixelRatio = fromClipboard && /^data:image\/(png|jpeg);/.test(data) ? pagePixelRatio.current : 1;
        const state = await bridge.invoke('apply', payload({ assetId: resource.id, pixelRatio }));
        if (current !== generation.current) return;
        activeAsset.current = state.settings.assetId; assetLoadRevision.current += 1;
        setSettings(state.settings); setContent(data); setDiff(null);
        bridge.invoke('host.toast', { message: t('imported'), type: 'success' });
      } catch (failure) { if (current === generation.current) report(failure); }
      finally { if (current === generation.current) setBusy(''); }
    }

    async function paste() {
      try { const item = await bridge.invoke('host.clipboard.read'); await importDesign(item.data, true); }
      catch (failure) { report(failure); }
    }
    function onPaste(event) {
      const file = [...event.clipboardData.items].find(item => item.kind === 'file')?.getAsFile();
      const text = event.clipboardData.getData('text/plain');
      if (file || /^\s*(<svg\b|<\?xml\b)/.test(text)) {
        event.preventDefault(); void importDesign(file || text, true);
      }
    }
    async function action(command) {
      setBusy('loading');
      try {
        await writes.current;
        const state = await bridge.invoke(command, payload());
        setPageConnected(true);
        setSettings(state.settings); setPicking(state.picking);
        if (command === 'clear') { activeAsset.current = null; assetLoadRevision.current += 1; setContent(''); setDiff(null); }
      } catch (failure) { report(failure); }
      finally { setBusy(''); }
    }
    async function compare() {
      setBusy('comparing'); setDiff(null);
      try {
        await writes.current;
        const state = await bridge.invoke('state', payload());
        setPageConnected(true);
        const design = state.settings.assetId === activeAsset.current ? content : await readResource({ id: state.settings.assetId }, target.current);
        const capture = await bridge.invoke('capture', payload());
        activeAsset.current = state.settings.assetId; assetLoadRevision.current += 1; setContent(design);
        setDiff(await compareImages(capture, design, state.settings, target.current));
        bridge.invoke('host.toast', { message: t('captured'), type: 'success' });
      } catch (failure) { report(failure); }
      finally { setBusy(''); }
    }

    useEffect(() => {
      const keydown = event => {
        if (!settings || !content || busy || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable) return;
        if (event.key === ' ') { event.preventDefault(); update({ locked: !settings.locked }); }
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
          event.preventDefault();
          const step = event.shiftKey ? 10 : 1;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') update({ offsetX: settings.offsetX + (event.key === 'ArrowLeft' ? -step : step) });
          else update({ offsetY: settings.offsetY + (event.key === 'ArrowUp' ? -step : step) });
        }
      };
      document.addEventListener('keydown', keydown);
      return () => document.removeEventListener('keydown', keydown);
    }, [settings, content, busy]);

    const numeric = (key, label, minimum = -100000, centered = false) => html`<div class="numeric-control">
      <${ScrubLabel} value=${settings[key]} label=${label} min=${minimum} centered=${centered} onChange=${value => update({ [key]: value })} />
      <input class=${centered ? 'number-field is-centered' : 'number-field'}
        aria-label=${key.startsWith('crop') ? t('crop') + ' ' + label : label} type="number" step="1" min=${minimum} max="100000" value=${settings[key]}
        onKeyDown=${event => event.stopPropagation()} onChange=${event => {
          const value = Number(event.target.value);
          if (Number.isFinite(value) && value >= minimum && value <= 100000) update({ [key]: value });
        }} />
    </div>`;
    const resetButton = (title, patch) => html`<button class=${buttonClass} title=${title} aria-label=${title} onClick=${() => update(patch)}>${icon('reset')}</button>`;
    const slider = (key, label, min, max, reset, resetTitle, extra = null) => html`<section class=${adjustmentCardClass}>
      <div class="section-heading"><label for=${key} class="section-label">${label}</label>
        <div class="compact-row">${extra}<${PercentInput} value=${settings[key] * 100} min=${min} max=${max} onChange=${value => update({ [key]: value / 100 })} />${resetButton(resetTitle, { [key]: reset })}</div>
      </div>
      <input id=${key} class="slider" type="range" min=${min} max=${max} value=${settings[key] * 100}
        onInput=${event => update({ [key]: Number(event.target.value) / 100 })} />
    </section>`;
    const difference = settings ? html`<button class=${settings.blendMode === 'difference' ? 'blend-button is-active' : 'blend-button'}
      onClick=${() => update({ blendMode: settings.blendMode === 'difference' ? 'normal' : 'difference' })}>${t('blend')}</button>` : null;
    return html`
      <main class=${initializing || failure ? 'overlay-app is-loading' : 'overlay-app'} tabIndex="-1" onPaste=${onPaste}
        onDragOver=${event => event.preventDefault()} onDrop=${event => { event.preventDefault(); void importDesign(event.dataTransfer.files[0]); }}>
        ${!tabId && !busy ? html`<p class="muted">${t('noPage')}</p>` : null}
        ${initializing && showInitialLoading ? html`<p role="status" class="loading-status"><span class="loading-spinner" aria-hidden="true"></span>${t('loading')}</p>` : null}
        ${failure ? html`<section role="alert" class="initialization-error">
          <p class="error-title">${t('initializationFailed')}</p>
          <p class="error-detail">${failure.detail}</p>
          <button class="retry-button" disabled=${Boolean(busy)} onClick=${openCurrentPage}>${t('retry')}</button>
        </section>` : null}
        <fieldset class=${initializing || failure ? 'hidden' : 'controls'} disabled=${Boolean(busy) || !tabId}>
          <section class="stack">
            <div class="section-heading"><label class="section-label">${t('design')} ${content ? html`<span class="file-size">(${(content.length / 1024).toFixed(1)}KB)</span>` : null}</label>
              ${content ? html`<div class="row"><select class="density-select" aria-label=${t('density')} title=${t('densityHint')} onChange=${event => update({ pixelRatio: Number(event.target.value) })}>${[...new Set([1, 2, 3, 4, settings?.pixelRatio || 1])].sort((a, b) => a - b).map(ratio => html`<option value=${String(ratio)} selected=${ratio === (settings?.pixelRatio || 1)}>${ratio}×</option>`)}</select><button class=${buttonClass} title=${t('clear')} aria-label=${t('clear')} onClick=${() => action('clear')}>${icon('close')}</button></div>` : null}</div>
            <div class="button-row">
              <button class="import-button" aria-busy=${busy === 'importing'} onClick=${paste}>${busy === 'importing' ? html`<span class="loading-spinner" aria-hidden="true"></span>` : icon('document')}${t(content ? 'replace' : 'paste')}</button>
              <button class="file-button" title=${t('file')} aria-label=${t('file')} onClick=${() => fileInput.current.click()}>${icon('file')}</button>
              <input ref=${fileInput} type="file" accept=".svg,.png,.jpg,.jpeg,image/svg+xml,image/png,image/jpeg" class="hidden" onChange=${event => { void importDesign(event.target.files[0]); event.target.value = ''; }} />
            </div>
          </section>
          ${settings ? html`<section class="stack">
            <div class="section-heading"><label for="anchor" class="section-label">${t('anchor')}</label>
              <button class=${buttonClass} title=${t(picking ? 'cancel' : 'pick')} aria-label=${t(picking ? 'cancel' : 'pick')} onClick=${() => action(picking ? 'cancel-pick' : 'pick')}>${icon(picking ? 'close' : 'pick')}</button></div>
            <input id="anchor" class=${fieldClass} value=${settings.selector} onChange=${event => { if (event.target.value.trim()) update({ selector: event.target.value }); }} />
            ${picking ? html`<p role="status" class="pick-status">${t('picking')}</p>` : null}
            <label class="follow-control"><span>${t('follow')}</span>
              <input class="switch-input" type="checkbox" role="switch" checked=${settings.followScroll} onChange=${event => update({ followScroll: event.target.checked })} />
              <span aria-hidden="true" class=${settings.followScroll ? 'switch-track is-active' : 'switch-track'}>
                <span class=${settings.followScroll ? 'switch-thumb is-active' : 'switch-thumb'}></span>
              </span>
            </label>
          </section>` : null}
          ${settings && content ? html`
            <${VisibilityLock} settings=${settings} update=${update} />
            <div class="adjustment-grid">
              ${slider('opacity', t('opacity'), 0, 100, 0.5, t('resetOpacity'), difference)}
              ${slider('scale', t('scale'), 10, 300, 1, t('resetScale'))}
            </div>
            <div class="adjustment-grid">
              <section class=${adjustmentCardClass}>
              <div class="section-heading"><label class="section-label">${t('offset')}</label>${resetButton(t('resetPosition'), { offsetX: 0, offsetY: 0 })}</div>
              <div class="offset-grid">${numeric('offsetX', 'X')}${numeric('offsetY', 'Y')}</div>
              </section>
              <section class=${adjustmentCardClass}>
              <div class="section-heading"><label class="section-label">${t('crop')}</label>
                ${settings.cropTop || settings.cropRight || settings.cropBottom || settings.cropLeft ? resetButton(t('resetCrop'), { cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 }) : null}</div>
              <div class="crop-grid">${numeric('cropTop', '↑', 0, true)}${numeric('cropRight', '→', 0, true)}${numeric('cropBottom', '↓', 0, true)}${numeric('cropLeft', '←', 0, true)}</div>
              </section>
            </div>
            <button class="compare-button" disabled=${!settings.visible} aria-busy=${busy === 'comparing'} onClick=${compare}>${busy === 'comparing' ? html`<span class="loading-spinner" aria-hidden="true"></span>` : null}${t('compare')}</button>
          ` : null}
        </fieldset>
        ${diff ? html`<section class="stack">
          <div class="section-heading"><span>${diff.percentage.toFixed(1)}% · ${diff.count.toLocaleString()} ${t('diff')}</span><button class=${buttonClass} title=${t('close')} aria-label=${t('close')} onClick=${() => setDiff(null)}>${icon('close')}</button></div>
          <img class="diff-image" alt=${t('diff')} src=${diff.image} />
        </section>` : null}
      </main>`;
  }
  render(html`<${App} />`, document.getElementById('app'));
})();
