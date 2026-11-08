// @vitest-environment happy-dom
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTranslation } from '../../immersive-translate/scripts/runtime.mjs';
import { pageRuntime } from '../../immersive-translate/scripts/main.mjs';
import { translateBatch, restoreCache } from '../../immersive-translate/scripts/translation.mjs';

let runtime, host;
const paragraph = 'This is a complete English paragraph with a link that must remain interactive.';
beforeEach(() => {
  vi.useFakeTimers();
  // DOM tests exercise loading UI state, without a real animation timeline.
  vi.spyOn(window.HTMLElement.prototype, 'animate').mockReturnValue({ cancel: vi.fn() });
  vi.stubGlobal('location', window.location);
  vi.stubGlobal('innerHeight', 800);
  vi.spyOn(window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 20, bottom: 70, left: 0, right: 600, width: 600, height: 50 });
  document.documentElement.lang='en';
  document.body.innerHTML=`<main><p id="source">${paragraph} <a href="/help">More information</a></p></main>`;
  host={identity:{instanceId:'fixture'},emit:vi.fn().mockResolvedValue({accepted:true})};
  runtime=installTranslation(host);
});
afterEach(() => { runtime.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const start=options=>runtime.receive({type:'START',targetLang:'zh-CN',maxParagraphs:200,...options});
const take=()=>runtime.receive({type:'TAKE',generation:runtime.receive({type:'STATE'}).generation});
function apply(batch, output='翻译内容') {
  runtime.receive({type:'APPLY',generation:batch.generation,items:batch.items.map(item=>({id:item.id,text:output}))});
  runtime.receive({type:'FINISH',generation:batch.generation});
}

describe('translation document runtime', () => {
  it('translates complementary reading cards and block titles inside lists while keeping navigation excluded', () => {
    document.body.innerHTML='<aside><section><h2>Latest from our changelog</h2><ul><li><div><time>2 days ago</time><a id="story" style="display:flow-root" href="/post">Open source license compliance generally available</a></div></li></ul></section><nav><h2>Personal account navigation</h2><a href="/settings">Change account preferences</a></nav></aside>';
    start();const batch=take();expect(batch.items.map(item=>item.text)).toEqual(['Latest from our changelog','Open source license compliance generally available']);apply(batch,'更新内容');
    expect(document.getElementById('story').querySelector('[data-mearl-translation]').textContent).toBe('更新内容');
    expect(document.querySelector('nav [data-mearl-translation]')).toBeNull();expect(document.querySelector('li > [data-mearl-translation]')).toBeNull();
  });
  it('does not turn control lists, hidden tooltips or screen-reader-only labels into reading paragraphs', () => {
    document.body.innerHTML='<main><ul><li><a href="/fork" style="display:inline-flex">Fork <span>5</span><span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0px,0px,0px,0px)">(5)</span></a><span aria-hidden="true">View your existing forks</span></li><li><button>Star 30</button><span role="tooltip">Star this repository and manage your lists</span><span style="display:none">Additional hidden instructions</span></li><li><button>Watch 2</button><span style="position:absolute;clip-path:inset(50%);width:1px;height:1px;overflow:hidden">Choose notification settings for this repository</span></li></ul><p>Actual article content should still be translated.</p></main>';
    expect(start().paragraphs).toBe(1);expect(take().items.map(item=>item.text)).toEqual(['Actual article content should still be translated.']);
  });
  it('extracts visible source text and code without hidden descendants or SVG titles', () => {
    document.body.innerHTML='<main><p>Visible article text with <code>literal()</code>.<span hidden>Hidden source words</span><span style="display:none"><code>hidden()</code>Hidden prose</span><span style="visibility:hidden">Invisible prose</span><span style="opacity:0">Transparent prose</span><svg><title>Accessible icon description</title></svg></p></main>';
    start();const batch=take();expect(batch.items).toHaveLength(1);expect(batch.items[0]).toMatchObject({text:'Visible article text with literal().',codeLiterals:['literal()']});
  });
  it('keeps readable children when the paragraph uses a zero font size for layout', () => {
    document.body.innerHTML='<main><p style="font-size:0"><span style="font-size:16px">Visible article content inside a layout wrapper.</span></p></main>';
    start();expect(take().items.map(item=>item.text)).toEqual(['Visible article content inside a layout wrapper.']);
  });
  it('keeps visible parent text when a semantic descendant is hidden and rediscovers revealed source', async () => {
    document.body.innerHTML='<main><ul><li>Visible list content remains readable.<p hidden>Extra details are initially hidden.</p></li></ul></main>';
    start();const first=take();expect(first.items.map(item=>item.text)).toEqual(['Visible list content remains readable.']);apply(first);
    document.querySelector('p').hidden=false;await vi.advanceTimersByTimeAsync(220);
    expect(document.querySelector('li > [data-mearl-translation]')).toBeNull();
    expect(take().items.map(item=>item.text)).toContain('Extra details are initially hidden.');
  });
  it('unclamps bilingual title links and restores original truncation on display changes and disposal', () => {
    document.body.innerHTML='<aside><ul><li><a id="story" href="/post" style="display:flow-root;-webkit-line-clamp:2;overflow:hidden">A long article title that should have room for a translation.</a></li></ul></aside>';
    const link=document.getElementById('story');
    // Happy DOM does not accept Chromium's vendor-specific 'none' value.
    const property='-webkit-line-clamp';let value='2',priority='';
    const style=link.style,computed=getComputedStyle(link);
    const get=style.getPropertyValue.bind(style),set=style.setProperty.bind(style),getPriority=style.getPropertyPriority.bind(style),getComputed=computed.getPropertyValue.bind(computed);
    vi.spyOn(style,'getPropertyValue').mockImplementation(name=>name===property?value:get(name));
    vi.spyOn(style,'getPropertyPriority').mockImplementation(name=>name===property?priority:getPriority(name));
    vi.spyOn(style,'setProperty').mockImplementation((name,next,importance)=>{
      if(name===property){value=next;priority=importance??'';}else set(name,next,importance);
    });
    vi.spyOn(computed,'getPropertyValue').mockImplementation(name=>name===property?value:getComputed(name));
    start();apply(take());
    expect(link.style.getPropertyValue('-webkit-line-clamp')).toBe('none');
    runtime.receive({type:'DISPLAY',mode:'original'});expect(link.style.getPropertyValue('-webkit-line-clamp')).toBe('2');
    runtime.receive({type:'DISPLAY',mode:'translated'});expect(link.style.getPropertyValue('-webkit-line-clamp')).toBe('none');
    runtime.dispose();expect(link.style.getPropertyValue('-webkit-line-clamp')).toBe('2');
  });
  it('runs serialized browser translation in the document, previews results and reuses confirmed output', async () => {
    runtime.dispose();document.querySelector('#source a').remove();
    const translator={translate:vi.fn(async()=> '浏览器中的本地译文'),destroy:vi.fn()};
    vi.stubGlobal('Translator',{availability:vi.fn(async()=> 'available'),create:vi.fn(async()=>translator)});
    vi.stubGlobal('LanguageDetector',undefined);
    runtime=new Function('host',`return (${pageRuntime.code})(host)`)(host);
    start({engine:'browser'});const batch=take();expect(batch).toMatchObject({engine:'browser'});expect(batch.items[0].sourceLanguage).toBe('en');
    const output=await runtime.receive({type:'BROWSER_TRANSLATE',generation:batch.generation,ids:batch.items.map(item=>item.id)},{signal:new AbortController().signal});
    expect(output).toEqual({translations:[{id:batch.items[0].id,text:'浏览器中的本地译文'}]});
    expect(document.querySelector('[data-mearl-translation]').textContent).toBe('浏览器中的本地译文');expect(runtime.receive({type:'STATE'}).translated).toBe(0);
    apply(batch,'浏览器中的本地译文');expect(runtime.receive({type:'STATE'})).toMatchObject({engine:'browser',translated:1});
    runtime.dispose();await Promise.resolve();expect(translator.destroy).toHaveBeenCalledOnce();
  });
  it('cancels a document browser translation on restart without applying a late result', async () => {
    runtime.dispose();let resolve;
    const translator={translate:vi.fn(()=>new Promise(done=>{resolve=done;})),destroy:vi.fn()};
    vi.stubGlobal('Translator',{availability:vi.fn(async()=> 'available'),create:vi.fn(async()=>translator)});vi.stubGlobal('LanguageDetector',undefined);
    runtime=new Function('host',`return (${pageRuntime.code})(host)`)(host);start({engine:'browser'});const batch=take();
    const pending=runtime.receive({type:'BROWSER_TRANSLATE',generation:batch.generation,ids:batch.items.map(item=>item.id)}),rejected=expect(pending).rejects.toBeDefined();
    for(let iteration=0;iteration<20&&!resolve;iteration++)await Promise.resolve();expect(resolve).toBeTypeOf('function');
    start({engine:'codex'});await rejected;resolve('迟到的译文');await Promise.resolve();
    expect(document.querySelector('[data-mearl-translation]')).toBeNull();expect(runtime.receive({type:'STATE'})).toMatchObject({engine:'codex',translated:0});
  });
  it('renders previews without marking them translated or caching them, then confirms final text', () => {
    start();const batch=take(),id=batch.items[0].id;
    runtime.receive({type:'PREVIEW',generation:batch.generation,items:[{id,text:'临时译文'}]});
    expect(document.querySelector('[data-mearl-translation]').textContent).toBe('临时译文');
    expect(runtime.receive({type:'STATE'})).toMatchObject({translated:0,pending:1,cached:0});
    runtime.receive({type:'DISCARD',generation:batch.generation,ids:[id]});
    expect(document.querySelector('[data-mearl-translation]')).toBeNull();
    runtime.receive({type:'PREVIEW',generation:batch.generation,items:[{id,text:'重新生成'}]});
    runtime.receive({type:'APPLY',generation:batch.generation,items:[{id,text:'最终译文'}]});
    expect(document.querySelector('[data-mearl-translation]').textContent).toBe('最终译文');
    expect(runtime.receive({type:'STATE'})).toMatchObject({translated:1,pending:0});
    runtime.receive({type:'DISCARD',generation:batch.generation,ids:[id]});
    expect(document.querySelector('[data-mearl-translation]').textContent).toBe('最终译文');
  });
  it('discards failed previews, restores layout and rejects old-generation previews after restart', () => {
    runtime.dispose();document.body.innerHTML='<main><h3 style="display:flex"><time>OCT.02 </time><span>IMPROVEMENT</span></h3></main>';runtime=installTranslation(host);
    start();const batch=take(),items=batch.items.map(item=>({id:item.id,text:'临时译文'}));
    runtime.receive({type:'PREVIEW',generation:batch.generation,items});
    expect(document.querySelector('[data-mearl-translation]')).not.toBeNull();expect(document.querySelector('h3').style.flexWrap).toBe('wrap');
    runtime.receive({type:'FAIL',generation:batch.generation,error:'invalid final output'});
    expect(document.querySelector('[data-mearl-translation]')).toBeNull();expect(document.querySelector('h3').style.flexWrap).toBe('');
    start();expect(document.querySelector('[data-mearl-translation]')).toBeNull();
    expect(runtime.receive({type:'PREVIEW',generation:batch.generation,items})).toEqual({stale:true});
    expect(runtime.receive({type:'STATE'})).toMatchObject({translated:0,cached:0});
  });
  it('keeps fragmented paragraphs hidden until every fragment has complete text', () => {
    document.getElementById('source').textContent='A long English paragraph with content. '.repeat(80);
    start();const batch=take();expect(batch.items.length).toBeGreaterThan(1);
    runtime.receive({type:'PREVIEW',generation:batch.generation,items:[{id:batch.items[0].id,text:'第一片段'}]});
    expect(document.querySelector('[data-mearl-translation]')).toBeNull();
    runtime.receive({type:'PREVIEW',generation:batch.generation,items:batch.items.slice(1).map(item=>({id:item.id,text:'后续片段'}))});
    expect(document.querySelector('[data-mearl-translation]').textContent).toContain('第一片段');
    runtime.dispose();expect(document.querySelector('[data-mearl-translation]')).toBeNull();
  });
  it('shows a delayed loading indicator for queued or in-flight paragraphs and removes it when results arrive', async () => {
    const source=document.getElementById('source'),link=source.querySelector('a');
    start();await vi.advanceTimersByTimeAsync(179);expect(source.querySelector('[data-mearl-translation-loading]')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);const batch=take();
    const indicator=source.querySelector('[data-mearl-translation-loading]');
    expect(indicator.parentElement).toBe(link);expect(indicator.getAttribute('aria-hidden')).toBe('true');
    expect(link.lastElementChild).toBe(indicator);expect(indicator.style.pointerEvents).toBe('none');
    await vi.advanceTimersByTimeAsync(220);expect(runtime.receive({type:'STATE'})).toMatchObject({paragraphs:1,pending:1});expect(host.emit).toHaveBeenCalledOnce();
    apply(batch);expect(source.querySelector('[data-mearl-translation-loading]')).toBeNull();expect(source.querySelector('a')).toBe(link);
    expect(source.querySelector('[data-mearl-translation]').textContent).toBe('翻译内容');
  });
  it('does not flash loading for fast cache hits or add a flex item beside the original labels', async () => {
    start();apply(take());await vi.advanceTimersByTimeAsync(200);expect(document.querySelector('[data-mearl-translation-loading]')).toBeNull();
    runtime.dispose();document.body.innerHTML='<main><h3 style="display:flex;font-size:30px"><time>OCT.02 </time><span id="badge" style="font-size:12px">IMPROVEMENT</span></h3></main>';runtime=installTranslation(host);
    const badge=document.getElementById('badge');start();take();await vi.advanceTimersByTimeAsync(200);
    expect(badge.querySelector('[data-mearl-translation-loading]')).not.toBeNull();expect(document.querySelector('h3').children).toHaveLength(2);expect(document.querySelector('h3').style.flexWrap).toBe('');
    runtime.dispose();expect(document.querySelector('[data-mearl-translation-loading]')).toBeNull();
  });
  it('respects reduced motion and cancels running indicator animations on completion', async () => {
    const create=document.createElement.bind(document),cancel=vi.fn(),animate=vi.fn(()=>({cancel}));
    vi.spyOn(document,'createElement').mockImplementation((...args)=>{const node=create(...args);if(args[0]==='span')node.animate=animate;return node;});
    const media=vi.spyOn(window,'matchMedia').mockReturnValue({matches:true});
    start();const batch=take();await vi.advanceTimersByTimeAsync(200);
    expect(document.querySelector('[data-mearl-translation-loading]')).not.toBeNull();expect(animate).not.toHaveBeenCalled();
    media.mockReturnValue({matches:false});runtime.receive({type:'DISPLAY',mode:'original'});runtime.receive({type:'DISPLAY',mode:'bilingual'});
    expect(animate).toHaveBeenCalledOnce();apply(batch);expect(cancel).toHaveBeenCalledOnce();
  });
  it('cleans up loading on display changes, failure, source replacement and disposal, and restores it on retry', async () => {
    start();let batch=take();await vi.advanceTimersByTimeAsync(200);
    runtime.receive({type:'DISPLAY',mode:'original'});expect(document.querySelector('[data-mearl-translation-loading]')).toBeNull();
    runtime.receive({type:'DISPLAY',mode:'bilingual'});expect(document.querySelector('[data-mearl-translation-loading]')).not.toBeNull();
    runtime.receive({type:'FAIL',generation:batch.generation,error:'model unavailable'});runtime.receive({type:'FINISH',generation:batch.generation});
    expect(document.querySelector('[data-mearl-translation-loading]')).toBeNull();
    runtime.receive({type:'RETRY'});await vi.advanceTimersByTimeAsync(220);batch=take();await vi.advanceTimersByTimeAsync(200);
    expect(document.querySelector('[data-mearl-translation-loading]')).not.toBeNull();
    document.getElementById('source').textContent='A replacement English paragraph requiring a new translation.';await vi.advanceTimersByTimeAsync(220);
    expect(document.querySelector('[data-mearl-translation-loading]')).toBeNull();apply(batch);
    expect(document.querySelector('[data-mearl-translation]')).toBeNull();
    take();runtime.dispose();await vi.advanceTimersByTimeAsync(500);
    expect(document.querySelector('[data-mearl-translation-loading]')).toBeNull();
  });
  it('preserves original nodes and link behavior, escapes output, toggles and fully cleans up', () => {
    const source=document.getElementById('source'), link=source.querySelector('a');
    expect(start().paragraphs).toBe(1); expect(host.emit).toHaveBeenCalledOnce();
    const batch=take(); apply(batch,'<img src=x onerror=alert(1)> 译文');
    const translated=document.querySelector('[data-mearl-translation]');
    expect(translated.textContent).toContain('<img'); expect(translated.querySelector('img')).toBeNull();
    expect(source.querySelector('a')).toBe(link); expect(translated.parentElement).toBe(source); expect(source.nextElementSibling).toBeNull();
    runtime.receive({type:'DISPLAY',mode:'original'}); expect(translated.hidden).toBe(true); expect(translated.style.display).toBe('none');
    runtime.receive({type:'DISPLAY',mode:'bilingual'}); expect(translated.hidden).toBe(false); expect(translated.style.display).toBe('block');
    runtime.dispose(); expect(document.querySelector('[data-mearl-translation]')).toBeNull(); expect(link.isConnected).toBe(true);
  });
  it('shows only translated text after it arrives and restores source node identities and listeners across display modes', async () => {
    const source=document.getElementById('source'), original=[...source.childNodes], link=source.querySelector('a'), click=vi.fn(event=>event.preventDefault());
    link.style.setProperty('display','inline','important');link.addEventListener('click',click);
    start();const batch=take();runtime.receive({type:'DISPLAY',mode:'translated'});
    expect(source.childNodes[0]).toBe(original[0]);expect(link.style.display).toBe('inline');
    apply(batch,'只显示译文');
    const translated=source.querySelector('[data-mearl-translation]');
    expect(translated.hidden).toBe(false);expect(translated.style.marginTop).toBe('0px');
    expect(source.querySelector('[data-mearl-translation-source]').firstChild).toBe(original[0]);
    expect(link.style.display).toBe('none');
    await vi.advanceTimersByTimeAsync(220);
    expect(runtime.receive({type:'STATE'})).toMatchObject({mode:'translated',translated:1,paragraphs:1,pending:0});
    runtime.receive({type:'DISPLAY',mode:'bilingual'});
    expect(source.querySelector('[data-mearl-translation-source]')).toBeNull();expect(source.childNodes[0]).toBe(original[0]);
    expect(link.style.display).toBe('inline');expect(link.style.getPropertyPriority('display')).toBe('important');
    expect(translated.style.marginTop).toBe('0.5em');link.click();expect(click).toHaveBeenCalledOnce();
    runtime.receive({type:'DISPLAY',mode:'translated'});runtime.receive({type:'DISPLAY',mode:'original'});
    expect(translated.hidden).toBe(true);expect(source.childNodes[0]).toBe(original[0]);expect(link.style.display).toBe('inline');
    runtime.receive({type:'DISPLAY',mode:'translated'});runtime.dispose();
    expect([...source.childNodes]).toEqual(original);expect(link.style.display).toBe('inline');
  });
  it('restores originals when translated previews fail and does not hide pending or failed paragraphs', () => {
    const source=document.getElementById('source'), original=[...source.childNodes];
    start();const batch=take(),id=batch.items[0].id;runtime.receive({type:'DISPLAY',mode:'translated'});
    runtime.receive({type:'PREVIEW',generation:batch.generation,items:[{id,text:'临时译文'}]});
    expect(source.querySelector('a').style.display).toBe('none');
    runtime.receive({type:'FAIL',generation:batch.generation,error:'invalid final output'});
    expect([...source.childNodes]).toEqual(original);expect(source.querySelector('a').style.display).toBe('');
    expect(source.querySelector('[data-mearl-translation]')).toBeNull();
    expect(runtime.receive({type:'STATE'})).toMatchObject({mode:'translated',translated:0,status:'error'});
  });
  it('invalidates changed hidden text and restores source styles without overwriting page changes', async () => {
    const source=document.getElementById('source'),link=source.querySelector('a');
    start();apply(take());runtime.receive({type:'DISPLAY',mode:'translated'});
    link.style.display='inline-block';source.querySelector('[data-mearl-translation-source]').firstChild.textContent='A revised English paragraph must be translated again. ';
    await vi.advanceTimersByTimeAsync(220);
    expect(source.querySelector('[data-mearl-translation]')).toBeNull();expect(source.querySelector('[data-mearl-translation-source]')).toBeNull();
    expect(link.style.display).toBe('inline-block');expect(take().items[0].text).toContain('revised English paragraph');
    expect(runtime.receive({type:'STATE'}).mode).toBe('translated');
  });
  it('keeps a translated standalone link interactive and preserves flex typography without a bilingual gap', () => {
    document.body.innerHTML='<main><a id="title" href="/post" style="display:block;font-size:18px">An article title that can be translated.</a><h3 style="display:flex;flex-wrap:nowrap"><span style="font-size:12px">An article metadata label.</span></h3></main>';
    const link=document.getElementById('title'),click=vi.fn(event=>event.preventDefault());link.addEventListener('click',click);
    start();apply(take());runtime.receive({type:'DISPLAY',mode:'translated'});
    const translated=link.querySelector('[data-mearl-translation]');translated.click();expect(click).toHaveBeenCalledOnce();expect(link.style.display).toBe('block');
    const meta=document.querySelector('h3');expect(meta.style.flexWrap).toBe('nowrap');
    expect(meta.querySelector('[data-mearl-translation]').style.fontSize).toBe('12px');
    expect(meta.querySelector('[data-mearl-translation]').style.marginTop).toBe('0px');
  });
  it('hides source line breaks and restores the latest page-owned display styles', async () => {
    document.body.innerHTML='<main><p>An English paragraph with line breaks.<br><span>Additional source content.</span></p></main>';
    const source=document.querySelector('p'),label=source.querySelector('span'),line=source.querySelector('br');
    start();apply(take());runtime.receive({type:'DISPLAY',mode:'translated'});
    expect(line.style.display).toBe('none');label.style.display='inline-flex';
    await vi.advanceTimersByTimeAsync(220);expect(label.style.display).toBe('none');
    runtime.receive({type:'DISPLAY',mode:'bilingual'});
    expect(label.style.display).toBe('inline-flex');expect(line.style.display).toBe('');
  });
  it('discards outdated text, deleted elements and results from another generation', async () => {
    start(); const old=take();
    document.getElementById('source').textContent='A new source paragraph has replaced the original article text.';
    apply(old); expect(document.querySelector('[data-mearl-translation]')).toBeNull();
    await vi.advanceTimersByTimeAsync(220);
    const current=take(); expect(current.items[0].text).toContain('new source');
    start({targetLang:'ja'}); apply(current); expect(document.querySelector('[data-mearl-translation]')).toBeNull();
    const deleted=take(); document.getElementById('source').remove(); apply(deleted);
    expect(document.querySelector('[data-mearl-translation]')).toBeNull();
  });
  it('handles dynamic additions and restores removed translation nodes without a new model batch', async () => {
    start(); apply(take()); await vi.advanceTimersByTimeAsync(220);
    expect(host.emit).toHaveBeenCalledOnce();
    document.querySelector('[data-mearl-translation]').remove();
    window.dispatchEvent(new Event('scroll')); await vi.advanceTimersByTimeAsync(220);
    expect(document.querySelector('[data-mearl-translation]')).not.toBeNull();
    const added=document.createElement('p'); added.textContent='Dynamically loaded article text should be translated without the popup.'; document.querySelector('main').append(added);
    await vi.advanceTimersByTimeAsync(220);
    expect(take().items.map(item=>item.text)).toEqual([added.textContent]);
  });
  it('skips forms, code, nested parents, hidden and already translated text and bounds batch size', () => {
    document.body.innerHTML=`<main><pre><p>${paragraph}</p></pre><div contenteditable><p>${paragraph}</p></div><p hidden>${paragraph}</p><p translate="no">${paragraph}</p><p>这是已经写好的中文正文，不应该再次翻译成中文。</p><blockquote><p>${paragraph}</p></blockquote></main>`;
    expect(start().paragraphs).toBe(1);
    runtime.dispose(); document.body.innerHTML='<main>'+Array.from({length:20},(_,i)=>`<p>${i}: ${paragraph}</p>`).join('')+'</main>'; runtime=installTranslation(host);
    expect(start({maxParagraphs:10}).paragraphs).toBe(10); const batch=take(); expect(batch.items).toHaveLength(4);
    expect(batch.items.reduce((sum,item)=>sum+item.text.length,0)).toBeLessThanOrEqual(6000);
  });
  it('splits long paragraphs losslessly, prioritizes viewport text and respects table/list structures', () => {
    const long=paragraph.repeat(50);
    document.body.innerHTML=`<main><p id="long">${long}</p></main>`;
    start(); const chunks=[]; let batches=0;
    while (runtime.receive({type:'STATE'}).pending) { const batch=take(); batches++; chunks.push(...batch.items.map(item=>item.text)); apply(batch); }
    expect(chunks.join('')).toBe(long); expect(batches).toBe(1);
    runtime.dispose(); document.body.innerHTML=`<main><ul><li id="item">${paragraph}</li></ul><table><tbody><tr><td id="cell">${paragraph}</td></tr></tbody></table></main>`; runtime=installTranslation(host); start(); apply(take());
    expect(document.getElementById('item').querySelector('[data-mearl-translation]')).not.toBeNull();
    expect(document.getElementById('cell').querySelector('[data-mearl-translation]')).not.toBeNull();
  });
  it('places flex-row translations on their own row using visible label typography and restores wrapping on toggle and stop', () => {
    document.body.innerHTML='<main><h3 id="meta" style="display:flex;align-items:center;font-size:30px;flex-wrap:nowrap !important"><time style="font-size:12px;font-weight:400">OCT.02 </time><span style="font-size:12px;font-weight:400">IMPROVEMENT</span></h3></main>';
    const meta=document.getElementById('meta'),time=meta.querySelector('time'),badge=meta.querySelector('span');
    expect(start().paragraphs).toBe(1);apply(take(),'10月02日 改进');
    const translated=meta.querySelector('[data-mearl-translation]');
    expect(translated.style.flex).toBe('0 0 100%');expect(translated.style.width).toBe('100%');
    expect(translated.style.fontSize).toBe('12px');expect(translated.style.fontWeight).toBe('400');
    expect(meta.style.flexWrap).toBe('wrap');expect(meta.style.getPropertyPriority('flex-wrap')).toBe('important');
    runtime.receive({type:'DISPLAY',mode:'original'});
    expect(translated.style.display).toBe('none');expect(meta.style.flexWrap).toBe('nowrap');expect(meta.style.getPropertyPriority('flex-wrap')).toBe('important');
    runtime.receive({type:'DISPLAY',mode:'bilingual'});expect(meta.style.flexWrap).toBe('wrap');
    runtime.dispose();expect(meta.style.flexWrap).toBe('nowrap');expect(meta.children).toHaveLength(2);expect(meta.children[0]).toBe(time);expect(meta.children[1]).toBe(badge);
  });
  it('spans grid translations across columns and keeps column-flex text in its existing flow', () => {
    document.body.innerHTML='<main><h3 id="grid" style="display:grid;grid-template-columns:1fr 1fr"><span style="font-size:12px">OCT.02 </span><span>IMPROVEMENT</span></h3><p id="column" style="display:flex;flex-direction:column"><span style="font-size:18px">A readable column paragraph.</span></p></main>';
    expect(start().paragraphs).toBe(2);apply(take());
    const grid=document.getElementById('grid'),column=document.getElementById('column');
    expect(grid.querySelector('[data-mearl-translation]').style.gridColumn).toBe('1 / -1');
    expect(grid.querySelector('[data-mearl-translation]').style.fontSize).toBe('12px');expect(grid.style.gridTemplateColumns).toBe('1fr 1fr');
    expect(column.querySelector('[data-mearl-translation]').style.flex).toBe('');expect(column.style.flexWrap).toBe('');
    expect(column.querySelector('[data-mearl-translation]').style.fontSize).toBe('18px');
  });
  it('adapts translation placement after responsive layout changes without overwriting page-owned styles on cleanup', async () => {
    document.body.innerHTML='<main><h3 id="meta" style="display:flex"><span style="font-size:12px">OCT.02 IMPROVEMENT</span></h3></main>';
    const meta=document.getElementById('meta');start();apply(take());
    meta.style.display='block';window.dispatchEvent(new Event('resize'));await vi.advanceTimersByTimeAsync(220);
    const translated=meta.querySelector('[data-mearl-translation]');
    expect(meta.style.flexWrap).toBe('');expect(translated.style.flex).toBe('');expect(translated.style.width).toBe('');expect(translated.style.fontSize).toBe('inherit');
    meta.style.display='flex';window.dispatchEvent(new Event('resize'));await vi.advanceTimersByTimeAsync(220);expect(meta.style.flexWrap).toBe('wrap');
    meta.style.setProperty('flex-wrap','wrap-reverse','important');runtime.dispose();expect(meta.style.flexWrap).toBe('wrap-reverse');
  });
  it('keeps partial failures out of pending progress and continues later text while retrying only failed fragments', async () => {
    document.body.innerHTML='<main><p>First successful paragraph.</p><p>Persistent failure paragraph.</p><p>Later successful paragraph.</p></main>';
    start({engine:'browser'});const batch=take(),[first,failed,last]=batch.items;
    runtime.receive({type:'PREVIEW',generation:batch.generation,items:[{id:failed.id,text:'未确认译文'}]});
    runtime.receive({type:'APPLY',generation:batch.generation,items:[{id:first.id,text:'成功译文'},{id:last.id,text:'后续译文'}]});
    runtime.receive({type:'FAIL_ITEMS',generation:batch.generation,items:[{id:failed.id,error:'Native failure'}]});
    runtime.receive({type:'FINISH',generation:batch.generation});
    expect(runtime.receive({type:'STATE'})).toMatchObject({status:'partial',translated:2,pending:0,failed:1,error:null,failureError:'Native failure'});
    expect(document.querySelectorAll('[data-mearl-translation]')).toHaveLength(2);expect(document.body.textContent).not.toContain('未确认译文');
    document.querySelector('main').insertAdjacentHTML('beforeend','<p>New content after a failure.</p>');await vi.advanceTimersByTimeAsync(220);
    const next=take();expect(next.items.map(item=>item.text)).toEqual(['New content after a failure.']);apply(next);
    runtime.receive({type:'RETRY'});await vi.advanceTimersByTimeAsync(220);const retry=take();expect(retry.items.map(item=>item.id)).toEqual([failed.id]);
    apply(retry);expect(runtime.receive({type:'STATE'})).toMatchObject({status:'watching',translated:4,pending:0,failed:0});
    expect(document.querySelectorAll('[data-mearl-translation]')).toHaveLength(4);
  });
  it('stops automatically after a failure and retries only failed fragments', async () => {
    start(); const batch=take();
    runtime.receive({type:'FAIL',generation:batch.generation,error:'model unavailable'}); runtime.receive({type:'FINISH',generation:batch.generation});
    await vi.advanceTimersByTimeAsync(500); expect(host.emit).toHaveBeenCalledOnce();
    expect(runtime.receive({type:'STATE'}).status).toBe('error');
    runtime.receive({type:'RETRY'}); await vi.advanceTimersByTimeAsync(220);
    expect(take().items.map(item=>item.id)).toEqual(batch.items.map(item=>item.id));
  });
  it('discovers every article and non-semantic description in feeds without a main element', () => {
    document.body.innerHTML=`<div><h2>Explore the Topic</h2><div><span>Libraries, packages, and automation tools for common development tasks.</span></div><article><h2>First article title for developers</h2><p>${paragraph}</p></article><article><h2>Second article title for developers</h2><p>${paragraph}</p></article><nav><div>A navigation description should never be translated.</div></nav><div><a href="/topics"><span>Explore navigation topics</span></a></div></div>`;
    const value=start(); expect(value.paragraphs).toBe(6); expect(value.detected).toBe(6);
    const batch=take(); expect(batch.items.map(item=>item.text)).toContain('Explore the Topic');
    expect(batch.items.map(item=>item.text)).toContain('Second article title for developers');
    expect(batch.items.some(item=>item.text.includes('navigation'))).toBe(false);
  });
  it('translates standalone block links in reading content while preserving the original link and compact filters', () => {
    document.body.innerHTML=`<main><article><div style="display:flex"><a id="title" style="display:block" href="/post">Improved detection for withdrawn Dependabot alerts</a><a id="filter" style="display:flex" href="/?label=security">Supply chain security</a></div><p>An article paragraph with an <a href="/inline">inline content link</a>.</p><a id="nested" href="/nested"><h3>Another article heading</h3></a></article></main><nav><a style="display:block" href="/posts">Browse all articles</a></nav>`;
    const link=document.getElementById('title'), click=vi.fn(event=>event.preventDefault());link.addEventListener('click',click);
    expect(start().paragraphs).toBe(3); const batch=take();
    expect(batch.items.map(item=>item.text)).toEqual(expect.arrayContaining(['Improved detection for withdrawn Dependabot alerts','Another article heading']));
    expect(batch.items.some(item=>/Supply chain|Browse all/.test(item.text))).toBe(false);
    apply(batch);const translated=link.querySelector('[data-mearl-translation]');
    translated.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    expect(click).toHaveBeenCalledOnce();expect(document.getElementById('title')).toBe(link);expect(link.getAttribute('href')).toBe('/post');
    expect(document.getElementById('nested').querySelectorAll('[data-mearl-translation]')).toHaveLength(1);
    expect(document.getElementById('filter').querySelector('[data-mearl-translation]')).toBeNull();
  });
  it('recognizes chapter links inside navigation and keeps bilingual labels together beside flex markers', () => {
    document.body.innerHTML=`<aside><nav><ul><li><a id="toc" href="${location.href}#chapter" style="display:flex"><span id="marker"></span><span id="label">How it works</span></a></li></ul></nav></aside><main><h2 id="chapter">How it works</h2></main>`;
    const link=document.getElementById('toc'), marker=document.getElementById('marker'),label=document.getElementById('label');
    expect(start().paragraphs).toBe(2);const batch=take();expect(batch.items.map(item=>item.text)).toEqual(['How it works','How it works']);apply(batch,'工作原理');
    expect(label.querySelector('[data-mearl-translation]')?.textContent).toBe('工作原理');
    expect(link.children).toHaveLength(2);expect(link.firstElementChild).toBe(marker);expect(label.parentElement).toBe(link);
    runtime.receive({type:'DISPLAY',mode:'original'});expect(label.querySelector('[data-mearl-translation]').style.display).toBe('none');
    runtime.dispose();expect(label.textContent).toBe('How it works');expect(link.children).toHaveLength(2);
  });
  it('does not treat site menus, external hashes, non-heading fragments or explicitly excluded chapters as reading navigation', () => {
    document.body.innerHTML=`<nav><a href="${location.href}#content">Skip to content</a><a href="https://other.test/#chapter">An external chapter link</a><a href="${location.href}#missing">A missing chapter link</a><a href="${location.href}#blocked">An excluded chapter link</a><a href="${location.href}#chapter" translate="no">Do not translate this label</a><div role="menu"><a href="${location.href}#chapter">A menu command for chapter</a></div><a href="#%zz">Malformed fragment encoding</a></nav><main><div id="content">A normal content container.</div><h2 id="chapter">How it works</h2><h2 id="blocked" translate="no">Excluded chapter heading</h2></main>`;
    expect(start().paragraphs).toBe(2);expect(take().items.map(item=>item.text)).toEqual(expect.arrayContaining(['A normal content container.','How it works']));
  });
  it('discovers dynamic chapter targets and drops translations when a target no longer identifies reading content', async () => {
    document.body.innerHTML=`<nav><a id="toc" href="${location.href}#chapter">How to try it</a></nav><main></main>`;
    expect(start().paragraphs).toBe(0);
    document.querySelector('main').innerHTML='<section id="chapter"><h2>How to try it</h2></section>';
    await vi.advanceTimersByTimeAsync(220);const batch=take();expect(batch.items).toHaveLength(2);apply(batch,'如何试用');
    expect(document.getElementById('toc').querySelector('[data-mearl-translation]')).not.toBeNull();
    document.getElementById('chapter').remove();await vi.advanceTimersByTimeAsync(220);
    expect(document.getElementById('toc').querySelector('[data-mearl-translation]')).toBeNull();
  });
  it('counts cached and pending paragraphs rather than fragments and admits visible text before the limit', () => {
    document.body.innerHTML=`<main><p id="far">${paragraph}</p><p id="near">${paragraph.repeat(45)}</p></main>`;
    document.getElementById('far').getBoundingClientRect=()=>({top:5000,bottom:5050,width:600,height:50});
    const value=start({maxParagraphs:1}); expect(value.detected).toBe(2); expect(value.limited).toBe(0); expect(value.deferred).toBe(1); expect(value.pending).toBe(1);
    while(runtime.receive({type:'STATE'}).pending) {
      const batch=take(); expect(batch.items[0].text).not.toBe(paragraph);
      runtime.receive({type:'APPLY',generation:batch.generation,items:batch.items.map(item=>({id:item.id,text:'缓存译文',cached:true}))});
      runtime.receive({type:'FINISH',generation:batch.generation});
    }
    const result=runtime.receive({type:'STATE'}); expect(result.cached).toBe(1); expect(result.translated).toBe(1); expect(result.status).toBe('watching');
    expect(document.getElementById('near').querySelector('[data-mearl-translation]')?.dataset.mearlTranslation).toBe('fixture');
    expect(document.getElementById('far').querySelector('[data-mearl-translation]')?.dataset.mearlTranslation).toBeUndefined();
  });
  it('translates the viewport before prefetching one screen and admits distant paragraphs only after scrolling', async () => {
    document.body.innerHTML='<main><p id="current">Current screen article content.</p><p id="next">Next screen article content.</p><p id="far">Distant screen article content.</p><p id="above">Previous screen article content.</p></main>';
    const positions={current:20,next:900,far:1700,above:-100};
    for (const [id] of Object.entries(positions)) document.getElementById(id).getBoundingClientRect=()=>({top:positions[id],bottom:positions[id]+50,width:600,height:50});
    expect(start()).toMatchObject({paragraphs:2,detected:4,deferred:2});
    const first=take();expect(first.items.map(item=>item.text)).toEqual(['Current screen article content.']);
    expect(runtime.receive({type:'TAKE',generation:first.generation,afterBatch:true}).items).toEqual([]);
    apply(first);const second=take();expect(second.items.map(item=>item.text)).toEqual(['Next screen article content.']);apply(second);
    expect(document.getElementById('far').querySelector('[data-mearl-translation]')).toBeNull();
    positions.current=-1600;positions.next=-800;positions.far=100;window.dispatchEvent(new Event('scroll'));await vi.advanceTimersByTimeAsync(220);
    expect(take().items.map(item=>item.text)).toEqual(['Distant screen article content.']);
    expect(document.getElementById('current').querySelector('[data-mearl-translation]')).not.toBeNull();
  });
  it('releases unstarted offscreen work on a fast scroll so it cannot consume the paragraph budget', async () => {
    document.body.innerHTML='<main><p id="first">First screen article content.</p><p id="second">Second screen article content.</p></main>';
    let scrolled=false;
    document.getElementById('first').getBoundingClientRect=()=>({top:scrolled?-100:20,bottom:scrolled?-50:70,width:600,height:50});
    document.getElementById('second').getBoundingClientRect=()=>({top:scrolled?20:2000,bottom:scrolled?70:2050,width:600,height:50});
    expect(start({maxParagraphs:1})).toMatchObject({paragraphs:1,deferred:1});scrolled=true;window.dispatchEvent(new Event('scroll'));await vi.advanceTimersByTimeAsync(220);
    expect(runtime.receive({type:'STATE'})).toMatchObject({paragraphs:1,deferred:1,limited:0});expect(take().items.map(item=>item.text)).toEqual(['Second screen article content.']);
  });
  it('resumes lazy translation from viewport intersections without relying on window scroll delivery and disconnects on stop', async () => {
    runtime.dispose();let intersect;const observe=vi.fn(),unobserve=vi.fn(),disconnect=vi.fn();
    vi.stubGlobal('IntersectionObserver',class { constructor(callback){intersect=callback;}observe=observe;unobserve=unobserve;disconnect=disconnect; });
    document.body.innerHTML='<main><p id="first">First screen article content.</p><p id="next">Distant screen article content.</p></main>';
    let scrolled=false;
    document.getElementById('first').getBoundingClientRect=()=>({top:scrolled?-100:20,bottom:scrolled?-50:70,width:600,height:50});
    document.getElementById('next').getBoundingClientRect=()=>({top:scrolled?20:3000,bottom:scrolled?70:3050,width:600,height:50});
    runtime=installTranslation(host);start();apply(take());expect(observe).toHaveBeenCalledTimes(2);
    scrolled=true;intersect([{isIntersecting:true,target:document.getElementById('next')}]);await vi.advanceTimersByTimeAsync(220);
    expect(take().items.map(item=>item.text)).toEqual(['Distant screen article content.']);expect(observe).toHaveBeenCalledTimes(2);
    document.getElementById('first').remove();intersect([]);await vi.advanceTimersByTimeAsync(220);expect(unobserve).toHaveBeenCalledOnce();
    runtime.dispose();expect(disconnect).toHaveBeenCalledOnce();
  });
  it('resumes reading-area work when a background document becomes visible again', async () => {
    document.body.innerHTML='<main><p id="source">A paragraph moved into view while the document was hidden.</p></main>';
    let top=3000;document.getElementById('source').getBoundingClientRect=()=>({top,bottom:top+50,width:600,height:50});
    expect(start()).toMatchObject({paragraphs:0,deferred:1,status:'watching'});
    top=20;document.dispatchEvent(new Event('visibilitychange'));await vi.advanceTimersByTimeAsync(220);
    expect(take().items).toHaveLength(1);
    runtime.dispose();expect(document.querySelector('[data-mearl-translation]')).toBeNull();
  });
  it('restores cached prefetch text without waiting for current-screen model work', async () => {
    document.body.innerHTML='<main><p id="current">Current screen article content.</p><p id="next">Next screen article content.</p></main>';
    document.getElementById('next').getBoundingClientRect=()=>({top:900,bottom:950,width:600,height:50});
    const cache=new Map(),state=vi.fn(async(_collection,operation,input)=>{
      if(operation==='get-many')return {entries:input.keys.map(key=>({key,exists:cache.has(key),version:'v:1',value:cache.get(key)}))};
      for(const entry of input.transaction.operations)cache.set(entry.key,entry.value);return {};
    });
    const model=vi.fn(async options=>({output:{translations:JSON.parse(options.prompt).paragraphs.map(item=>({id:item.id,text:'缓存译文'}))}}));
    const context={signal:new AbortController().signal,state,model,page:{send:async message=>runtime.receive(message)}};
    const run=()=>translateBatch({event:{payload:{generation:runtime.receive({type:'STATE'}).generation}}},context);
    start();await run();await run();
    document.getElementById('current').firstChild.textContent='Updated current screen article content.';
    start();model.mockClear();state.mockClear();
    model.mockImplementationOnce(async options=>{
      expect(document.getElementById('next').querySelector('[data-mearl-translation]')?.textContent).toBe('缓存译文');
      expect(JSON.parse(options.prompt).paragraphs.map(item=>item.text)).toEqual(['Updated current screen article content.']);
      return {output:{translations:JSON.parse(options.prompt).paragraphs.map(item=>({id:item.id,text:'当前屏译文'}))}};
    });
    await run();expect(state.mock.calls.filter(([,operation])=>operation==='get-many')).toHaveLength(3);
    expect(document.getElementById('next').querySelector('[data-mearl-translation]')?.textContent).toBe('缓存译文');
    await run();expect(document.getElementById('next').querySelector('[data-mearl-translation]')?.textContent).toBe('缓存译文');expect(model).toHaveBeenCalledOnce();
  });
  it('reports no matching text without claiming completion and invalidates same-document navigation results', async () => {
    document.body.innerHTML='<main><p>这是中文正文，所以没有需要翻译的内容。</p></main>';
    expect(start().status).toBe('empty');
    document.body.innerHTML=`<main><p>${paragraph}</p></main>`; start(); const old=take();
    vi.stubGlobal('location',{href:'https://example.test/next'});
    runtime.receive({type:'host:navigation'}); await vi.advanceTimersByTimeAsync(220);
    apply(old); expect(document.querySelector('[data-mearl-translation]')).toBeNull();
    expect(take().generation).toBeGreaterThan(old.generation);
  });

  it('includes inline code in the source and rebuilds only safe code nodes in the translation', () => {
    document.body.innerHTML='<main><p id="source">Assign the <code onclick="throw 1">Enterprise Open-Source License Manager</code> role to <a href="/teams">qualified teams</a>.</p></main>';
    const source=document.getElementById('source'), originalCode=source.querySelector('code'), link=source.querySelector('a');
    start(); const batch=take();
    expect(batch.items[0].text).toContain('Enterprise Open-Source License Manager');
    expect(batch.items[0].codeLiterals).toEqual(['Enterprise Open-Source License Manager']);
    apply(batch, '将 Enterprise Open-Source License Manager 角色分配给团队。Enterprise Open-Source License Manager <img src=x>');
    const translated=source.querySelector('[data-mearl-translation]');
    expect(translated.querySelector('code').textContent).toBe(originalCode.textContent);
    expect(translated.querySelector('code').getAttribute('onclick')).toBeNull();
    expect(translated.querySelectorAll('code')).toHaveLength(1);
    expect(translated.querySelector('img')).toBeNull(); expect(translated.textContent).toContain('<img src=x>');
    expect(source.querySelector('a')).toBe(link);
    expect(source.querySelector('code')).toBe(originalCode);
    expect(runtime.receive({type:'STATE'}).translated).toBe(1);
  });
  it('keeps inline code intact across long paragraph batches', () => {
    const literal='Enterprise Open-Source License Manager';
    document.body.innerHTML=`<main><p>${'A complete English sentence. '.repeat(56)}<code>${literal}</code>${' More explanation.'.repeat(20)}</p></main>`;
    const original=document.querySelector('p').textContent; start(); const chunks=[]; let batches=0;
    while(runtime.receive({type:'STATE'}).pending) {
      const batch=take();
      for(const item of batch.items) { expect(item.text.length).toBeLessThanOrEqual(1600); chunks.push(item); }
      apply(batch, literal);
    }
    expect(chunks.map(item=>item.text).join('')).toBe(original);
    expect(chunks.filter(item=>item.codeLiterals?.includes(literal))).toHaveLength(1);
  });

  it('drains follow-up batches immediately while preserving the first-batch size and cancellation guard', () => {
    document.body.innerHTML='<main>'+Array.from({length:20},(_,i)=>`<p>${i}: ${paragraph}</p>`).join('')+'</main>';
    start(); const first=take(); expect(first.items).toHaveLength(4);
    runtime.receive({type:'APPLY',generation:first.generation,items:first.items.map(item=>({id:item.id,text:'缓存译文'}))});
    const next=runtime.receive({type:'TAKE',generation:first.generation,afterBatch:true}); expect(next.items).toHaveLength(8);
    expect(host.emit).toHaveBeenCalledOnce();
    start({targetLang:'ja'});
    expect(runtime.receive({type:'TAKE',generation:first.generation,afterBatch:true})).toEqual({stale:true});
  });

  it('replays 500 cached paragraphs with bounded workers and bulk reads instead of per-paragraph file reads', async () => {
    document.body.innerHTML='<main>'+Array.from({length:500},(_,i)=>`<p>${i}: ${paragraph}</p>`).join('')+'</main>';
    const state=vi.fn(async(_collection,operation,input)=>{
      expect(operation).toBe('get-many');
      return {entries:input.keys.map(key=>({key,exists:true,version:'v:1',value:{text:'缓存译文'}}))};
    });
    const model=vi.fn(), signal=new AbortController().signal;
    start({maxParagraphs:500});let workers=0;
    while(runtime.receive({type:'STATE'}).pending) {
      await translateBatch({event:{payload:{generation:runtime.receive({type:'STATE'}).generation}}},{signal,state,model,page:{send:async message=>runtime.receive(message)}});workers++;
      if(workers>3)throw new Error('Cache drain did not finish');
    }
    expect(runtime.receive({type:'STATE'})).toMatchObject({translated:500,cached:500,pending:0});
    expect(workers).toBe(1);expect(state.mock.calls.length).toBeLessThanOrEqual(32);expect(model).not.toHaveBeenCalled();
  });

});

it('does not starve detection during continuous scroll and skips structural discovery on viewport-only updates',async()=>{
  document.body.innerHTML='<main><p id="first">The first screen remains busy waiting for its translation.</p><p id="second">The next screen must be detected while scrolling continues.</p></main>';
  let top=2500;document.getElementById('second').getBoundingClientRect=()=>({top,bottom:top+50,width:600,height:50});
  start();take();await vi.advanceTimersByTimeAsync(100);
  const query=vi.spyOn(document.body,'querySelectorAll');top=100;
  for(let i=0;i<12;i++){window.dispatchEvent(new Event('scroll'));await vi.advanceTimersByTimeAsync(20);}
  expect(runtime.receive({type:'STATE'}).paragraphs).toBe(2);
  expect(host.emit).toHaveBeenCalledWith('cache',expect.any(Object));
  expect(document.getElementById('second').querySelector('[data-mearl-translation-loading]')).not.toBeNull();
  expect(query).not.toHaveBeenCalled();
});
it('restores newly visible persistent cache while an earlier model request is still unresolved',async()=>{
  document.body.innerHTML='<main><p id="first">The first screen needs an uncached model translation.</p><p id="second">The second screen already has a persistent cached translation.</p></main>';
  let top=2500;const second=document.getElementById('second');second.getBoundingClientRect=()=>({top,bottom:top+50,width:600,height:50});
  const key=createHash('sha256').update(JSON.stringify(['v1','zh-CN','default',second.textContent])).digest('hex'),cache=new Map([[key,{text:'第二屏缓存译文'}]]);
  const state=async(_collection,operation,input)=>{
    if(operation==='get-many')return {entries:input.keys.map(key=>({key,exists:cache.has(key),version:'v:1',value:cache.get(key)}))};
    for(const entry of input.transaction.operations)cache.set(entry.key,entry.value);return {};
  };
  let resolve,request;const model=vi.fn(options=>{request=options;return new Promise(done=>{resolve=done;});});
  const context={signal:new AbortController().signal,state,model,page:{send:async message=>runtime.receive(message)}};
  const input=()=>({event:{payload:{generation:runtime.receive({type:'STATE'}).generation}}});
  const tasks=[];host.emit.mockImplementation(async event=>{if(event==='cache')tasks.push(restoreCache(input(),context));return {accepted:true};});
  start();const work=translateBatch(input(),context);await vi.advanceTimersByTimeAsync(1);expect(resolve).toBeTypeOf('function');
  top=100;window.dispatchEvent(new Event('scroll'));await vi.advanceTimersByTimeAsync(70);await Promise.all(tasks);
  expect(second.querySelector('[data-mearl-translation]')?.textContent).toBe('第二屏缓存译文');
  expect(document.getElementById('first').querySelector('[data-mearl-translation]')).toBeNull();
  expect(model).toHaveBeenCalledOnce();expect(runtime.receive({type:'STATE'}).busy).toBe(true);
  resolve({output:{translations:JSON.parse(request.prompt).paragraphs.map(item=>({id:item.id,text:'首屏译文'}))}});await work;
});
it('restores recreated paragraphs from bounded page memory without another background request',async()=>{
  const source=document.getElementById('source'),original=source.innerHTML;start();apply(take(),'已译内容');
  source.remove();const replacement=document.createElement('p');replacement.innerHTML=original;document.querySelector('main').append(replacement);
  await vi.advanceTimersByTimeAsync(70);
  expect(replacement.querySelector('[data-mearl-translation]')?.textContent).toBe('已译内容');
  expect(host.emit.mock.calls.filter(([event])=>event==='work')).toHaveLength(1);
  start({model:'different-model'});expect(replacement.querySelector('[data-mearl-translation]')).toBeNull();
  expect(runtime.receive({type:'STATE'}).pending).toBe(1);
});

it('takes the next model batch from the new viewport instead of reserving all earlier screen work',async()=>{
  document.body.innerHTML='<main>'+Array.from({length:7},(_,i)=>`<p id="old-${i}">Unique paragraph number ${i} on the earlier screen needs translation.</p>`).join('')+'<p id="new">The new viewport paragraph needs priority over old offscreen text.</p></main>';
  let moved=false;for(const element of document.querySelectorAll('p'))element.getBoundingClientRect=()=>{const top=element.id==='new' ? moved?100:3000 : moved?-1000:20;return {top,bottom:top+50,width:600,height:50};};
  const cache=new Map(),state=async(_collection,operation,input)=>{if(operation==='get-many')return {entries:input.keys.map(key=>({key,exists:cache.has(key),version:'v:1',value:cache.get(key)}))};for(const item of input.transaction.operations)cache.set(item.key,item.value);return {};};
  let release,first;const model=vi.fn(async request=>{
    const result={output:{translations:JSON.parse(request.prompt).paragraphs.map(item=>({id:item.id,text:'译文'}))}};
    if(!first){first=request;return new Promise(resolve=>{release=()=>resolve(result);});}return result;
  });
  start();const context={signal:new AbortController().signal,state,model,page:{send:async message=>runtime.receive(message)}};
  const work=translateBatch({event:{payload:{generation:runtime.receive({type:'STATE'}).generation}}},context);
  await vi.advanceTimersByTimeAsync(1);expect(release).toBeTypeOf('function');
  moved=true;window.dispatchEvent(new Event('scroll'));await vi.advanceTimersByTimeAsync(70);
  release();await work;expect(model).toHaveBeenCalledTimes(2);
  expect(JSON.parse(model.mock.calls[1][0].prompt).paragraphs.map(item=>item.text)).toEqual(['The new viewport paragraph needs priority over old offscreen text.']);
});
it('keeps cache lookup available after model failure without retrying the model',async()=>{
  start();const batch=take();runtime.receive({type:'FAIL',generation:batch.generation,error:'Model failed'});runtime.receive({type:'FINISH',generation:batch.generation});
  const extra=document.createElement('p');extra.textContent='A newly visible paragraph may already have a cached translation.';document.querySelector('main').append(extra);
  await vi.advanceTimersByTimeAsync(70);expect(host.emit).toHaveBeenCalledWith('cache',{generation:batch.generation});
  const peek=runtime.receive({type:'PEEK',generation:batch.generation});
  runtime.receive({type:'APPLY',generation:batch.generation,items:peek.items.map(item=>({id:item.id,text:'缓存译文',cached:true}))});
  expect(extra.querySelector('[data-mearl-translation]')?.textContent).toBe('缓存译文');expect(runtime.receive({type:'STATE'}).error).toBe('Model failed');
});
