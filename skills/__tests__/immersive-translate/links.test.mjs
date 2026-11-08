// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLinkMarkup } from '../../immersive-translate/scripts/links.mjs';
import { installTranslation } from '../../immersive-translate/scripts/runtime.mjs';
import { pageRuntime } from '../../immersive-translate/scripts/main.mjs';
import { translateBatch } from '../../immersive-translate/scripts/translation.mjs';

const markup = createLinkMarkup();
const wrapped = (id, text) => markup.marker(id) + text + markup.marker(id, true);
let runtime, host;
beforeEach(() => {
  vi.useFakeTimers();vi.stubGlobal('location',window.location);vi.stubGlobal('innerHeight',800);
  vi.spyOn(window.HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({top:20,bottom:70,left:0,right:600,width:600,height:50});
  document.documentElement.lang='en';document.body.innerHTML='<main><p>Learn more about <a href="https://docs.example.test/rules#push">configuring push rulesets</a>.</p></main>';
  host={identity:{instanceId:'links-fixture'},emit:vi.fn(async()=>({accepted:true}))};runtime=installTranslation(host);
});
afterEach(()=>{runtime.dispose();document.head.innerHTML='';vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
const start=(engine='auto')=>{runtime.receive({type:'START',engine,targetLang:'zh-CN',maxParagraphs:200});return runtime.receive({type:'TAKE',generation:runtime.receive({type:'STATE'}).generation});};
const apply=(batch,text,lane='codex',type='APPLY')=>runtime.receive({type,lane,generation:batch.generation,items:[{id:batch.items[0].id,text}]});
const node=()=>document.querySelector('[data-mearl-translation]');

it('preserves translated inline links through native preview, Codex confirmation and display changes',()=>{
  const original=document.querySelector('p a');original.target='_blank';original.rel='noreferrer';original.className='article-link';original.setAttribute('onclick','throw new Error("must not copy handlers")');
  const batch=start();expect(batch.items[0]).toMatchObject({text:'Learn more about configuring push rulesets.',links:[{id:0,start:17,end:42}]});
  runtime.receive({type:'TAKE',lane:'browser',generation:batch.generation});
  apply(batch,'详细了解'+wrapped(0,'如何配置推送规则集')+'。','browser');
  const preview=node(),link=preview.querySelector('a');expect(link.textContent).toBe('如何配置推送规则集');expect(link.href).toBe(original.href);expect(link.target).toBe('_blank');expect(link.rel).toBe('noreferrer');expect(link.className).toBe('article-link');expect(link.hasAttribute('style')).toBe(false);expect(link.hasAttribute('onclick')).toBe(false);
  expect(preview.style.textDecoration).toContain('dashed');const color=preview.style.color;
  apply(batch,'详细了解'+wrapped(0,'配置推送规则集')+'。');expect(node().style.color).toBe(color);expect(node().style.textDecoration).not.toContain('dashed');expect(node().querySelector('a').href).toBe(original.href);
  runtime.receive({type:'DISPLAY',mode:'translated'});expect(original.style.display).toBe('none');expect(node().querySelector('a').getAttribute('style')).toBeNull();
  runtime.receive({type:'DISPLAY',mode:'bilingual'});expect(original.style.display).not.toBe('none');expect(document.querySelector('p a')).toBe(original);
});
it('keeps repeated labels mapped to their own destinations, permits reordering and renders code safely inside links',()=>{
  document.body.innerHTML='<main><p>Use <a href="/first"><code>rules()</code></a> or <a href="/second">rules()</a> to continue reading.</p></main>';
  const batch=start('codex');expect(batch.items[0].links.map(link=>link.id)).toEqual([0,1]);
  apply(batch,'先看'+wrapped(1,'rules()')+'，再看'+wrapped(0,'rules()')+' <img src=x onerror=alert(1)>');
  expect([...node().querySelectorAll('a')].map(a=>a.getAttribute('href'))).toEqual([new URL('/second',document.baseURI).href,new URL('/first',document.baseURI).href]);
  expect(node().querySelector('img')).toBeNull();expect(node().textContent).toContain('<img');expect(node().querySelectorAll('a')[0].querySelector('code')).toBeNull();expect(node().querySelectorAll('a')[1].querySelector('code')).not.toBeNull();
});
it('keeps link ranges aligned across normalized whitespace, hidden text and long paragraph chunks',()=>{
  document.body.innerHTML='<main><p>  Learn\n more about <a href="/rules"> configuring <span hidden>hidden label</span><strong>push</strong>   rulesets </a> now.</p></main>';
  let batch=start('codex'),part=batch.items[0];expect(part.text).toBe('Learn more about configuring push rulesets now.');expect(markup.encode(part)).toBe('Learn more about '+wrapped(0,'configuring push rulesets ')+'now.');
  document.querySelector('p').innerHTML='Learn about <a href="/long">'+'long reference words '.repeat(150)+'</a> now.';
  batch=start('codex');expect(batch.items.length).toBeGreaterThan(1);
  expect(batch.items.every(item=>item.text.length<=1600)).toBe(true);
  for(const item of batch.items)expect(markup.decode(markup.encode(item),item.links)).not.toBeNull();
  runtime.receive({type:'APPLY',generation:batch.generation,items:batch.items.map(item=>({id:item.id,text:markup.encode(item)}))});
  expect(node().querySelectorAll('a').length).toBe(batch.items.filter(item=>item.links?.length).length);expect([...node().querySelectorAll('a')].every(a=>a.href===new URL('/long',document.baseURI).href)).toBe(true);
});
it('updates a destination without retranslating unchanged text and never creates executable links',async()=>{
  const batch=start('codex'),original=document.querySelector('p a');apply(batch,'了解'+wrapped(0,'推送规则集')+'。');runtime.receive({type:'FINISH',generation:batch.generation});
  original.href='/updated';await vi.advanceTimersByTimeAsync(220);expect(node().querySelector('a').href).toBe(original.href);expect(runtime.receive({type:'TAKE',generation:batch.generation}).items).toEqual([]);
  original.href='javascript:alert(1)';apply(batch,'了解'+wrapped(0,'推送规则集')+'。','codex','PREVIEW');
  await vi.advanceTimersByTimeAsync(220);const next=runtime.receive({type:'TAKE',generation:batch.generation});expect(next.items[0].links).toBeUndefined();expect(document.querySelector('[data-mearl-translation] a')).toBeNull();
});
it('serializes native translation with link boundaries and keeps punctuation outside the translated label',async()=>{
  runtime.dispose();const translator={translate:vi.fn(async text=>text==='Learn more about'?'详细了解':text==='configuring push rulesets'?'配置推送规则集':text),destroy:vi.fn()};
  vi.stubGlobal('Translator',{availability:vi.fn(async()=> 'available'),create:vi.fn(async()=>translator)});vi.stubGlobal('LanguageDetector',undefined);
  runtime=new Function('host',`return (${pageRuntime.code})(host)`)(host);const batch=start('browser');
  const result=await runtime.receive({type:'BROWSER_TRANSLATE',generation:batch.generation,ids:batch.items.map(item=>item.id)});
  expect(result.translations[0].text).toBe('详细了解 '+wrapped(0,'配置推送规则集')+'.');expect(node().querySelector('a').textContent).toBe('配置推送规则集');expect(translator.translate).toHaveBeenCalledTimes(2);
});
it.each(['missing','unknown','duplicate','nested','empty'])('rejects invalid translated link markers: %s',kind=>{
  const links=[{id:0,start:0,end:1},{id:1,start:1,end:2}];
  const text=kind==='missing'?wrapped(0,'甲'):kind==='unknown'?wrapped(0,'甲')+wrapped(2,'乙'):kind==='duplicate'?wrapped(0,'甲')+wrapped(0,'乙')+wrapped(1,'丙'):kind==='nested'?wrapped(0,wrapped(1,'乙')):wrapped(0,' ')+wrapped(1,'乙');
  expect(markup.decode(text,links)).toBeNull();expect(markup.decode(wrapped(1,'乙')+wrapped(0,'甲'),links)).toEqual([{id:1,text:'乙'},{id:0,text:'甲'}]);
});
it('passes contextual marked text to Codex, validates previews and separates link-aware cache entries',async()=>{
  vi.useRealTimers();
  const text='Learn more about configuring push rulesets.',item={id:'1',text,links:[{id:0,start:17,end:42}]},cache=new Map();let current=item,invalid=false,engine='codex';
  const send=vi.fn(async message=>message.type==='TAKE'?{items:message.afterBatch?[]:[current],generation:1,engine,automatic:engine==='browser',targetLang:'zh-CN'}:{});
  const state=async(_collection,operation,input)=>operation==='get-many'?{entries:input.keys.map(key=>({key,...cache.get(key)??{exists:false,version:'0'}}))}:input.transaction.operations.forEach(op=>cache.set(op.key,{exists:true,version:'1',value:op.value}));
  const model=vi.fn(async(request,{onProgress})=>{
    const paragraph=JSON.parse(request.prompt).paragraphs[0];expect(paragraph.text).toBe(markup.encode(current));expect(paragraph.links).toBeUndefined();
    onProgress({message:'model.delta',data:{index:1,delta:JSON.stringify({translations:[{id:'1',text:'遗漏链接的预览'}]})}});
    return {output:{translations:[{id:'1',text:invalid?'未保留链接':current.links?'详细了解'+wrapped(0,'配置推送规则集')+'。':'普通译文'}]}};
  });
  const run=()=>translateBatch({event:{payload:{generation:1}}},{page:{send},state,model,signal:new AbortController().signal});
  await expect(run()).resolves.toMatchObject({cached:0});expect(send.mock.calls.some(([message])=>message.type==='PREVIEW')).toBe(false);expect(cache.size).toBe(1);
  await expect(run()).resolves.toMatchObject({cached:1});expect(model).toHaveBeenCalledOnce();
  engine='browser';await expect(run()).resolves.toMatchObject({cached:1});expect(model).toHaveBeenCalledOnce();expect(send.mock.calls.some(([message])=>message.type==='BROWSER_TRANSLATE')).toBe(false);expect(send).toHaveBeenCalledWith(expect.objectContaining({type:'APPLY',lane:'codex'}));engine='codex';
  current={id:'1',text};await expect(run()).resolves.toMatchObject({cached:0});expect(cache.size).toBe(2);
  current={...item,text:'Read more about configuring push rulesets.',links:[{id:0,start:16,end:41}]};invalid=true;await expect(run()).rejects.toThrow('preserve inline links');expect(cache.size).toBe(2);
});
