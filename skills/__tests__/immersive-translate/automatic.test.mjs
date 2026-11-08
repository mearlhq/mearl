// @vitest-environment happy-dom
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTranslation } from '../../immersive-translate/scripts/runtime.mjs';
import { createBrowserTranslation } from '../../immersive-translate/scripts/browser.mjs';
import { restoreCache, translateBatch, translateBrowser } from '../../immersive-translate/scripts/translation.mjs';

let runtime, host, cache, model, native, tasks, errors, controllers, offset;
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const result=request=>({output:{translations:JSON.parse(request.prompt).paragraphs.map(item=>({id:item.id,text:'Codex '+item.text}))}});
const key=(text,engine='codex')=>createHash('sha256').update(JSON.stringify(engine==='browser'?['browser-v1','zh-CN','en',text,[]]:['v1','zh-CN','test-model',text])).digest('hex');
const send=message=>runtime.receive({generation:runtime.receive({type:'STATE'}).generation,...message});
const state=()=>runtime.receive({type:'STATE'});
function content(){document.body.innerHTML='<main><p data-top="20">Current screen paragraph.</p><p data-top="900">Next screen paragraph.</p><p data-top="1900">Distant screen paragraph.</p></main>';}
beforeEach(()=>{
  offset=0;cache=new Map();tasks=new Set();errors=[];controllers=new Map();
  document.documentElement.lang='en';content();vi.stubGlobal('location',window.location);vi.stubGlobal('innerHeight',800);
  vi.spyOn(window.HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(){const top=Number(this.dataset.top??20)-offset;return {top,bottom:top+50,left:0,right:600,width:600,height:50};});
  native=vi.fn(async text=>'Browser '+text);model=vi.fn(async request=>result(request));
  vi.stubGlobal('LanguageDetector',undefined);vi.stubGlobal('Translator',{availability:vi.fn(async()=> 'available'),create:vi.fn(async()=>({translate:native,destroy:vi.fn()}))});
  const storage=async(_collection,operation,input)=>{
    if(operation==='get-many'){expect(input.keys.length).toBeGreaterThan(0);return {entries:input.keys.map(key=>({key,...cache.get(key)??{exists:false,version:'0'}}))};}
    if(operation==='transact'){for(const op of input.transaction.operations){if(op.type==='delete')cache.delete(op.key);else cache.set(op.key,{exists:true,version:String(Number(cache.get(op.key)?.version??0)+1),value:op.value});}return {};}
    throw Error('Unexpected cache operation '+operation);
  };
  host={identity:{instanceId:'automatic-fixture'},emit:vi.fn(async(name,payload)=>{
    controllers.get(name)?.abort();const controller=new AbortController();controllers.set(name,controller);
    const context={signal:controller.signal,model,state:storage,page:{send:async message=>runtime.receive(message,{signal:controller.signal})}};
    const command={cache:restoreCache,work:translateBatch,quick:translateBrowser}[name];
    const work=command({event:{payload}},context).catch(error=>{if(!controller.signal.aborted)errors.push({name,error});}).finally(()=>tasks.delete(work));tasks.add(work);
    return {accepted:true};
  })};
  runtime=installTranslation(host,createBrowserTranslation);
});
afterEach(async()=>{for(const controller of controllers.values())controller.abort();runtime.dispose();await Promise.resolve();vi.restoreAllMocks();vi.unstubAllGlobals();});
const start=()=>runtime.receive({type:'START',engine:'auto',targetLang:'zh-CN',model:'test-model',reasoningEffort:'low',maxParagraphs:200});
const settled=async()=>vi.waitFor(()=>{expect(tasks.size).toBe(0);expect(state().busy).toBe(false);},{timeout:3000});

describe('automatic translation scheduling',()=>{
  it('shows browser results while Codex runs, then upgrades and prefetches only the next screen',async()=>{
    const first=deferred();model.mockImplementationOnce(()=>first.promise);start();
    await vi.waitFor(()=>expect(document.querySelector('[data-mearl-translation]')?.textContent).toBe('Browser Current screen paragraph.'));
    expect(model).toHaveBeenCalledOnce();expect(state()).toMatchObject({engine:'auto',translated:1,refined:0,paragraphs:2,deferred:1});
    expect(native.mock.calls.map(([text])=>text)).toEqual(['Current screen paragraph.']);
    first.resolve(result(model.mock.calls[0][0]));await settled();
    expect(document.querySelector('[data-mearl-translation]').textContent).toBe('Codex Current screen paragraph.');
    expect(model.mock.calls.map(([request])=>JSON.parse(request.prompt).paragraphs.map(item=>item.text))).toEqual([['Current screen paragraph.'],['Next screen paragraph.']]);
    expect(state()).toMatchObject({translated:2,refined:2,refining:0,pending:0,status:'watching'});expect(native).toHaveBeenCalledOnce();expect(errors).toEqual([]);
  });
  it('translates a newly visible screen locally while a previous Codex batch is still running',async()=>{
    const first=deferred();model.mockImplementationOnce(()=>first.promise);start();
    await vi.waitFor(()=>expect(native).toHaveBeenCalledOnce());
    offset=800;document.dispatchEvent(new Event('scroll'));
    await vi.waitFor(()=>expect(native).toHaveBeenCalledWith('Next screen paragraph.',expect.any(Object)));
    expect(model).toHaveBeenCalledOnce();expect(native.mock.calls.map(([text])=>text)).not.toContain('Distant screen paragraph.');
    first.resolve(result(model.mock.calls[0][0]));await settled();
    expect(model.mock.calls.map(([request])=>JSON.parse(request.prompt).paragraphs.map(item=>item.text))).toEqual([['Current screen paragraph.'],['Next screen paragraph.'],['Distant screen paragraph.']]);
    expect(state()).toMatchObject({translated:3,refined:3,deferred:0});
  });
  it('prefers existing Codex cache over browser cache and never invokes either engine for cached text',async()=>{
    document.body.innerHTML='<main><p data-top="20">Current screen paragraph.</p></main>';
    cache.set(key('Current screen paragraph.'),{exists:true,version:'1',value:{text:'Cached Codex'}});
    cache.set(key('Current screen paragraph.','browser'),{exists:true,version:'1',value:{text:'Cached Browser'}});
    start();await settled();
    expect(document.querySelector('[data-mearl-translation]').textContent).toBe('Cached Codex');
    expect(model).not.toHaveBeenCalled();expect(native).not.toHaveBeenCalled();expect(state()).toMatchObject({translated:1,refined:1,cached:1});
  });
  it('cancels an unnecessary native wait when Codex wins and ignores its late result',async()=>{
    document.body.innerHTML='<main><p>Current screen paragraph.</p></main>';
    const slow=deferred(),codex=deferred();native.mockImplementationOnce(()=>slow.promise);model.mockImplementationOnce(()=>codex.promise);start();
    await vi.waitFor(()=>expect(native).toHaveBeenCalledOnce());codex.resolve(result(model.mock.calls[0][0]));await settled();
    expect(state()).toMatchObject({refined:1,failed:0,error:null,warning:null});
    slow.resolve('Late Browser');await Promise.resolve();expect(document.querySelector('[data-mearl-translation]').textContent).toBe('Codex Current screen paragraph.');
    expect(cache.has(key('Current screen paragraph.','browser'))).toBe(false);expect(errors).toEqual([]);
  });
  it('continues with Codex when browser translation is unsupported',async()=>{
    vi.stubGlobal('Translator',undefined);start();await settled();
    expect(state()).toMatchObject({translated:2,refined:2,error:null,warningEngine:'browser'});expect(state().warning).toContain('BROWSER_TRANSLATION_UNAVAILABLE');
    expect(errors).toHaveLength(1);expect(errors[0].name).toBe('quick');
  });
  it('retains browser results after a Codex failure and retries only Codex without repeating native work',async()=>{
    document.body.innerHTML='<main><p>Current screen paragraph.</p></main>';const first=deferred();model.mockImplementationOnce(()=>first.promise);start();
    await vi.waitFor(()=>expect(state().translated).toBe(1));first.reject(Error('Codex unavailable'));await settled();
    expect(state()).toMatchObject({translated:1,refined:0,error:null,warning:'Codex unavailable',warningEngine:'codex',pending:0});
    expect(document.querySelector('[data-mearl-translation]').textContent).toBe('Browser Current screen paragraph.');send({type:'RETRY'});
    await vi.waitFor(()=>expect(state().refined).toBe(1));await settled();expect(native).toHaveBeenCalledOnce();expect(state().warning).toBeNull();
  });
  it('keeps confirmed browser text when a streamed Codex preview fails final validation',async()=>{
    document.body.innerHTML='<main><p>Current screen paragraph.</p></main>';const first=deferred();let progress;
    model.mockImplementationOnce((_request,options)=>{progress=options.onProgress;return first.promise;});start();
    await vi.waitFor(()=>expect(state().translated).toBe(1));const id=JSON.parse(model.mock.calls[0][0].prompt).paragraphs[0].id;
    progress({message:'model.delta',data:{index:1,delta:'{"translations":['+JSON.stringify({id,text:'Unconfirmed Codex'})}});
    await Promise.resolve();first.resolve({output:{translations:[]}});await settled();
    expect(document.querySelector('[data-mearl-translation]').textContent).toBe('Browser Current screen paragraph.');expect(cache.has(key('Current screen paragraph.'))).toBe(false);
    expect(state()).toMatchObject({translated:1,refined:0,warningEngine:'codex'});
  });
  it('pauses new computations in hidden tabs and resumes when the document becomes visible',async()=>{
    const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');start();await settled();
    expect(model).not.toHaveBeenCalled();expect(native).not.toHaveBeenCalled();expect(state().status).toBe('paused');
    visibility.mockReturnValue('visible');document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(()=>expect(state().refined).toBe(2));await settled();expect(native.mock.calls.length).toBeLessThanOrEqual(1);expect(model).toHaveBeenCalledTimes(2);
  });
  it('restarts both lanes without accepting previous-generation results',async()=>{
    document.body.innerHTML='<main><p>Current screen paragraph.</p></main>';const old=deferred();model.mockImplementationOnce(()=>old.promise);start();
    await vi.waitFor(()=>expect(state().translated).toBe(1));const previous=state().generation;
    document.querySelector('p').firstChild.textContent='Replacement English paragraph.';start();
    await vi.waitFor(()=>expect(state().refined).toBe(1));old.resolve(result(model.mock.calls[0][0]));await settled();
    expect(send({type:'APPLY',lane:'browser',generation:previous,items:[{id:'1',text:'Stale native',cached:true}]})).toEqual({stale:true});
    expect(document.querySelector('[data-mearl-translation]').textContent).toBe('Codex Replacement English paragraph.');
  });
  it('uses browser cache immediately while still requesting a Codex upgrade',async()=>{
    document.body.innerHTML='<main><p>Current screen paragraph.</p></main>';cache.set(key('Current screen paragraph.','browser'),{exists:true,version:'1',value:{text:'Cached Browser'}});
    const first=deferred();model.mockImplementationOnce(()=>first.promise);start();await vi.waitFor(()=>expect(model).toHaveBeenCalledOnce());
    expect(document.querySelector('[data-mearl-translation]').textContent).toBe('Cached Browser');expect(native).not.toHaveBeenCalled();
    first.resolve(result(model.mock.calls[0][0]));await settled();expect(state()).toMatchObject({refined:1});
  });
});
