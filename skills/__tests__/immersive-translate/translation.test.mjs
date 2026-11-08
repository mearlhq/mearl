import { describe, expect, it, vi } from 'vitest';
import { loadPlugin } from '@mearl/client/plugin';
import { translateBatch, validateOptions } from '../../immersive-translate/scripts/translation.mjs';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginStateStore } from '../shared/public-runtime.mjs';
import { stateStorage } from '../../immersive-translate/scripts/translation.mjs';

function fixture(items=[{id:'1',text:'An English paragraph to translate.'}]) {
  const cache=new Map(), controller=new AbortController();
  const page={send:vi.fn(async message=>message.type==='TAKE'?{items:message.afterBatch?[]:items,generation:1,targetLang:'zh-CN',model:'pinned-model'}:{})};
  const state=vi.fn(async (collection,operation,input)=>{
    expect(collection).toBe('cache');
    if(operation==='get-many') {expect(input.keys.length).toBeGreaterThan(0);return {entries:input.keys.map(key=>({key,...(cache.get(key)??{exists:false,version:'a:0'})}))};}
    if(operation==='transact') for(const op of input.transaction.operations) cache.set(op.key,{exists:true,version:'v:1',value:op.value});
  });
  const model=vi.fn(async request=>({output:{translations:JSON.parse(request.prompt).paragraphs.map(item=>({id:item.id,text:'译文'}))}}));
  const context={page,state,model,signal:controller.signal};
  return {context,cache,controller,page,state,model,run:()=>translateBatch({event:{payload:{generation:1}}},context)};
}
describe('translation worker',()=>{
  it('previews complete paragraphs before the model finishes and only caches final validated output', async()=>{
    const f=fixture([{id:'1',text:'First paragraph.'},{id:'2',text:'Second paragraph.'},{id:'3',text:'First paragraph.'}]);
    let release, emit;
    f.model.mockImplementation((_request,{onProgress})=>{emit=onProgress;return new Promise(resolve=>{release=resolve;});});
    const pending=f.run();await vi.waitFor(()=>expect(emit).toBeTypeOf('function'));
    emit({message:'model.delta',data:{index:1,delta:'{"translations":[{"id":"1","text":"第一'}});
    await Promise.resolve();expect(f.page.send.mock.calls.some(([m])=>m.type==='PREVIEW')).toBe(false);
    emit({message:'model.delta',data:{index:2,delta:'段"},'}});
    await vi.waitFor(()=>expect(f.page.send).toHaveBeenCalledWith({type:'PREVIEW',generation:1,items:[{id:'1',text:'第一段'},{id:'3',text:'第一段'}]}));
    expect(f.cache.size).toBe(0);expect(f.page.send.mock.calls.some(([m])=>m.type==='APPLY')).toBe(false);
    release({output:{translations:[{id:'1',text:'第一段最终版本'},{id:'2',text:'第二段'}]}});
    await expect(pending).resolves.toMatchObject({translated:3,cached:0});expect(f.cache.size).toBe(2);
    expect(f.page.send).toHaveBeenCalledWith(expect.objectContaining({type:'APPLY',items:[{id:'1',text:'第一段最终版本',cached:false},{id:'3',text:'第一段最终版本',cached:false},{id:'2',text:'第二段',cached:false}]}));
    const calls=f.page.send.mock.calls.length;
    emit({message:'model.delta',data:{index:3,delta:'{"id":"2","text":"迟到"}'}});
    await Promise.resolve();expect(f.page.send.mock.calls).toHaveLength(calls);
  });
  it.each(['failure','invalid-final','cancel'])('discards previews and never caches an unsuccessful batch: %s',async outcome=>{
    const f=fixture();let release,reject,emit;
    f.model.mockImplementation((_request,{onProgress})=>{emit=onProgress;return new Promise((resolve,fail)=>{release=resolve;reject=fail;});});
    const pending=f.run(), rejected=expect(pending).rejects.toBeDefined();
    await vi.waitFor(()=>expect(emit).toBeTypeOf('function'));
    emit({message:'model.delta',data:{index:1,delta:'{"translations":[{"id":"1","text":"临时译文"}'}});
    await vi.waitFor(()=>expect(f.page.send.mock.calls.some(([m])=>m.type==='PREVIEW')).toBe(true));
    if(outcome==='failure')reject(new Error('Stream interrupted'));
    else {if(outcome==='cancel')f.controller.abort();release({output:{translations:outcome==='invalid-final'?[]:[{id:'1',text:'最终译文'}]}});}
    await rejected;
    expect(f.page.send).toHaveBeenCalledWith({type:'DISCARD',generation:1,ids:['1']});expect(f.cache.size).toBe(0);
    expect(f.page.send.mock.calls.some(([m])=>m.type==='APPLY')).toBe(false);
    expect(f.page.send).toHaveBeenLastCalledWith({type:'FINISH',generation:1});
  });
  it.each(['unknown','duplicate','gap','code'])('falls back to final validated output for invalid streamed data: %s',async kind=>{
    const item={id:'1',text:'Use literal in this paragraph.',codeLiterals:['literal']};const f=fixture([item]);
    f.model.mockImplementation(async(_request,{onProgress})=>{
      const entry={id:kind==='unknown'?'other':'1',text:kind==='code'?'遗漏':'使用 literal'};
      onProgress({message:'model.delta',data:{index:kind==='gap'?2:1,delta:'{"translations":['+JSON.stringify(entry)}});
      if(kind==='duplicate')onProgress({message:'model.delta',data:{index:2,delta:','+JSON.stringify(entry)}});
      return {output:{translations:[{id:'1',text:'最终 literal'}]}};
    });
    await f.run();expect(f.page.send).toHaveBeenCalledWith(expect.objectContaining({type:'DISCARD'}));
    expect(f.page.send).toHaveBeenCalledWith(expect.objectContaining({type:'APPLY',items:[{id:'1',text:'最终 literal',cached:false}]}));
    if(kind!=='duplicate')expect(f.page.send.mock.calls.some(([m])=>m.type==='PREVIEW')).toBe(false);
  });
  it('isolates message items and ignores commentary while retaining final-only provider support', async()=>{
    const f=fixture();
    f.model.mockImplementation(async(_request,{onProgress})=>{
      onProgress({message:'model.delta',data:{index:1,itemId:'comment',phase:'commentary',delta:'{"translations":[{"id":"1","text":"说明"}'}});
      onProgress({message:'model.delta',data:{index:2,itemId:'answer',phase:'final_answer',delta:'{"translations":[{"id":"1","text":"译文"}'}});
      return {output:{translations:[{id:'1',text:'译文'}]}};
    });
    await f.run();expect(f.page.send.mock.calls.filter(([m])=>m.type==='PREVIEW').map(([m])=>m.items)).toEqual([[{id:'1',text:'译文'}]]);
  });
  it('registers all entrypoints without invoking the browser or model',async()=>{
    const invoke=vi.fn(); const plugin=await loadPlugin(fileURLToPath(new URL('../../immersive-translate/scripts/main.mjs',import.meta.url)),{options:{},invoke,progress:()=>{}});
    expect(plugin.name).toBe('translate'); expect(plugin.toolbox.displayMode).toBe('popup'); expect(plugin.toolbox.page.commands).not.toContain('tabs'); expect(plugin.commandHelp('mearl translate')).toBe('');
    for(const command of plugin.toolbox.page.commands)await expect(plugin.run([],{command,input:{}})).rejects.toThrow('PLUGIN_COMMAND_TOOLBOX_ONLY');
    await expect(plugin.run([],{command:'translate-batch',input:{}})).rejects.toThrow('RUNTIME_ONLY'); expect(invoke).not.toHaveBeenCalled();
  });
  it('deduplicates repeated text, pins the model and reuses cache without another model call',async()=>{
    const f=fixture([{id:'1',text:'Repeated source paragraph.'},{id:'2',text:'Repeated source paragraph.'}]);
    expect(await f.run()).toMatchObject({translated:2,cached:0});
    expect(JSON.parse(f.model.mock.calls[0][0].prompt).paragraphs).toHaveLength(1);
    expect(f.model.mock.calls[0][0]).toMatchObject({model:'pinned-model',permissions:'read-only',conversation:'translation:1'});
    expect(await f.run()).toMatchObject({translated:2,cached:2}); expect(f.model).toHaveBeenCalledOnce();
    expect(f.page.send.mock.calls.find(([message])=>message.type==='APPLY')[0].items).toHaveLength(2);
  });
  it.each([false,true])('handles a full durable cache without losing new writes or concurrent entries: concurrent=%s',async concurrent=>{
    const directory=mkdtempSync(join(tmpdir(),'mearl-translation-cache-'));
    try {
      let now=100;
      const store=new PluginStateStore(directory,()=>now),definition={...stateStorage.collections.cache,maxEntries:34};
      const namespace={installationId:'00000000-0000-4000-8000-000000000001',collection:'cache',scope:'installation'};
      const put=(key,text)=>({type:'put',key,value:{text},expectedVersion:store.get(namespace,definition,key).version});
      store.transact(namespace,definition,{operations:Array.from({length:32},(_,i)=>put(`old-${i}`,'旧译文'))});
      now=200;store.transact(namespace,definition,{operations:[put('recent-one','近期译文'),put('recent-two','近期译文')]});
      const f=fixture();let changed=false;
      f.state.mockImplementation(async(_collection,operation,input)=>{
        if(operation==='get-many')return store.getMany(namespace,definition,input.keys);
        if(operation==='list'){
          const snapshot=store.list(namespace,definition,input);
          if(concurrent&&!changed){changed=true;store.transact(namespace,definition,{operations:[put('recent-one','并发译文')]});}
          return snapshot;
        }
        return store.transact(namespace,definition,input.transaction);
      });
      await expect(f.run()).resolves.toMatchObject({translated:1});
      const entries=store.list(namespace,definition,{limit:200}).entries;
      expect(entries.some(entry=>entry.value.text==='译文')).toBe(!concurrent);
      expect(entries.some(entry=>entry.key==='recent-two')).toBe(true);
      expect(store.get(namespace,definition,'recent-one').value.text).toBe(concurrent?'并发译文':'近期译文');
      expect(entries.filter(entry=>entry.key.startsWith('old-'))).toHaveLength(concurrent?32:0);
      if(!concurrent){await f.run();expect(f.model).toHaveBeenCalledOnce();}
    } finally {rmSync(directory,{recursive:true,force:true});}
  });
  it('uses browser translation without a model task, isolates caches and reuses browser cache across model changes',async()=>{
    const f=fixture([{id:'1',text:'An English paragraph to translate.'}]);await f.run();
    const send=f.page.send.getMockImplementation();let selectedModel='another-model';
    f.page.send.mockImplementation(async message=>message.type==='BROWSER_TRANSLATE'?{translations:message.ids.map(id=>({id,text:'浏览器译文'}))}:message.type==='TAKE'?{...await send(message),engine:'browser',model:selectedModel}:send(message));
    expect(await f.run()).toMatchObject({translated:1,cached:0});expect(f.model).toHaveBeenCalledOnce();
    expect(f.page.send).toHaveBeenCalledWith({type:'BROWSER_TRANSLATE',generation:1,ids:['1']},{timeoutSec:300});expect(f.cache.size).toBe(2);
    selectedModel='unrelated-model';const calls=f.page.send.mock.calls.filter(([message])=>message.type==='BROWSER_TRANSLATE').length;
    expect(await f.run()).toMatchObject({translated:1,cached:1});expect(f.model).toHaveBeenCalledOnce();
    expect(f.page.send.mock.calls.filter(([message])=>message.type==='BROWSER_TRANSLATE')).toHaveLength(calls);
  });
  it('confirms and caches browser successes, marks only failed duplicates and drains the next batch',async()=>{
    const first=[{id:'1',text:'Good paragraph.'},{id:'2',text:'Bad paragraph.'},{id:'3',text:'Bad paragraph.'}],f=fixture(first);let batch=0;
    f.page.send.mockImplementation(async message=>{
      if(message.type==='TAKE')return {items:[first,[{id:'4',text:'Later paragraph.'}],[]][batch++],generation:1,targetLang:'zh-CN',engine:'browser'};
      if(message.type==='BROWSER_TRANSLATE')return message.ids.includes('2')?{translations:[{id:'1',text:'成功译文'}],failures:[{id:'2',error:'Native failure'}]}:{translations:[{id:'4',text:'后续译文'}]};
      return {};
    });
    await expect(f.run()).resolves.toMatchObject({translated:2,cached:0});expect(f.model).not.toHaveBeenCalled();expect(f.cache.size).toBe(2);
    expect(f.page.send).toHaveBeenCalledWith({type:'FAIL_ITEMS',generation:1,items:[{id:'2',error:'Native failure'},{id:'3',error:'Native failure'}]});
    expect(f.page.send.mock.calls.filter(([message])=>message.type==='APPLY').flatMap(([message])=>message.items)).toEqual([{id:'1',text:'成功译文',cached:false},{id:'4',text:'后续译文',cached:false}]);
    expect(f.page.send.mock.calls.some(([message])=>['FAIL','DISCARD'].includes(message.type))).toBe(false);
  });
  it.each(['overlap','missing','unknown','duplicate'])('rejects malformed partial browser results: %s',async kind=>{
    const f=fixture([{id:'1',text:'First paragraph.'},{id:'2',text:'Second paragraph.'}]),send=f.page.send.getMockImplementation();
    const failures=kind==='duplicate'?[{id:'2',error:'failure'},{id:'2',error:'failure'}]:kind==='missing'?[]:[{id:kind==='overlap'?'1':kind==='unknown'?'other':'2',error:'failure'}];
    f.page.send.mockImplementation(async message=>message.type==='TAKE'?{...await send(message),engine:'browser'}:message.type==='BROWSER_TRANSLATE'?{translations:kind==='duplicate'?[]:[{id:'1',text:'译文'}],failures}:send(message));
    await expect(f.run()).rejects.toBeDefined();expect(f.cache.size).toBe(0);expect(f.page.send.mock.calls.some(([message])=>message.type==='APPLY')).toBe(false);
  });
  it('continues after a browser batch has only failures without requesting an empty cache batch',async()=>{
    const f=fixture(),batches=[[{id:'1',text:'Failed paragraph.'}],[{id:'2',text:'Following paragraph.'}],[]];let index=0;
    f.page.send.mockImplementation(async message=>message.type==='TAKE'?{items:batches[index++],generation:1,targetLang:'zh-CN',engine:'browser'}:message.type==='BROWSER_TRANSLATE'?message.ids[0]==='1'?{translations:[],failures:[{id:'1',error:'Native failure'}]}:{translations:[{id:'2',text:'后续译文'}]}:{});
    await expect(f.run()).resolves.toMatchObject({translated:1});expect(f.cache.size).toBe(1);expect(f.page.send.mock.calls.some(([message])=>message.type==='FAIL')).toBe(false);
  });
  it('does not fall back to Codex when browser translation fails',async()=>{
    const f=fixture(),send=f.page.send.getMockImplementation();
    f.page.send.mockImplementation(async message=>{if(message.type==='BROWSER_TRANSLATE')throw new Error('BROWSER_TRANSLATION_UNAVAILABLE');return message.type==='TAKE'?{...await send(message),engine:'browser'}:send(message);});
    await expect(f.run()).rejects.toThrow('BROWSER_TRANSLATION_UNAVAILABLE');expect(f.model).not.toHaveBeenCalled();expect(f.cache.size).toBe(0);
  });
  it('rejects duplicate or missing ids and reports failure without writing to DOM',async()=>{
    const f=fixture([{id:'1',text:'One source paragraph.'},{id:'2',text:'Another source paragraph.'}]);
    f.model.mockResolvedValue({output:{translations:[{id:'1',text:'一'},{id:'1',text:'重复'}]}});
    await expect(f.run()).rejects.toThrow('ids');
    expect(f.page.send.mock.calls.some(([message])=>message.type==='APPLY')).toBe(false);
    expect(f.page.send).toHaveBeenCalledWith(expect.objectContaining({type:'FAIL'}));
    expect(f.page.send).toHaveBeenLastCalledWith({type:'FINISH',generation:1});
  });
  it('checks cancellation after the model and does not cache or apply cancelled output',async()=>{
    const f=fixture(); f.model.mockImplementation(async()=>{f.controller.abort();return {output:{translations:[{id:'1',text:'译文'}]}};});
    await expect(f.run()).rejects.toBeDefined(); expect(f.cache.size).toBe(0);
    expect(f.page.send.mock.calls.some(([message])=>message.type==='APPLY')).toBe(false);
  });
  it('validates options and lets an empty model restore the default',()=>{
    expect(validateOptions({model:' '})).toEqual({targetLang:'zh-CN',maxParagraphs:200});
    for(const input of [{targetLang:'xx'},{maxParagraphs:0},{maxParagraphs:501},{model:5},{reasoningEffort:'unknown'},{reasoningEffort:3}]) expect(()=>validateOptions(input)).toThrow();
  });
  it('passes protected code literals to the model, rejects omissions and keeps literal-specific cache separate', async()=>{
    const text='Assign the Enterprise Open-Source License Manager role to qualified teams.';
    const f=fixture([{id:'1',text}]);
    await f.run();
    f.page.send.mockImplementation(async message=>message.type==='TAKE'?{items:message.afterBatch?[]:[{id:'1',text,codeLiterals:['Enterprise Open-Source License Manager']}],generation:1,targetLang:'zh-CN',model:'pinned-model'}:{});
    await expect(f.run()).rejects.toThrow('omitted a code literal');
    expect(f.model).toHaveBeenCalledTimes(2);
    f.model.mockResolvedValue({output:{translations:[{id:'1',text:'分配 Enterprise Open-Source License Manager 角色。'}]}});
    await f.run();
    expect(JSON.parse(f.model.mock.lastCall[0].prompt).paragraphs[0].codeLiterals).toEqual(['Enterprise Open-Source License Manager']);
    const calls=f.model.mock.calls.length; await f.run(); expect(f.model).toHaveBeenCalledTimes(calls);
  });

  it('applies cached paragraphs before a slow model result and drains further batches without another worker',async()=>{
    const cachedItem={id:'1',text:'An already cached paragraph.'}, missingItem={id:'2',text:'A new paragraph requiring a model.'};
    const f=fixture([cachedItem]); await f.run(); f.page.send.mockClear(); f.state.mockClear();
    let batch=0,peek=0;
    f.page.send.mockImplementation(async message=>['PEEK','TAKE'].includes(message.type)?{items:message.type==='PEEK' ? peek++===0 ? [cachedItem,{...cachedItem,id:'3'}] : [] : batch++===0 ? [missingItem] : [],generation:1,targetLang:'zh-CN',model:'pinned-model'}:{});
    let resolve; f.model.mockImplementation(()=>new Promise(done=>{resolve=done;}));
    const pending=f.run(); await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));
    expect(f.page.send.mock.calls.filter(([m])=>m.type==='APPLY').map(([m])=>m.items)).toEqual([[{id:'1',text:'译文',cached:true},{id:'3',text:'译文',cached:true}]]);
    resolve({output:{translations:[{id:'2',text:'新译文'}]}});
    expect(await pending).toMatchObject({translated:3,cached:2});
    expect(f.state.mock.calls.filter(([,operation])=>operation==='get-many')).toHaveLength(3);
    expect(f.page.send.mock.calls.filter(([m])=>m.type==='FINISH')).toHaveLength(1);
  });

});

it.each(['none','minimal','low','medium','high','xhigh','max','default'])('passes the selected reasoning effort to the model: %s',async reasoningEffort=>{
  const f=fixture(),send=f.page.send.getMockImplementation();
  f.page.send.mockImplementation(async message=>{const result=await send(message);return message.type==='TAKE'?{...result,reasoningEffort}:result;});
  await f.run();expect(f.model).toHaveBeenCalledOnce();
  if(reasoningEffort==='default')expect(f.model.mock.lastCall[0]).not.toHaveProperty('reasoningEffort');
  else expect(f.model.mock.lastCall[0].reasoningEffort).toBe(reasoningEffort);
});
it('applies model output before waiting for durable cache writes',async()=>{
  const f=fixture(),state=f.state.getMockImplementation();let release;
  f.state.mockImplementation((collection,operation,input)=>operation==='transact'?new Promise(resolve=>{release=()=>resolve(state(collection,operation,input));}):state(collection,operation,input));
  const work=f.run();await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  expect(f.page.send).toHaveBeenCalledWith(expect.objectContaining({type:'APPLY',items:[{id:'1',text:'译文',cached:false}]}));
  release();await work;
});
