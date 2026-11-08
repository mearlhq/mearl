(async () => {
  const bridge = window.mearl;
  const context = await bridge.ready();
  const { h, html, render, useState, useEffect, useRef } = bridge.ui;
  const messagesFor = locale => String(locale).startsWith('zh') ? {
    formats: 'PNG、JPEG、WebP', limits: '每张最多 5 MiB', privacy: '图片会上传至 TinyPNG，禁止上传包含敏感信息的图片', images: '图片', items: '张',
    choose: '选择图片', paste: '粘贴', copy: '复制图片', copied: '图片已复制', resume: '继续压缩', pasteHint: '请在工具内按 Ctrl/Cmd+V 粘贴图片', downloadAll: '下载全部', clear: '清空列表',
    importing: '正在导入', queued: '待压缩', compressing: '正在压缩', done: '已压缩', error: '失败', interrupted: '已中断',
    remove: '移除', download: '下载', invalid: '请选择 PNG、JPEG 或 WebP，每张最多 5 MiB', preview: '预览图片', previewTitle: '图片预览', close: '关闭预览', loadMore: '加载更多', loading: '正在读取图片…',
    failed: '操作失败', complete: '压缩完成', saved: '已节省', empty: '拖入图片，自动压缩', emptyHint: '也可选择图片，或按 Ctrl/Cmd+V 粘贴', processing: '处理中',
  } : {
    formats: 'PNG, JPEG, WebP', limits: 'Up to 5 MiB each', privacy: 'Images are uploaded to TinyPNG. Do not upload images containing sensitive information.', images: 'Images', items: 'images',
    choose: 'Choose images', paste: 'Paste', copy: 'Copy image', copied: 'Image copied', resume: 'Resume compression', pasteHint: 'Press Ctrl/Cmd+V inside this tool to paste an image', downloadAll: 'Download all', clear: 'Clear list',
    importing: 'Importing', queued: 'Ready', compressing: 'Compressing', done: 'Compressed', error: 'Failed', interrupted: 'Interrupted',
    remove: 'Remove', download: 'Download', invalid: 'Choose PNG, JPEG or WebP, up to 5 MiB each', preview: 'Preview image', previewTitle: 'Image preview', close: 'Close preview', loadMore: 'Load more', loading: 'Loading image…',
    failed: 'Operation failed', complete: 'Compression complete', saved: 'Saved', empty: 'Drop images to compress automatically', emptyHint: 'Or choose images, or press Ctrl/Cmd+V to paste', processing: 'Processing',
  };
  let messages = messagesFor(context.locale);
  const t = key => messages[key];
  document.documentElement.lang = String(context.locale).startsWith('zh') ? 'zh-CN' : 'en';
  const CHUNK_BYTES = 144 * 1024;
  const button = 'button';
  const smallButton = 'icon-button';
  const busyJob = job => job.state === 'compressing';
  const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  function icon(name, className = 'icon') {
    return html`<svg class=${className} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${window.imageCompressIcons[name].map(([tag, props]) => h(tag, props))}</svg>`;
  }
  async function createThumbnail(blob) {
    let image;
    const canvas = document.createElement('canvas');
    try {
      image = await createImageBitmap(blob);
      if (!image.width || !image.height || image.width * image.height > 16 * 1024 * 1024) return undefined;
      canvas.width = 32; canvas.height = 32;
      const scale = Math.min(32 / image.width, 32 / image.height);
      const width = image.width * scale, height = image.height * scale;
      canvas.getContext('2d').drawImage(image, (32 - width) / 2, (32 - height) / 2, width, height);
      const data = canvas.toDataURL('image/png');
      return data.length <= 8192 ? data : undefined;
    } catch { return undefined; }
    finally { image?.close(); canvas.width = 0; canvas.height = 0; }
  }
  function Thumbnail({ job, readResult, onPreview }) {
    const [generated, setGenerated] = useState('');
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      let active = true;
      setFailed(false);
      if (!job.thumbnail && job.state === 'done') {
        readResult(job.id, 'input').then(({ blob }) => createThumbnail(blob)).then(data => {
          if (active && data) setGenerated(data);
        }).catch(() => {});
      }
      return () => { active = false; };
    }, [job.id, job.thumbnail, job.state === 'done']);
    const source = job.thumbnail || generated;
    return html`<button type="button" class="thumbnail" title=${t('preview')} aria-label=${t('preview')} disabled=${!job.type && job.state !== 'done'} onClick=${() => onPreview(job)}>
      ${source && !failed ? html`<img class="thumbnail-image" src=${source} alt="" onError=${() => setFailed(true)} />` : icon('image', 'icon-large')}
    </button>`;
  }
  function App() {
    const [, setLocale] = useState(context.locale);
    useEffect(() => bridge.onContextChange?.(next => {
      messages = messagesFor(next.locale);
      document.documentElement.lang = String(next.locale).startsWith('zh') ? 'zh-CN' : 'en';
      setLocale(next.locale);
    }), []);
    const [jobs, setJobs] = useState([]);
    const [total, setTotal] = useState(0);
    const [summary, setSummary] = useState({ done: 0, active: 0, originalBytes: 0, outputBytes: 0 });
    const [preview, setPreview] = useState(null);
    const visible = useRef(50), dialog = useRef(null);
    const [loading, setLoading] = useState(true);
    const [adding, setAdding] = useState(false);
    const [working, setWorking] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [copying, setCopying] = useState(null);
    const input = useRef(null), locked = useRef(false), mounted = useRef(true);
    const refresh = async () => {
      const jobs = [];
      let result;
      for (let offset = 0; offset < visible.current; offset += 50) {
        result = await bridge.invoke('list', { offset, limit: 50 });
        jobs.push(...result.jobs);
        if (result.nextOffset == null) break;
      }
      if (mounted.current) {
        setJobs(jobs); setTotal(result.total ?? jobs.length);
        setSummary(result.summary ?? { done: jobs.filter(job => job.state === 'done').length, active: jobs.filter(busyJob).length,
          originalBytes: jobs.filter(job => job.state === 'done').reduce((sum, job) => sum + job.size, 0),
          outputBytes: jobs.filter(job => job.state === 'done').reduce((sum, job) => sum + job.output.size, 0) });
      }
      return jobs;
    };
    const report = error => bridge.invoke('host.toast', { message: `${t('failed')}: ${error.message || error}`, type: 'error' });
    useEffect(() => {
      mounted.current = true;
      refresh().catch(report).finally(() => setLoading(false));
      return () => { mounted.current = false; };
    }, []);
    useEffect(() => {
      if (!summary.active && !working) return;
      let pending = false;
      const timer = setInterval(async () => {
        if (pending) return;
        pending = true;
        try { await refresh(); } catch { /* Operation polling reports failures to the initiating page. */ }
        finally { pending = false; }
      }, 1200);
      return () => clearInterval(timer);
    }, [summary.active, working]);

    async function add(files) {
      if (locked.current || loading) return;
      locked.current = true; setAdding(true);
      const imported = [];
      try {
        await refresh();
        for (const file of files) {
          if (!file.size || file.size > 5 * 1024 * 1024 || !(/^(image\/(png|jpeg|webp))$/.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name))) throw new Error(t('invalid'));
          const thumbnail = await createThumbnail(file);
          const job = await bridge.invoke('begin', { name: file.name, size: file.size, ...(thumbnail ? { thumbnail } : {}) });
          try {
            for (let offset = 0, index = 0; offset < file.size; offset += CHUNK_BYTES, index += 1) {
              const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
              let binary = '';
              for (const byte of bytes) binary += String.fromCharCode(byte);
              await bridge.invoke('append', { id: job.id, index, data: btoa(binary) });
            }
            imported.push(job.id);
            await refresh();
          } catch (error) { await bridge.invoke('remove', { id: job.id }).catch(() => {}); throw error; }
        }
      } catch (error) { report(error); }
      finally { await refresh().catch(report); locked.current = false; setAdding(false); }
      if (imported.length && mounted.current) await compress(imported);
    }
    useEffect(() => {
      const paste = event => {
        const files = [...(event.clipboardData?.files || [])];
        if (files.length) { event.preventDefault(); void add(files); }
      };
      document.addEventListener('paste', paste);
      return () => document.removeEventListener('paste', paste);
    }, [loading]);

    async function paste() {
      try {
        const content = await bridge.invoke('host.clipboard.read');
        if (!content.data?.startsWith('data:image/')) throw new Error(t('pasteHint'));
        const match = content.data.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s);
        if (!match) throw new Error(t('invalid'));
        const binary = atob(match[2]);
        const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
        await add([new File([bytes], `clipboard.${match[1].split('/')[1]}`, { type: match[1] })]);
      } catch (error) { report(error); }
    }
    async function compress(ids) {
      if (locked.current) return;
      locked.current = true; setWorking(true);
      try {
        const started = await bridge.invoke('host.task.start', { command: 'compress-batch', input: { ids } });
        await refresh();
        const result = await bridge.waitTask(started.taskId) || {};
        if (mounted.current) {
          if (result.errors?.length) report(new Error(result.errors[0].error));
          if (result.completed > 0) bridge.invoke('host.toast', { message: t('complete'), type: 'success' });
        }
      } catch (error) { report(error); }
      finally { await refresh().catch(report); locked.current = false; setWorking(false); }
    }
    async function readResult(id, source = 'output') {
      const first = await bridge.invoke('resource-chunk', { id, index: 0, source });
      try {
        const parts = [];
        for (let index = 0; index < first.chunks; index += 1) {
          const chunk = index ? await bridge.invoke('resource-chunk', { id, index, source, ...(first.readId ? { readId: first.readId } : {}) }) : first;
          parts.push(Uint8Array.from(atob(chunk.data), c => c.charCodeAt(0)));
        }
        return { blob: new Blob(parts, { type: first.type }), name: first.name };
      } finally {
        if (first.readId) await bridge.invoke('release-resource', { readId: first.readId }).catch(() => {});
      }
    }
    async function copy(id) {
      setCopying(id);
      try {
        const { blob } = await readResult(id);
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        await bridge.invoke('host.clipboard.writeImage', { data: data });
        bridge.invoke('host.toast', { message: t('copied'), type: 'success' });
      } catch (error) { report(error); }
      finally { setCopying(null); }
    }
    async function download(ids) {
      setDownloading(true);
      try {
        for (const id of ids) {
          const { blob, name } = await readResult(id);
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a'); link.href = url; link.download = name;
          document.body.append(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 30000);
        }
      } catch (error) { report(error); }
      finally { setDownloading(false); }
    }
    async function downloadAll() {
      setDownloading(true);
      try {
        const ids = [];
        for (let offset = 0; ; offset += 50) {
          const result = await bridge.invoke('list', { offset, limit: 50 });
          ids.push(...result.jobs.filter(job => job.state === 'done').map(job => job.id));
          if (result.nextOffset == null) break;
        }
        await download(ids);
      } catch (error) { report(error); }
      finally { setDownloading(false); }
    }
    async function remove(ids) {
      try { for (const id of ids) await bridge.invoke('remove', { id }); await refresh(); }
      catch (error) { report(error); }
    }
    async function openPreview(job) {
      setPreview({ job, url: '' });
      try {
        const { blob } = await readResult(job.id, job.state === 'done' ? 'output' : 'input');
        const url = URL.createObjectURL(blob);
        if (mounted.current) setPreview(current => {
          if (current?.job.id === job.id) return { job, url };
          URL.revokeObjectURL(url); return current;
        });
        else URL.revokeObjectURL(url);
      } catch (error) { report(error); setPreview(current => current?.job.id === job.id ? null : current); }
    }
    useEffect(() => { if (preview && !dialog.current?.open) dialog.current?.showModal(); }, [Boolean(preview)]);
    useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview?.url]);
    const original = summary.originalBytes, compressed = summary.outputBytes;
    const busy = adding || working || summary.active > 0;
    return html`<main class="compress-app"
      onDragOver=${event => { event.preventDefault(); setDragging(true); }}
      onDragLeave=${event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
      onDrop=${event => { event.preventDefault(); setDragging(false); void add([...event.dataTransfer.files]); }}>
      <input ref=${input} class="hidden" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange=${event => { void add([...event.target.files]); event.target.value = ''; }} />
      <header class="page-header">
        <div class="header-copy">
          <div class="page-title">${t('images')}</div>
          <div class="muted">${t('formats')}</div>
        </div>
        <div class="compact-row">
          <button class=${button} disabled=${loading || busy} onClick=${() => input.current.click()}>${icon('image')}${t('choose')}</button>
          <button class=${button} disabled=${loading || busy} onClick=${paste}>${icon('paste')}${t('paste')}</button>
        </div>
      </header>
      ${jobs.length > 0 && html`<div class="batch-toolbar">
        <span class="muted">${busy ? t('processing') : `${total} ${t('items')}`}${summary.done > 0 ? ` · ${summary.done} ${t('done')}` : ''}</span>
        <div class="compact-row">
          <button class=${button} disabled=${!summary.done || downloading} onClick=${downloadAll}>${icon('download')}${t('downloadAll')}</button>
          <button class=${smallButton} disabled=${busy || downloading || copying !== null} title=${t('clear')} aria-label=${t('clear')} onClick=${async () => { try { await bridge.invoke('remove', { all: true }); await refresh(); } catch (error) { report(error); } }}>${icon('trash')}</button>
        </div>
      </div>`}
      <section aria-label=${t('images')} class=${`image-list ${dragging ? 'is-dragging' : jobs.length ? '' : 'is-empty'}`}>
        ${!jobs.length && html`<div class="empty-list">
          <button type="button" aria-label=${t('choose')} disabled=${loading || busy} onClick=${() => input.current.click()} class="empty-action">
            <span class="empty-icon">${icon('image', 'icon-large')}</span>
            <div class="empty-copy"><p class="medium">${adding ? t('importing') : t('empty')}</p><p class="muted">${t('emptyHint')}</p></div>
          </button>
        </div>`}
        <div class="job-list">
          ${jobs.map(job => html`<div key=${job.id} class="job-row">
            <${Thumbnail} job=${job} readResult=${readResult} onPreview=${openPreview} />
            <div class="job-copy">
              <div class="job-name" title=${job.name}>${job.name}</div>
              <div class="job-details"><span>${size(job.size)}${job.state === 'done' ? ` → ${size(job.output.size)}` : ''}</span>
                ${job.output && html`<span class="image-dimensions">${job.output.width} × ${job.output.height}</span>`}
              </div>
            </div>
            <span class=${`job-status ${job.state === 'done' ? 'is-done' : job.state === 'error' || job.state === 'interrupted' ? 'is-error' : ''}`} title=${job.error || t(job.state)}>${job.state === 'done' ? `−${Math.max(0, Math.round(100 * (1 - job.output.size / job.size)))}%` : t(job.state)}</span>
            <div class="actions">
              ${job.state === 'queued' && html`<button class=${smallButton} disabled=${busy} title=${t('resume')} aria-label=${t('resume')} onClick=${() => compress([job.id])}>${icon('retry')}</button>`}
              ${job.state === 'done' && html`<button class=${smallButton} disabled=${copying !== null} title=${t('copy')} aria-label=${t('copy')} onClick=${() => copy(job.id)}>${icon(copying === job.id ? 'loader' : 'copy', copying === job.id ? 'icon spinner' : 'icon')}</button>`}
              ${job.state === 'done' && html`<button class=${smallButton} disabled=${downloading} title=${t('download')} aria-label=${t('download')} onClick=${() => download([job.id])}>${icon('download')}</button>`}
              <button class=${smallButton} disabled=${busy || downloading || copying !== null} title=${t('remove')} aria-label=${t('remove')} onClick=${() => remove([job.id])}>${icon('close')}</button>
            </div>
          </div>`)}
        </div>
        ${jobs.length < total && html`<div class="load-more"><button class=${button} onClick=${async () => { visible.current += 50; await refresh().catch(report); }}>${t('loadMore')} (${total - jobs.length})</button></div>`}
      </section>
      <footer class="page-footer">
        <span>${t('privacy')}</span>
        <span>${summary.done > 0 ? `${t('saved')} ${size(Math.max(0, original - compressed))} (${Math.max(0, Math.round(100 * (1 - compressed / original)))}%)` : t('limits')}</span>
      </footer>
      ${preview && html`<dialog ref=${dialog} aria-label=${t('previewTitle')} class="image-dialog"
        onCancel=${() => setPreview(null)} onClose=${() => setPreview(null)} onClick=${event => { if (event.target === event.currentTarget) setPreview(null); }}>
        <div class="preview-toolbar"><h2 class="preview-title">${t('previewTitle')}</h2>
          <button class="close-preview" aria-label=${t('close')} title=${t('close')} onClick=${() => setPreview(null)}>${icon('close', 'icon-large')}</button>
        </div>
        <div class="preview-body">
          <div class="preview-frame">${preview.url ? html`<img src=${preview.url} alt=${preview.job.name} class="preview-image" onError=${() => { report(new Error(t('invalid'))); setPreview(null); }} />` : html`<span class="muted">${t('loading')}</span>`}</div>
          <div class="preview-name">${preview.job.name}</div>
        </div>
      </dialog>`}
    </main>`;
  }
  render(html`<${App} />`, document.getElementById('app'));
})();
