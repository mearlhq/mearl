(async () => {
  const bridge = window.mearl, context = await bridge.ready(), codec = window.mearlFormatCodec;
  const { h, html, render, useState, useEffect, useRef } = bridge.ui;
  const messages = {
    zh_CN: {
      input: '输入内容', result: '转换结果', text: '文本', timestamp: '时间戳', date: '日期时间', base64: 'Base64', url: 'URL 编码', image: '图片',
      seconds: '时间戳 · 秒', milliseconds: '时间戳 · 毫秒', local: '本地时间', utc: 'UTC', zone: '日期时区', now: '当前时间', clear: '清空', paste: '粘贴', copy: '复制', copied: '已复制', choose: '选择图片',
      hint: '输入文字、时间戳、Base64 或 URL，自动识别', resultHint: '也可以在这里输入或粘贴', waiting: '等待有效内容', preview: '图片预览', reading: '读取中',
      selected: '内容较大，已全选，请按 Ctrl/Cmd+C 复制', invalidBase64: 'Base64 格式不完整或无效', invalidUtf8: '这段 Base64 不是有效的 UTF-8 文本或图片', invalidUrl: 'URL 编码不完整或无效',
      invalidTimestamp: '请输入有效的秒或毫秒时间戳', invalidDate: '请输入有效日期，如 2026-10-16 12:30:00.000', invalidImage: '支持 PNG、JPEG、GIF、WebP 图片', tooLarge: '内容过大，原始文本或图片最多 8 MiB',
      failed: '操作失败，请重试', readFailed: '图片读取失败，请重新选择', oneImage: '一次转换一张图片',
    },
    en: {
      input: 'Input', result: 'Results', text: 'Text', timestamp: 'Timestamp', date: 'Date and time', base64: 'Base64', url: 'URL encoding', image: 'Image',
      seconds: 'Timestamp · seconds', milliseconds: 'Timestamp · milliseconds', local: 'Local time', utc: 'UTC', zone: 'Date timezone', now: 'Current time', clear: 'Clear', paste: 'Paste', copy: 'Copy', copied: 'Copied', choose: 'Choose image',
      hint: 'Type text, a timestamp, Base64 or a URL. Format detected automatically', resultHint: 'You can also type or paste here', waiting: 'Waiting for valid content', preview: 'Image preview', reading: 'Reading',
      selected: 'Large content selected. Press Ctrl/Cmd+C to copy.', invalidBase64: 'Incomplete or invalid Base64', invalidUtf8: 'This Base64 is not valid UTF-8 text or a supported image', invalidUrl: 'Incomplete or invalid URL encoding',
      invalidTimestamp: 'Enter a valid timestamp in seconds or milliseconds', invalidDate: 'Enter a valid date, e.g. 2026-10-16 12:30:00.000', invalidImage: 'Supported images: PNG, JPEG, GIF and WebP', tooLarge: 'Original text or images must fit within 8 MiB.',
      failed: 'Something went wrong. Try again.', readFailed: 'Could not read the image. Choose it again.', oneImage: 'Convert one image at a time',
    },
  };
  let locale = context.locale;
  const t = key => messages[String(locale).startsWith('zh') ? 'zh_CN' : 'en'][key];
  const errorText = error => {
    switch (error?.code) {
      case 'INVALID_BASE64': return t('invalidBase64');
      case 'INVALID_UTF8': return t('invalidUtf8');
      case 'INVALID_URL': return t('invalidUrl');
      case 'INVALID_TIMESTAMP': return t('invalidTimestamp');
      case 'INVALID_DATE': return t('invalidDate');
      case 'INVALID_IMAGE': return t('invalidImage');
      case 'TOO_LARGE': return t('tooLarge');
      default: return error?.message || t('failed');
    }
  };
  const empty = () => ({ input: '', analysis: codec.analyze({ value: '' }), source: 'input', error: null });
  const icon = name => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${window.formatIcons[name].map(([tag, attributes]) => h(tag, attributes))}</svg>`;
  const size = bytes => bytes < 1024 ? `${bytes} B` : `${(bytes / (bytes < 1048576 ? 1024 : 1048576)).toFixed(1)} ${bytes < 1048576 ? 'KiB' : 'MiB'}`;
  function App() {
    const [, setLocale] = useState(locale), [state, setState] = useState(empty), [zone, setZone] = useState('local'), [inputBelow, setInputBelow] = useState(false);
    const [operationError, setOperationError] = useState(null), [reading, setReading] = useState(false), [dragging, setDragging] = useState(false), [dimensions, setDimensions] = useState(null);
    const fileInput = useRef(null), inputRef = useRef(null), fieldRefs = useRef({}), sequence = useRef(0), mounted = useRef(true), current = useRef(null);
    current.current = { state, zone };
    const cancelRead = () => { sequence.current++; setReading(false); };
    const writeInput = (value, selectedZone = current.current.zone) => {
      cancelRead(); setOperationError(null);
      try { setState({ input: value, analysis: codec.analyze({ value, zone: selectedZone }), source: 'input', error: null }); }
      catch (error) { setState({ input: value, analysis: { kind: 'text', fields: [] }, source: 'input', error }); }
    };
    const editField = (id, value, selectedZone = current.current.zone) => {
      cancelRead(); setOperationError(null);
      setState(previous => {
        const { analysis } = previous;
        try {
          const next = codec.reverse({ kind: analysis.kind, field: id, value, zone: selectedZone, unit: analysis.meta?.unit || 'milliseconds' });
          next.analysis.fields = next.analysis.fields.map(field => field.id === id ? { ...field, value } : field);
          return { ...next, source: id, error: null };
        } catch (error) {
          return { input: '', analysis: { ...analysis, fields: analysis.fields.map(field => ({ ...field, value: field.id === id ? value : '' })) }, source: id, error };
        }
      });
    };
    const changeZone = value => {
      current.current.zone = value; setZone(value);
      if (state.source === 'input') writeInput(state.input, value);
      else editField(state.source, state.analysis.fields.find(field => field.id === state.source)?.value || '', value);
    };
    const clear = () => { cancelRead(); setOperationError(null); setDimensions(null); setInputBelow(false); setState(empty()); inputRef.current?.focus(); };
    const loadFiles = async files => {
      if (!files.length) return;
      if (files.length !== 1) { setOperationError(new Error(t('oneImage'))); return; }
      if (files[0].size > codec.MAX_BYTES) { setOperationError({ code: 'TOO_LARGE' }); return; }
      const request = ++sequence.current;
      setReading(true); setOperationError(null);
      try {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error(t('readFailed'))); reader.readAsDataURL(files[0]);
        });
        if (mounted.current && request === sequence.current) writeInput(String(data));
      } catch (error) { if (mounted.current && request === sequence.current) setOperationError(error); }
      finally { if (mounted.current && request === sequence.current) setReading(false); }
    };
    const paste = async id => {
      const request = ++sequence.current; setReading(false);
      try {
        const content = await bridge.invoke('host.clipboard.read', {});
        if (!mounted.current || request !== sequence.current) return;
        if (content.type === 'image' || id === 'input') writeInput(content.data);
        else editField(id, content.data);
      } catch (error) { if (mounted.current && request === sequence.current) setOperationError(error); }
    };
    const copy = async (id, value) => {
      try {
        if (value.length > 1000000) {
          const element = id === 'input' ? inputRef.current : fieldRefs.current[id];
          element?.focus(); element?.select();
          await bridge.invoke('host.toast', { message: t('selected'), type: 'info' }); return;
        }
        await bridge.invoke('host.clipboard.writeText', { text: value });
        await bridge.invoke('host.toast', { message: t('copied'), type: 'success' });
      } catch (error) { setOperationError(error); }
    };
    useEffect(() => {
      mounted.current = true;
      const onPaste = event => {
        const files = [...(event.clipboardData?.files || [])];
        if (files.length) { event.preventDefault(); void loadFiles(files); }
      };
      document.addEventListener('paste', onPaste);
      return () => { mounted.current = false; sequence.current++; document.removeEventListener('paste', onPaste); };
    }, []);
    useEffect(() => { setDimensions(null); }, [state.analysis.image]);
    useEffect(() => { if (inputBelow) inputRef.current?.focus(); }, [inputBelow]);
    useEffect(() => bridge.onContextChange(next => {
      locale = next.locale; setLocale(locale); document.documentElement.lang = String(locale).startsWith('zh') ? 'zh-CN' : 'en';
    }), []);
    const { analysis } = state, time = ['timestamp', 'date'].includes(analysis.kind);
    const controls = (id, value) => html`<button class="icon-button" aria-label=${`${t('paste')} ${t(id)}`} title=${t('paste')} onClick=${() => paste(id)}>${icon('paste')}</button><button class="icon-button" aria-label=${`${t('copy')} ${t(id)}`} title=${t('copy')} disabled=${!value} onClick=${() => copy(id, value)}>${icon('copy')}</button>`;
    return html`<main class=${inputBelow ? 'is-reversed' : ''} onDragOver=${event => { if ([...(event.dataTransfer?.types || [])].includes('Files')) { event.preventDefault(); setDragging(true); } }}
      onDragLeave=${event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
      onDrop=${event => { if (event.dataTransfer?.files?.length) { event.preventDefault(); setDragging(false); void loadFiles([...event.dataTransfer.files]); } }}>
      <section aria-label=${t('input')} class=${`card input-card ${dragging ? 'is-dragging' : ''}`}>
        <div class="toolbar"><span class="label">${t('input')}</span>${state.input && !state.error ? html`<span class="detected">${t(analysis.kind)}</span>` : null}
          <div class="actions"><button class="icon-button" aria-label=${t('now')} title=${t('now')} onClick=${() => writeInput(String(Date.now()))}>${icon('clock')}</button>
            <button class="icon-button" aria-label=${t('choose')} title=${t('choose')} disabled=${reading} onClick=${() => fileInput.current.click()}>${icon('image')}</button>
            ${controls('input', state.input)}<button class="icon-button" aria-label=${t('clear')} title=${t('clear')} disabled=${!state.input && !reading && !analysis.fields.some(field => field.value)} onClick=${clear}>${icon('clear')}</button>
          </div>
        </div>
        <textarea ref=${inputRef} class="field" aria-label=${t('input')} placeholder=${t('hint')} spellCheck=${false} value=${state.input} onInput=${event => writeInput(event.currentTarget.value)}></textarea>
        ${state.error && state.source === 'input' ? html`<p role="alert" class="error">${errorText(state.error)}</p>` : null}
      </section>
      <section aria-label=${t('result')} class="card result-card">
        ${!state.input && !state.error && !analysis.fields.length ? html`<div class="toolbar"><span class="label">${t('result')}</span><div class="actions"><button class="icon-button" aria-label=${`${t('paste')} ${t('result')}`} title=${t('paste')} onClick=${() => { setInputBelow(true); void paste('input'); }}>${icon('paste')}</button></div></div><textarea class="field" aria-label=${t('result')} placeholder=${t('resultHint')} spellCheck=${false} onInput=${event => { setInputBelow(true); writeInput(event.currentTarget.value); }}></textarea>` : null}
        ${analysis.kind === 'image' ? html`<div class="toolbar"><span class="label">${reading ? t('reading') : t('image')}</span><div class="actions"><button class="icon-button" aria-label=${`${t('paste')} ${t('image')}`} title=${t('paste')} onClick=${() => paste('input')}>${icon('paste')}</button></div></div>` : null}
        ${analysis.fields.map((field, index) => html`<div key=${field.id} class="result-field"><div class="toolbar"><span class="label">${t(field.id)}</span><div class="actions">${time && index === 0 ? html`<select class="zone" aria-label=${t('zone')} value=${zone} onChange=${event => changeZone(event.currentTarget.value)}><option value="local">${t('local')}</option><option value="utc">${t('utc')}</option></select>` : null}${controls(field.id, field.value)}</div></div><textarea ref=${element => { fieldRefs.current[field.id] = element; }} class="field" aria-label=${t(field.id)} placeholder=${t('resultHint')} spellCheck=${false} value=${field.value} onInput=${event => editField(field.id, event.currentTarget.value)}></textarea>${state.error && state.source === field.id ? html`<p role="alert" class="error">${errorText(state.error)}</p>` : null}</div>`)}
        ${analysis.image ? html`<div class="preview"><div class="image-frame"><img src=${analysis.image} alt=${t('preview')} onLoad=${event => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError=${() => setOperationError({ code: 'INVALID_IMAGE' })} /></div><p class="image-info">${dimensions ? `${dimensions.width} × ${dimensions.height} · ` : ''}${analysis.meta.mime} · ${size(analysis.meta.bytes)}</p></div>` : !analysis.fields.length && (state.input || state.error) ? html`<p class="waiting">${reading ? t('reading') : t('waiting')}</p>` : null}
      </section>
      ${operationError ? html`<p role="alert" class="error notice">${errorText(operationError)}</p>` : null}
      <input ref=${fileInput} type="file" class="file-input" accept="image/png,image/jpeg,image/gif,image/webp" aria-label=${t('choose')} onChange=${event => { void loadFiles([...event.target.files]); event.target.value = ''; }} />
    </main>`;
  }
  render(html`<${App} />`, document.getElementById('app'));
})().catch(error => { document.getElementById('app').textContent = error.message; });
