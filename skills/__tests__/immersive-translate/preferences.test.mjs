import { describe, expect, it, vi } from 'vitest';
import { matchesPluginPageURL } from '@mearl/browser-core';
import register from '../../immersive-translate/scripts/main.mjs';
import { savePreferences, siteIdentity } from '../../immersive-translate/scripts/preferences.mjs';

function fixture() {
  let saved, revision=0, activation=null, sequence=0;
  const commands=new Map(),handlers=new Map(),instances=new Map();
  const tabs=[{tabId:7,url:'https://a.test/one'},{tabId:8,url:'https://a.test/two'},{tabId:9,url:'https://b.test/one'}];
  const storage=vi.fn(async(_collection,operation,input)=>{
    if(operation==='get')return {value:saved&&structuredClone(saved),version:String(revision)};
    const op=input.transaction.operations[0];
    if(op.expectedVersion!==String(revision))throw Object.assign(new Error('Conflict'),{code:'PLUGIN_STATE_CONFLICT'});
    saved=structuredClone(op.value);revision++;return {};
  });
  const send=async(instanceId,message)=>{
    const instance=instances.get(instanceId);
    if(message.type==='START')instance.progress={...message,enabled:true,status:'watching',mode:'bilingual',model:message.model};
    if(message.type==='DISPLAY')instance.progress={...instance.progress,mode:message.mode};
    return instance.progress??{enabled:false,status:'idle'};
  };
  const page=vi.fn(async(operation,input={})=>{
    if(operation==='activation') {
      if(input.enabled) {
        const matches=new Set(activation?.matches??[]);
        for(const pattern of input.matchPatch?.add??[])matches.add(pattern);
        for(const pattern of input.matchPatch?.remove??[])matches.delete(pattern);
        activation=matches.size?{...input,matches:[...matches]}:null;
        for(const instance of instances.values())if(instance.automatic&&!matchesPluginPageURL([...matches],instance.target.url))instance.state='invalidated';
      }
      return {activation};
    }
    if(operation==='list')return {instances:[...instances.values()]};
    if(operation==='get')return instances.get(input.instanceId);
    if(operation==='attach') {
      const existing=[...instances.values()].find(instance=>instance.state==='active'&&instance.target.tabId===input.tabId);
      if(existing&&!input.replace){if(input.activationGeneration===undefined)existing.automatic=false;return existing;}
      if(input.replace)for(const instance of instances.values())if(instance.target.tabId===input.tabId)instance.state='detached';
      const instance={instanceId:'fixture-'+(++sequence),state:'active',automatic:input.activationGeneration!==undefined,target:tabs.find(tab=>tab.tabId===input.tabId)};
      instances.set(instance.instanceId,instance);
      await handlers.get('initialize-translation')({input:input.input},{state:storage,page:{send:message=>send(instance.instanceId,message),get:async()=>instance}});
      return instance;
    }
    if(operation==='send')return send(input.instanceId,input.message);
    if(operation==='detach'){instances.get(input.instanceId).state='detached';return {};}
    throw new Error('Unexpected operation '+operation);
  });
  const app={state:storage,page,invoke:vi.fn(async()=>({tabs})),command:(name,run)=>commands.set(name,run),toolboxCommand:(name,run)=>commands.set(name,run),runtimeCommand:(name,run)=>handlers.set(name,run)};
  register(app);
  return {app,commands,handlers,storage,page,instances,run:(name,input={})=>commands.get(name)(input)};
}

describe('translation preferences and site activation',()=>{
  it('loads initial preferences and independent page queries together without an extra instance read',async()=>{
    const f=fixture();await f.run('settings',{model:'selected-model'});f.page.mockClear();
    let release;f.app.invoke.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const loading=f.run('bootstrap',{tabId:7});await Promise.resolve();
    expect(f.page).toHaveBeenCalledWith('list');expect(f.page).toHaveBeenCalledWith('activation');
    release({tabs:[{tabId:7,url:'https://a.test/one'}]});
    expect(await loading).toMatchObject({preferences:{model:'selected-model'},state:{enabled:false,siteEnabled:false,site:'a.test'}});
    expect(f.page.mock.calls.some(([operation])=>operation==='get')).toBe(false);
  });
  it('keeps global floating activation separate from automatic translation sites',async()=>{
    const f=fixture();await f.run('start',{tabId:7});
    await f.run('settings',{floating:true,tabId:9});
    expect((await f.page('activation')).activation.matches).toEqual(['*://a.test/*','http://*/*','https://*/*']);
    expect(await f.run('state',{tabId:9})).toMatchObject({enabled:false,siteEnabled:false});
    const send=vi.fn();await f.handlers.get('initialize-translation')({input:{}},{state:f.storage,page:{send,get:async()=>({target:{tabId:9,url:'https://b.test/two'}})}});
    expect(send).toHaveBeenCalledExactlyOnceWith({type:'FLOATING',enabled:true,position:undefined});
    await f.run('settings',{floating:false});
    expect((await f.page('activation')).activation.matches).toEqual(['*://a.test/*']);
    expect(await f.run('state',{tabId:7})).toMatchObject({enabled:true,siteEnabled:true});
    expect(await f.run('state',{tabId:9})).toMatchObject({enabled:false,instanceId:null});
  });
  it('claims active floating translations before removing their automatic activation range',async()=>{
    const f=fixture();await f.run('settings',{floating:true});
    const active=await f.page('attach',{tabId:9,activationGeneration:1,input:{}});
    const idle=await f.page('attach',{tabId:8,activationGeneration:1,input:{}});
    await f.handlers.get('toggle-translation')({}, {state:f.storage,page:{send:message=>f.page('send',{instanceId:active.instanceId,message})}});
    f.page.mockClear();await f.run('settings',{floating:false});
    expect(await f.run('state',{tabId:9})).toMatchObject({enabled:true,instanceId:active.instanceId,siteEnabled:false});
    expect(f.instances.get(active.instanceId).automatic).toBe(false);expect(f.instances.get(idle.instanceId).state).not.toBe('active');
    const calls=f.page.mock.calls,claim=calls.findIndex(([operation,input])=>operation==='attach'&&input.tabId===9),remove=calls.findIndex(([operation,input])=>operation==='activation'&&input?.matchPatch?.remove);
    expect(claim).toBeGreaterThanOrEqual(0);expect(claim).toBeLessThan(remove);expect(calls.some(([operation,input])=>operation==='attach'&&input.tabId===8)).toBe(false);
    expect((await f.page('activation')).activation).toBeNull();
  });
  it('retains an idle floating entry when stopping page or site translation',async()=>{
    const f=fixture();await f.run('settings',{floating:true,tabId:7});await f.run('start',{tabId:7});
    const stopped=await f.run('stop-page',{tabId:7});expect(stopped).toMatchObject({enabled:false,siteEnabled:true});expect(stopped.instanceId).not.toBeNull();
    const disabled=await f.run('stop',{tabId:7});expect(disabled).toMatchObject({enabled:false,siteEnabled:false});expect(disabled.instanceId).not.toBeNull();
    expect((await f.page('activation')).activation.matches).toEqual(['http://*/*','https://*/*']);
  });
  it('starts from the floating entry once and switches display without changing automatic site rules',async()=>{
    const f=fixture();await f.run('settings',{floating:true,model:'selected-model',tabId:9});
    const instanceId=(await f.run('state',{tabId:9})).instanceId;
    const context={state:f.storage,page:{send:message=>f.page('send',{instanceId,message})}};
    const toggle=()=>f.handlers.get('toggle-translation')({},context);
    await toggle();expect(await f.run('state',{tabId:9})).toMatchObject({enabled:true,mode:'bilingual',siteEnabled:false,model:'selected-model'});
    await toggle();expect(await f.run('state',{tabId:9})).toMatchObject({mode:'original',siteEnabled:false});
    await toggle();expect(await f.run('state',{tabId:9})).toMatchObject({mode:'bilingual',siteEnabled:false});
    expect(f.page.mock.calls.filter(([operation,input])=>operation==='send'&&input.message.type==='START')).toHaveLength(1);
    await expect(f.run('settings',{floating:'bottom'})).rejects.toThrow('floating switch');
  });
  it('starts and stops the current document without creating site rules or touching another page',async()=>{
    const f=fixture();const other=await f.run('start-page',{tabId:8});
    const current=await f.run('start-page',{tabId:7,engine:'auto',model:'selected-model'});
    expect(current).toMatchObject({enabled:true,siteEnabled:false,site:'a.test',engine:'auto'});
    expect((await f.page('activation')).activation).toBeNull();
    expect(f.page.mock.calls.filter(([operation,input])=>operation==='activation'&&input)).toEqual([]);
    await f.run('stop-page',{tabId:7});
    expect(await f.run('state',{tabId:7})).toMatchObject({enabled:false,siteEnabled:false});
    expect(f.instances.get(other.instanceId).state).toBe('active');
    expect(await f.run('preferences')).toMatchObject({engine:'auto',model:'selected-model'});
  });
  it('preserves existing site rules when restarting or stopping only one page',async()=>{
    const f=fixture();await f.run('start',{tabId:7});const other=await f.run('start',{tabId:8});
    expect(await f.run('start-page',{tabId:7})).toMatchObject({enabled:true,siteEnabled:true});
    expect(await f.run('stop-page',{tabId:7})).toMatchObject({enabled:false,siteEnabled:true});
    expect(await f.run('state',{tabId:7})).toMatchObject({enabled:false,siteEnabled:true});
    expect(f.instances.get(other.instanceId).state).toBe('active');
    expect((await f.page('activation')).activation.matches).toEqual(['*://a.test/*']);
  });
  it('persists model changes globally without starting translation and clears an explicit default selection',async()=>{
    const f=fixture();await f.run('settings',{model:'first-model'});
    expect(await f.run('preferences')).toEqual({model:'first-model',targetLang:'zh-CN',maxParagraphs:200});
    register(f.app);expect((await f.run('preferences')).model).toBe('first-model');expect(f.page).not.toHaveBeenCalled();expect(f.app.invoke).not.toHaveBeenCalled();
    await f.run('settings',{model:''});expect(await f.run('preferences')).not.toHaveProperty('model');
  });
  it('persists engine selection globally and pins running pages until explicitly restarted',async()=>{
    const f=fixture();await f.run('start',{tabId:7,engine:'browser',model:'retained-codex-model'});
    await f.run('settings',{engine:'codex'});expect(await f.run('preferences')).toMatchObject({engine:'codex',model:'retained-codex-model'});
    expect(await f.run('state',{tabId:7})).toMatchObject({engine:'browser'});
    const send=vi.fn();await f.handlers.get('initialize-translation')({input:{}},{state:f.storage,page:{send,get:async()=>({target:{tabId:7,url:'https://a.test/one'}})}});
    expect(send).toHaveBeenCalledWith(expect.objectContaining({type:'START',engine:'codex'}));
    await expect(f.run('settings',{engine:'unknown'})).rejects.toThrow('translation engine');
  });
  it('preserves unrelated global preferences when concurrent writes conflict',async()=>{
    const f=fixture();await Promise.all([savePreferences(f.storage,{model:'selected-model'}),savePreferences(f.storage,{targetLang:'ja'})]);
    expect(await f.run('preferences')).toEqual({model:'selected-model',targetLang:'ja',maxParagraphs:200});
    await expect(f.run('settings',{maxParagraphs:0})).rejects.toThrow('maxParagraphs');
    expect((await f.run('preferences')).maxParagraphs).toBe(200);
  });
  it('persists independent sites and disables every instance of only the chosen site',async()=>{
    const f=fixture();const first=await f.run('start',{tabId:7,model:'selected-model'});
    expect(first).toMatchObject({site:'a.test',siteEnabled:true,enabled:true,model:'selected-model'});
    await f.run('start',{tabId:8});await f.run('start',{tabId:9});
    expect(f.page).toHaveBeenCalledWith('activation',expect.objectContaining({enabled:true,persistence:'persistent',matchPatch:{add:['*://a.test/*']},input:{}}));
    await f.run('stop',{tabId:7});
    expect((await f.run('state',{tabId:8}))).toMatchObject({enabled:false,siteEnabled:false});
    expect((await f.run('state',{tabId:9}))).toMatchObject({enabled:true,siteEnabled:true});
    expect((await f.page('activation')).activation.matches).toEqual(['*://b.test/*']);
    expect((await f.run('preferences')).model).toBe('selected-model');
  });
  it('initializes a new document from the latest global model while keeping running documents pinned',async()=>{
    const f=fixture();await f.run('start',{tabId:7,model:'first-model'});await f.run('settings',{model:'second-model'});
    const send=vi.fn();await f.handlers.get('initialize-translation')({input:{}},{state:f.storage,page:{send,get:async()=>({target:{tabId:7,url:'https://a.test/one'}})}});
    expect(send).toHaveBeenCalledWith({type:'START',targetLang:'zh-CN',maxParagraphs:200,model:'second-model'});
    expect((await f.run('state',{tabId:7}))).toMatchObject({model:'first-model',siteEnabled:true});
    expect(siteIdentity('http://A.test/path?q=1#part')).toEqual({site:'a.test',pattern:'*://a.test/*'});
    expect(siteIdentity('http://localhost:3210/path').pattern).toBe('*://localhost:3210/*');
    expect(()=>siteIdentity('file:///tmp/example.html')).toThrow('HTTP(S)');
  });
});

it('persists reasoning effort and uses it when initializing a new document',async()=>{
  const f=fixture();await f.run('settings',{reasoningEffort:'none'});await f.run('start',{tabId:7});
  expect((await f.run('preferences')).reasoningEffort).toBe('none');
  const send=vi.fn();await f.handlers.get('initialize-translation')({input:{}},{state:f.storage,page:{send,get:async()=>({target:{tabId:7,url:'https://a.test/one'}})}});
  expect(send).toHaveBeenCalledWith(expect.objectContaining({type:'START',reasoningEffort:'none'}));
});

it('migrates the existing preference schema with its exact revision before saving a new field',async()=>{
  const state=vi.fn(async(_collection,operation)=>operation==='get'?{value:{model:'saved-model',targetLang:'ja',maxParagraphs:50},version:'v:4',revision:7,schemaVersion:1}:{});
  expect(await savePreferences(state,{reasoningEffort:'low'})).toEqual({model:'saved-model',targetLang:'ja',maxParagraphs:50,reasoningEffort:'low'});
  expect(state).toHaveBeenCalledWith('preferences','transact',{transaction:{migrateFromVersion:1,expectedRevision:7,operations:[{type:'put',key:'settings',expectedVersion:'v:4',value:{model:'saved-model',targetLang:'ja',maxParagraphs:50,reasoningEffort:'low'}}]}});
});

it('persists automatic mode and migrates browser-only preferences without losing the saved model',async()=>{
  const state=vi.fn(async(_collection,operation)=>operation==='get'?{value:{engine:'browser',targetLang:'zh-CN',maxParagraphs:200,model:'saved-model',reasoningEffort:'low'},version:'v:8',revision:9,schemaVersion:3}:{});
  expect(await savePreferences(state,{engine:'auto'})).toMatchObject({engine:'auto',model:'saved-model',reasoningEffort:'low'});
  expect(state.mock.calls[1][2].transaction).toMatchObject({migrateFromVersion:3,expectedRevision:9,operations:[expect.objectContaining({value:expect.objectContaining({engine:'auto',model:'saved-model'})})]});
});

it('migrates the previous preference schema when enabling the floating switch',async()=>{
  const state=vi.fn(async(_collection,operation)=>operation==='get'?{value:{engine:'auto',targetLang:'ja',maxParagraphs:50,model:'selected-model'},version:'v:4',revision:5,schemaVersion:4}:{});
  expect(await savePreferences(state,{floating:true})).toEqual({engine:'auto',targetLang:'ja',maxParagraphs:50,model:'selected-model',floating:true});
  expect(state.mock.calls[1][2].transaction).toMatchObject({migrateFromVersion:4,expectedRevision:5});
});

it('migrates side preferences and persists drag positions without changing activation',async()=>{
  const state=vi.fn(async(_collection,operation,input)=>operation==='get'?{value:{targetLang:'en',maxParagraphs:50,floating:'right'},schemaVersion:5,version:'3',revision:7}:{});
  expect(await savePreferences(state,{floatingPosition:{x:.2,y:.7}})).toEqual({targetLang:'en',maxParagraphs:50,floating:true,floatingPosition:{x:.2,y:.7}});
  expect(state.mock.calls[1][2].transaction.migrateFromVersion).toBe(5);
  const f=fixture();await f.run('settings',{floating:true,tabId:7});f.page.mockClear();
  await f.handlers.get('move-floating')({event:{payload:{x:.2,y:.7}}},{state:f.storage});
  expect(await f.run('preferences')).toMatchObject({floating:true,floatingPosition:{x:.2,y:.7}});expect(f.page).not.toHaveBeenCalled();
  await expect(f.run('settings',{floatingPosition:{x:2,y:0}})).rejects.toThrow('floating switch position');
});
