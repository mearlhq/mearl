(async () => {
  const bridge = window.mearl;
  let context = await bridge.ready();
  const { html, render, useState, useEffect, useLayoutEffect, useRef } = bridge.ui;
  const dictionary = locale => String(locale).startsWith('zh') ? {
    auto:'本站自动翻译', language:'翻译为', model:'翻译模型', customModel:'自定义模型', effort:'思考级别', effortDefault:'跟随模型', effortNone:'不思考', effortMinimal:'极低', effortLow:'低（更快）', effortMedium:'中', effortHigh:'高', effortXhigh:'更高', effortMax:'最高',
    startPage:'翻译本页', stopPage:'停止本页翻译', start:'开启本站翻译', stop:'关闭本站并恢复原文', stopShort:'关闭本站翻译', restart:'重新翻译当前页', restartShort:'重新翻译', apply:'应用并重译',
    defaultModel:'跟随本机配置', engine:'翻译引擎', autoEngine:'自动', autoHint:'当前屏快速显示译文，Codex 完成后自动替换，并预翻译下一屏。', refining:'Codex 翻译中', paused:'切回网页后继续', refined:'Codex 译文', codexFallback:'Codex 暂不可用，继续使用浏览器译文。', browserFallback:'浏览器内置暂不可用，继续使用 Codex。', codex:'Codex', browser:'浏览器内置', preparing:'正在准备本地翻译', downloading:'正在下载语言包', activation:'请在网页中点击一下', activationHint:'首次使用需要在网页中点击或按键，才能下载本地语言包。', browserUnavailable:'当前浏览器或网页不支持内置翻译，请使用受支持的桌面 Chrome 和安全网页，或选择本机 Codex。', languageUnknown:'无法识别原文语言，请选择本机 Codex。', emptyTranslation:'浏览器未返回译文，请重试。',
    modelsFailed:'模型列表暂不可用，可使用默认配置或自定义模型。',
    bilingual:'双语', original:'原文', translated:'译文', readingArea:'当前阅读区域', queued:'准备翻译', translating:'正在翻译', watching:'当前区域已完成',
    initializing:'等待页面就绪', empty:'暂无需要翻译的正文', limited:'已达到本页段落上限', error:'翻译中断', partial:'部分段落未译', failedParagraphs:'未译', idle:'尚未开始',
    done:'已译', pending:'待译', cached:'缓存', detected:'页面已识别', deferred:'段随滚动翻译', paragraphs:'段',
    floating:'页面悬浮开关', advanced:'更多设置', limit:'本页最多翻译', retry:'重试失败段落', skipped:'段因长度或数量限制跳过', failed:'操作失败',
    noPage:'请在要翻译的普通网页上打开此工具。', loading:'读取页面状态',
  } : {
    auto:'Auto-translate this site', language:'Translate to', model:'Translation model', customModel:'Custom model', effort:'Reasoning effort', effortDefault:'Model default', effortNone:'None', effortMinimal:'Minimal', effortLow:'Low (faster)', effortMedium:'Medium', effortHigh:'High', effortXhigh:'Extra high', effortMax:'Maximum',
    startPage:'Translate this page', stopPage:'Stop page translation', start:'Enable for this site', stop:'Disable site and restore original', stopShort:'Disable for this site', restart:'Translate this page again', restartShort:'Translate again', apply:'Apply and translate',
    defaultModel:'Use local settings', engine:'Translation engine', autoEngine:'Auto', autoHint:'Fast visible translations, replaced by Codex when ready. Codex also prepares the next screen.', refining:'Translating with Codex', paused:'Resumes when the tab is visible', refined:'Codex translations', codexFallback:'Codex is unavailable. Browser translations remain available.', browserFallback:'Browser translation is unavailable. Continuing with Codex.', codex:'Codex', browser:'Browser built-in', preparing:'Preparing local translation', downloading:'Downloading language pack', activation:'Click anywhere on the webpage', activationHint:'First use requires a click or key press on the webpage to download the local language pack.', browserUnavailable:'Built-in translation is unavailable in this browser or page. Use a supported desktop Chrome on a secure page, or select local Codex.', languageUnknown:'Could not identify the source language. Select local Codex.', emptyTranslation:'The browser returned no translation. Please retry.',
    modelsFailed:'Model list unavailable. Use your local configuration or enter a custom model.',
    bilingual:'Bilingual', original:'Original', translated:'Translated', readingArea:'Current reading area', queued:'Preparing translation', translating:'Translating', watching:'Reading area complete',
    initializing:'Waiting for the page', empty:'No text needs translation', limited:'Paragraph limit reached', error:'Translation interrupted', partial:'Some paragraphs failed', failedParagraphs:'Failed', idle:'Not started',
    done:'Translated', pending:'Pending', cached:'Cached', detected:'Detected on page', deferred:'paragraphs translate as you scroll', paragraphs:'paragraphs',
    floating:'Floating page switch', advanced:'More settings', limit:'Paragraph limit', retry:'Retry failed paragraphs', skipped:'paragraphs skipped by length or count limits', failed:'Operation failed',
    noPage:'Open this tool from the webpage you want to translate.', loading:'Reading page status',
  };
  function App() {
    const [locale,setLocale] = useState(context.locale), [tabId,setTabId] = useState(null), [site,setSite] = useState('');
    const [models,setModels] = useState([]), [modelsError,setModelsError] = useState(false), [customModel,setCustomModel] = useState(false);
    const [engine,setEngine] = useState(null), modelsLoaded = useRef(false);
    const [initialized,setInitialized] = useState(false), [floating,setFloating] = useState(false);
    const [targetLang,setTargetLang] = useState('zh-CN'), [model,setModel] = useState(''), [limit,setLimit] = useState(200), [reasoningEffort,setReasoningEffort] = useState('low');
    const [state,setState] = useState(null), [busy,setBusy] = useState(true), [error,setError] = useState('');
    const t = dictionary(locale), epoch = useRef(0), updates = useRef(0), writing = useRef(false), saves = useRef(Promise.resolve()), settingsRevision = useRef(0);
    useEffect(() => bridge.onContextChange?.(next => { context=next; setLocale(next.locale); }), []);
    const errorText=value => { const text=String(value || ''); return text.includes('BROWSER_TRANSLATION_UNAVAILABLE')?t.browserUnavailable:text.includes('BROWSER_TRANSLATION_LANGUAGE_UNKNOWN')?t.languageUnknown:text.includes('BROWSER_TRANSLATION_EMPTY')?t.emptyTranslation:text; };
    const report = failure => { if (!failure.handledByHost) setError(errorText(failure.message || failure)); };
    useEffect(() => { if (!['codex','auto'].includes(engine) || modelsLoaded.current) return; let cancelled=false; setModelsError(false);
      void bridge.invoke('host.model.list',{provider:'codex'}).then(value => {
        if (!Array.isArray(value?.models)) throw new Error('Invalid model list');
        if (!cancelled) { setModels(value.models); modelsLoaded.current=true; }
      }).catch(() => { if (!cancelled) setModelsError(true); });
      return () => { cancelled=true; };
    }, [engine]);
    useLayoutEffect(() => { let cancelled=false; const current=++epoch.current;
      void (async () => {
        const active=await bridge.invoke('host.tab.active');
        const supported=active && /^https?:\/\//.test(active.url);
        if (cancelled) return;
        setTabId(supported ? active.tabId : null);setSite(supported ? new URL(active.url).host : '');
        const initial=supported ? await bridge.invoke('bootstrap',{tabId:active.tabId}) : {preferences:await bridge.invoke('preferences'),state:null};
        if (cancelled || current!==epoch.current) return;
        const preferences=initial.preferences;
        setEngine(preferences.engine ?? 'codex');setTargetLang(preferences.targetLang);setModel(preferences.model || '');setLimit(preferences.maxParagraphs);setReasoningEffort(preferences.reasoningEffort ?? 'low');setFloating(preferences.floating ?? false);
        setState(initial.state);
      })().catch(failure=>{if(!cancelled){setEngine('codex');report(failure);}}).finally(()=>{if(!cancelled){setBusy(false);setInitialized(true);}});
      return () => { cancelled=true;epoch.current++; };
    }, []);
    useEffect(() => {
      if (!state?.instanceId) return;
      let cancelled=false, stop, timer, pollTimer, refreshing=false;
      const instanceId=state.instanceId, current=epoch.current;
      const refresh=async () => {
        if (cancelled || refreshing || writing.current) return; refreshing=true; const revision=updates.current;
        try { const value=await bridge.invoke('host.page.send',{instanceId,message:{type:'STATE'}}); if (!cancelled && current===epoch.current && revision===updates.current) { setState(previous=>({...previous,...value,instanceId})); if (value.enabled && (value.pending || value.busy || value.refining)) { clearTimeout(pollTimer); pollTimer=setTimeout(refresh,750); } } }
        catch (failure) {
          if (cancelled) return;
          try { const instance=await bridge.invoke('host.page.get',{instanceId}); if (!cancelled && current===epoch.current && revision===updates.current) { if (instance.state!=='active') setState(previous=>({...previous,enabled:false,status:'idle',instanceId:null})); else report(failure); } }
          catch { if (!cancelled && current===epoch.current && revision===updates.current) report(failure); }
        }
        finally { refreshing=false; }
      };
      void bridge.subscribe('page',{instanceId},event => {
        if (cancelled || current!==epoch.current) return;
        if (event.type==='connection-error') { setError(event.error?.message || t.failed); return; }
        clearTimeout(timer);
        if (event.type==='invalidated') { updates.current++; setState(previous=>({...previous,enabled:false,status:'idle',instanceId:null})); return; }
        if (event.type==='running') { clearTimeout(pollTimer); pollTimer=setTimeout(refresh,0); return; }
        if (event.type==='received') return;
        timer=setTimeout(refresh,120);
      }).then(unsubscribe => { if (cancelled) unsubscribe(); else stop=unsubscribe; }).catch(failure=>{if(!cancelled)report(failure);});
      void refresh();
      window.addEventListener('focus',refresh);
      return () => { cancelled=true; stop?.(); clearTimeout(timer); clearTimeout(pollTimer); window.removeEventListener('focus',refresh); };
    }, [state?.instanceId]);
    const save=patch => {
      const revision=++settingsRevision.current, current=epoch.current;
      saves.current=saves.current.then(()=>bridge.invoke('settings',patch)).catch(failure=>{ if(revision===settingsRevision.current && current===epoch.current) report(failure); });
    };
    const run=async (command,input={}) => {
      if (writing.current) return;
      writing.current=true; const revision=++updates.current;
      setBusy(true); setError(''); const current=epoch.current;
      try { await saves.current; const value=await bridge.invoke(command,{tabId,...input}); if (current===epoch.current && revision===updates.current) setState(previous=>({...previous,...value})); }
      catch (failure) { if (current===epoch.current && revision===updates.current) report(failure); }
      finally { writing.current=false; setBusy(false); }
    };
    const enabled=Boolean(state?.enabled), siteEnabled=state?.siteEnabled ?? enabled;
    const status=enabled ? state.status : siteEnabled ? 'initializing' : 'idle';
    const changed=enabled && ((state.engine ?? 'codex')!==engine || state.targetLang!==targetLang || state.maxParagraphs!==limit || ['codex','auto'].includes(engine) && ((state.model || '')!==model.trim() || (state.reasoningEffort ?? 'low')!==reasoningEffort));
    const browserStatus=enabled && !state.error && ['browser','auto'].includes(state.engine) && (state.engine!=='auto' || state.pending>0) ? state.browserState?.status : null;
    const statusText=state?.engine!=='auto' && browserStatus==='activation-required'?t.activation:state?.engine!=='auto' && browserStatus==='downloading'?t.downloading+(Number.isFinite(state.browserState.progress)?' '+Math.round(Math.max(0,Math.min(1,state.browserState.progress))*100)+'%':''):t[status] || status;
    const modelChoice=customModel || model && (modelsLoaded.current || modelsError) && !models.some(option=>option.id===model) ? '__custom__' : model;
    const translated=state?.translated ?? 0, pending=state?.pending ?? 0, cached=state?.cached ?? 0;
    const paragraphs=state?.paragraphs ?? translated+pending;
    const selectedModel=models.find(option=>model ? option.id===model : option.isDefault);
    const efforts=selectedModel?.reasoningEfforts ?? ['low','medium','high'];
    const effortNames={default:t.effortDefault,none:t.effortNone,minimal:t.effortMinimal,low:t.effortLow,medium:t.effortMedium,high:t.effortHigh,xhigh:t.effortXhigh,max:t.effortMax};
    const selectModel=value=>{
      setCustomModel(value==='__custom__'); if(value==='__custom__')return;
      setModel(value); const next=models.find(option=>value ? option.id===value : option.isDefault);
      const effort=reasoningEffort==='default' || !next?.reasoningEfforts || next.reasoningEfforts.includes(reasoningEffort) ? reasoningEffort : next.reasoningEfforts.includes('low') ? 'low' : 'default';
      setReasoningEffort(effort);save({model:value,reasoningEffort:effort});
    };
    const start=(pageOnly=false)=>run(pageOnly?'start-page':'start',{engine:engine || 'codex',targetLang,maxParagraphs:limit,model:model.trim(),reasoningEffort});
    if (!initialized) return html`<main class="startup" aria-busy="true" aria-label=${t.loading}>
      <div class="site-bar"><span class="skeleton skeleton-title"></span><span class="skeleton skeleton-action"></span></div>
      <div class="fields">${[0,1,2,3].map(()=>html`<div class="skeleton-field"><span class="skeleton skeleton-label"></span><span class="skeleton skeleton-input"></span></div>`)}</div>
      <span class="skeleton skeleton-label"></span>
    </main>`;
    return html`<main>
      <section class="site-bar">
        <div class="site-copy"><strong class="site-name" title=${state?.site || site}>${state?.site || site || t.loading}</strong></div>
        <div class="site-actions">
          ${!siteEnabled && html`<button class=${'button site-action'+(enabled?'':' primary')} disabled=${busy || tabId===null} onClick=${()=>enabled?run('stop-page'):start(true)}>${enabled?t.stopPage:t.startPage}</button>`}
          <button class="button site-action" aria-label=${siteEnabled?t.stop:t.start} title=${siteEnabled?t.stop:t.start} disabled=${busy || tabId===null} onClick=${()=>siteEnabled?run('stop'):start()}>${siteEnabled?t.stopShort:t.start}</button>
        </div>
      </section>
      <section class="preferences">
        <div class="fields"><label>${t.language}<span class="select-field"><select aria-label=${t.language} value=${targetLang} disabled=${busy} onChange=${event=>{setTargetLang(event.target.value);save({targetLang:event.target.value});}}>
          <option value="zh-CN">简体中文</option><option value="en">English</option><option value="ja">日本語</option><option value="ko">한국어</option>
        </select></span></label><div class="field"><span>${t.engine}</span><div class="display-toggle engine-toggle" role="group" aria-label=${t.engine}>
          ${['auto','codex','browser'].map(value=>html`<button type="button" class=${(engine || 'codex')===value?'selected':''} aria-pressed=${(engine || 'codex')===value} disabled=${busy} onClick=${()=>{if(engine===value)return;setEngine(value);save({engine:value});}}>${value==='auto'?t.autoEngine:t[value]}</button>`)}
        </div></div></div>
        ${['codex','auto'].includes(engine) && html`<div class="fields model-fields"><label>${t.model}<span class="select-field"><select aria-label=${t.model} value=${modelChoice} disabled=${busy} onChange=${event=>{
          selectModel(event.target.value);
        }}><option value="">${t.defaultModel}</option>
          ${modelChoice!=='__custom__' && model && !models.some(option=>option.id===model) && html`<option value=${model}>${model}</option>`}
          ${models.map(option=>html`<option value=${option.id} title=${option.description || option.id}>${option.displayName}</option>`)}
          <option value="__custom__">${t.customModel}</option>
        </select></span></label>
        <label>${t.effort}<span class="select-field"><select aria-label=${t.effort} value=${reasoningEffort} disabled=${busy} onChange=${event=>{setReasoningEffort(event.target.value);save({reasoningEffort:event.target.value});}}>
          ${[...new Set(['default',...efforts,reasoningEffort])].map(value=>html`<option value=${value} disabled=${value!=='default' && !efforts.includes(value)}>${effortNames[value] || value}</option>`)}
        </select></span></label></div>`}
        ${['codex','auto'].includes(engine) && modelChoice==='__custom__' && html`<label>${t.customModel}<input aria-label=${t.customModel} value=${model} placeholder=${t.defaultModel} disabled=${busy} onInput=${event=>setModel(event.target.value)} onBlur=${event=>save({model:event.target.value.trim()})} /></label>`}
        ${['codex','auto'].includes(engine) && modelsError && html`<p class="field-note">${t.modelsFailed}</p>`}
        ${engine==='auto' && html`<p class="field-note">${t.autoHint}</p>`}
      </section>
      ${!busy && tabId===null && html`<p class="muted">${t.noPage}</p>`}
      ${enabled || siteEnabled ? html`<section class="status" aria-label=${t.readingArea} aria-live="polite">
        <div class="status-heading"><span class="status-label"><i class=${'status-dot'+(['queued','translating','refining','initializing'].includes(status)?' is-busy':'')+(status==='error'?' is-error':'')} aria-hidden="true"></i>${statusText}</span>
          ${enabled && html`<div class="display-toggle" aria-label=${t.readingArea}>${['bilingual','original','translated'].map(mode=>html`<button class=${state.mode===mode?'selected':''} aria-pressed=${state.mode===mode} disabled=${busy} onClick=${()=>run('display',{mode})}>${t[mode]}</button>`)}</div>`}
        </div>
        ${enabled && html`<div class="progress-summary"><span>${t.done} <strong>${translated}</strong><span class="muted"> / ${paragraphs} ${t.paragraphs}</span></span><span class="muted">${t.pending} ${pending}${state.failed>0 && html` · ${t.failedParagraphs} ${state.failed}`}</span></div>
          <progress aria-label=${t.readingArea} max=${Math.max(1,paragraphs)} value=${translated}></progress>
          ${state.engine==='auto' && html`<div class="page-summary"><span>${t.refined} ${state.refined ?? 0} / ${paragraphs} ${t.paragraphs}</span></div>`}
          ${(state.deferred>0 || cached>0) && html`<div class="page-summary">${state.deferred>0 && html`<span>${state.deferred} ${t.deferred}</span>`}${cached>0 && html`<span>${t.cached} ${cached} ${t.paragraphs}</span>`}</div>`}
          ${browserStatus==='activation-required' && html`<p class="field-note">${t.activationHint}</p>`}
          ${state.skipped>0 && html`<p class="muted">${state.skipped} ${t.skipped}</p>`}
          ${state.warning && html`<p class="field-note" title=${errorText(state.warning)}>${state.warningEngine==='codex'?t.codexFallback:t.browserFallback}</p>`}
          ${(state.error || state.failed>0) && html`<p class="error">${errorText(state.error || state.failureError)}</p>`}
          ${(state.error || state.failed>0 || state.warning) && html`<button class="button" disabled=${busy} onClick=${()=>run('retry')}>${t.retry}</button>`}`}
      </section>` : null}
      ${error && html`<p class="error" role="alert">${t.failed}：${error}</p>`}
      <div class="footer"><details class="more-settings"><summary>${t.advanced}</summary><div class="settings-body">
        <label class="limit-row">${t.limit}<span class="select-field"><select aria-label=${t.limit} value=${String(limit)} disabled=${busy} onChange=${event=>{setLimit(Number(event.target.value));save({maxParagraphs:Number(event.target.value)});}}>
          ${[...new Set([50,200,500,limit])].sort((a,b)=>a-b).map(value=>html`<option value=${String(value)}>${value} ${t.paragraphs}</option>`)}
        </select></span></label>
        <label class="limit-row">${t.floating}<input type="checkbox" aria-label=${t.floating} checked=${floating} disabled=${busy} onChange=${event=>{const value=event.target.checked;setFloating(value);save({floating:value,tabId});}} /></label>
      </div></details>
      ${(enabled || siteEnabled) && html`<button class=${'button'+(changed?' primary':'')} aria-label=${t.restart} disabled=${busy || tabId===null} onClick=${()=>start(!siteEnabled)}>${changed?t.apply:t.restartShort}</button>`}</div>
    </main>`;
  }
  render(html`<${App}/>`,document.getElementById('app'));
})();
