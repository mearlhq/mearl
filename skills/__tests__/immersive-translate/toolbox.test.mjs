// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fromExtension=createRequire(join(process.cwd(),'package.json'));
const preact=fromExtension('preact'), hooks=fromExtension('preact/hooks'), htm=fromExtension('htm');
const {act}=fromExtension('preact/test-utils');
const source=readFileSync(join(process.cwd(),'skills/immersive-translate/assets/toolbox/app.js'),'utf8');
let bridge, receive, unsubscribe, state, active, starts;
beforeEach(()=>{
  document.body.innerHTML='<div id="app"></div>';
  starts=0; active={tabId:7,url:'https://example.test/article'}; state={enabled:false,status:'idle',instanceId:null}; unsubscribe=vi.fn();
  bridge={ready:async()=>({locale:'zh_CN'}),ui:{h:preact.h,html:htm.bind(preact.h),render:preact.render,...hooks},onContextChange:()=>()=>{},subscribe:vi.fn(async(_source,_target,listener)=>{receive=listener;return unsubscribe;}),invoke:vi.fn(async(command,input)=>{
    if(command==='host.model.list')return {provider:'codex',models:[{id:'available-model',displayName:'Available model'}]};
    if(command==='preferences')return {targetLang:'zh-CN',maxParagraphs:200};
    if(command==='bootstrap')return {preferences:await bridge.invoke('preferences'),state:await bridge.invoke('state',input)};
    if(command==='host.tab.active')return active;
    if(command==='start')state={enabled:true,siteEnabled:true,status:'translating',instanceId:'pi_fixture_'+(++starts),targetLang:input.targetLang,maxParagraphs:input.maxParagraphs,mode:'bilingual',engine:input.engine,reasoningEffort:input.reasoningEffort,translated:0,paragraphs:2,cached:0};
    if(command==='start-page')state={enabled:true,siteEnabled:false,status:'translating',instanceId:'pi_fixture_'+(++starts),targetLang:input.targetLang,maxParagraphs:input.maxParagraphs,model:input.model,mode:'bilingual',engine:input.engine,reasoningEffort:input.reasoningEffort,translated:0,paragraphs:2,cached:0};
    if(command==='display')state={...state,mode:input.mode};
    if(command==='stop')state={enabled:false,siteEnabled:false,status:'idle',instanceId:null};
    if(command==='stop-page')state={enabled:false,siteEnabled:false,status:'idle',instanceId:null};
    return state;
  })};
  window.mearl=bridge;
});
afterEach(()=>{preact.render(null,document.getElementById('app'));delete window.mearl;vi.restoreAllMocks();});
const mount=async()=>{await act(async()=>{new Function(source)();await Promise.resolve();});await vi.waitFor(()=>expect(bridge.invoke).toHaveBeenCalledWith('host.tab.active'));};
const button=text=>[...document.querySelectorAll('button')].find(button=>button.textContent===text||button.getAttribute('aria-label')===text);
it('starts the initial page query without waiting for passive effects',async()=>{
  bridge.ui={...bridge.ui,useEffect:()=>{}};
  await mount();
  await vi.waitFor(()=>expect(button('翻译本页')?.disabled).toBe(false));
});
it('offers page translation before site activation and keeps restarts and stops scoped to the page',async()=>{
  await mount();await vi.waitFor(()=>expect(button('翻译本页')?.disabled).toBe(false));
  const actions=[...document.querySelectorAll('.site-actions button')];
  expect(actions.map(action=>action.textContent)).toEqual(['翻译本页','开启本站翻译']);
  expect(document.querySelector('.off-hint')).toBeNull();
  button('翻译本页').click();
  await vi.waitFor(()=>expect(button('停止本页翻译')).toBeDefined());
  expect(bridge.invoke).toHaveBeenCalledWith('start-page',{engine:'codex',tabId:7,targetLang:'zh-CN',maxParagraphs:200,model:'',reasoningEffort:'low'});
  expect(button('开启本站翻译')).toBeDefined();
  button('重新翻译当前页').click();
  await vi.waitFor(()=>expect(bridge.invoke.mock.calls.filter(([command])=>command==='start-page')).toHaveLength(2));
  button('停止本页翻译').click();
  await vi.waitFor(()=>expect(button('翻译本页')).toBeDefined());
  expect(bridge.invoke).toHaveBeenCalledWith('stop-page',{tabId:7});
  expect(bridge.invoke.mock.calls.some(([command])=>command==='start'||command==='stop')).toBe(false);
});
it('starts translation on the current webpage with the default model, then unsubscribes without stopping on close',async()=>{
  await mount(); await vi.waitFor(()=>expect(button('开启本站翻译').disabled).toBe(false));
  button('开启本站翻译').click();
  await vi.waitFor(()=>expect(bridge.subscribe).toHaveBeenCalledOnce());
  receive({type:'running'}); await vi.waitFor(()=>expect(document.body.textContent).toContain('正在翻译'));
  expect(bridge.invoke).toHaveBeenCalledWith('start',{engine:'codex',tabId:7,targetLang:'zh-CN',maxParagraphs:200,model:'',reasoningEffort:'low'});
  button('原文').click(); await vi.waitFor(()=>expect(bridge.invoke).toHaveBeenCalledWith('display',{tabId:7,mode:'original'}));
  preact.render(null,document.getElementById('app')); expect(unsubscribe).toHaveBeenCalledOnce();
  expect(bridge.invoke.mock.calls.some(([command])=>command==='stop')).toBe(false);
});
it('can enable automatic site translation after translating only the current page',async()=>{
  await mount();await vi.waitFor(()=>expect(button('翻译本页')?.disabled).toBe(false));
  button('翻译本页').click();await vi.waitFor(()=>expect(button('停止本页翻译')).toBeDefined());
  button('开启本站翻译').click();
  await vi.waitFor(()=>expect(button('关闭本站并恢复原文')).toBeDefined());
  expect(button('停止本页翻译')).toBeUndefined();
  expect(bridge.invoke.mock.calls.filter(([command])=>command==='start-page')).toHaveLength(1);
  expect(bridge.invoke.mock.calls.filter(([command])=>command==='start')).toHaveLength(1);
});
it('restores progress without restarting and stops only after the user requests it',async()=>{
  state={enabled:true,status:'watching',instanceId:'pi_fixture',targetLang:'ja',maxParagraphs:31,mode:'bilingual',translated:2,paragraphs:2,cached:2};
  await mount(); await vi.waitFor(()=>expect(document.querySelector('progress')?.value).toBe(2));
  expect(document.querySelector('[aria-label="翻译为"]').value).toBe('zh-CN');
  expect(document.querySelector('[aria-label="本页最多翻译"]').value).toBe('200');
  expect(bridge.invoke.mock.calls.some(([command])=>command==='start')).toBe(false);
  button('关闭本站并恢复原文').click();
  await vi.waitFor(()=>expect(button('开启本站翻译')).toBeDefined());
  expect(bridge.invoke).toHaveBeenCalledWith('stop',{tabId:7});
});
it('distinguishes completed reading-area progress from distant paragraphs waiting for scrolling',async()=>{
  state={enabled:true,status:'watching',instanceId:'pi_fixture',targetLang:'zh-CN',maxParagraphs:200,mode:'bilingual',translated:2,paragraphs:2,detected:120,deferred:118,cached:2,pending:0};
  await mount();await vi.waitFor(()=>expect(document.body.textContent).toContain('118 段随滚动翻译'));
  expect(document.body.textContent).toContain('当前区域已完成');expect(document.body.textContent).not.toContain('页面已识别');
  expect(document.querySelector('progress').max).toBe(2);expect(document.querySelector('progress').value).toBe(2);
});

it('requires a supported current page instead of choosing another tab',async()=>{
  active={tabId:9,url:'chrome://newtab/'}; await mount();
  await vi.waitFor(()=>expect(document.body.textContent).toContain('请在要翻译的普通网页上打开此工具'));
  expect(button('开启本站翻译').disabled).toBe(true);
  expect(button('翻译本页').disabled).toBe(true);
  expect(bridge.invoke.mock.calls.some(([command])=>command==='tabs'||command==='state'||command==='start')).toBe(false);
  expect(document.querySelector('[aria-label="目标网页"]')).toBeNull();
});
it('restores the browser engine without discovering Codex models or showing unrelated controls',async()=>{
  const invoke=bridge.invoke.getMockImplementation();
  bridge.invoke.mockImplementation((command,input)=>command==='preferences'?Promise.resolve({engine:'browser',targetLang:'zh-CN',model:'retained-model',reasoningEffort:'high',maxParagraphs:200}):invoke(command,input));
  await mount();await vi.waitFor(()=>expect(button('浏览器内置').getAttribute('aria-pressed')).toBe('true'));
  expect(button('Codex').getAttribute('aria-pressed')).toBe('false');expect(document.querySelector('select[aria-label="翻译引擎"]')).toBeNull();
  expect(document.querySelector('[aria-label="翻译模型"]')).toBeNull();expect(document.querySelector('[aria-label="思考级别"]')).toBeNull();
  expect(bridge.invoke.mock.calls.some(([command])=>command==='host.model.list')).toBe(false);
  expect(document.body.textContent).not.toContain('全局偏好');expect(document.body.textContent).not.toContain('自动保存');expect(document.body.textContent).not.toContain('使用本机 Codex 配置与登录态');
  await vi.waitFor(()=>expect(button('开启本站翻译').disabled).toBe(false));
  button('开启本站翻译').click();await vi.waitFor(()=>expect(bridge.invoke).toHaveBeenCalledWith('start',{tabId:7,engine:'browser',targetLang:'zh-CN',model:'retained-model',reasoningEffort:'high',maxParagraphs:200}));
  button('Codex').click();
  await vi.waitFor(()=>expect(bridge.invoke).toHaveBeenCalledWith('settings',{engine:'codex'}));
  expect(button('Codex').getAttribute('aria-pressed')).toBe('true');expect(button('浏览器内置').getAttribute('aria-pressed')).toBe('false');
  button('Codex').click();await act(async()=>{});expect(bridge.invoke.mock.calls.filter(([command,input])=>command==='settings'&&input.engine==='codex')).toHaveLength(1);
  await vi.waitFor(()=>expect(bridge.invoke).toHaveBeenCalledWith('host.model.list',{provider:'codex'}));
  expect(button('重新翻译当前页').textContent).toBe('应用并重译');expect(bridge.invoke.mock.calls.filter(([command])=>command==='start')).toHaveLength(1);
});

it('selects advertised models and preserves custom model input',async()=>{
  await mount(); await vi.waitFor(()=>expect(document.querySelector('[aria-label="翻译模型"]').options.length).toBe(3));
  const select=document.querySelector('[aria-label="翻译模型"]'); select.value='available-model';select.dispatchEvent(new Event('change',{bubbles:true}));
  await act(async()=>{}); button('开启本站翻译').click();
  await vi.waitFor(()=>expect(bridge.invoke).toHaveBeenCalledWith('start',{engine:'codex',tabId:7,targetLang:'zh-CN',maxParagraphs:200,model:'available-model',reasoningEffort:'low'}));
  select.value='__custom__';select.dispatchEvent(new Event('change',{bubbles:true}));await act(async()=>{});
  const input=document.querySelector('[aria-label="自定义模型"]');input.value='another-model';input.dispatchEvent(new Event('input',{bubbles:true}));await act(async()=>{});
  button('重新翻译当前页').click();await vi.waitFor(()=>expect(bridge.invoke).toHaveBeenCalledWith('start',{engine:'codex',tabId:7,targetLang:'zh-CN',maxParagraphs:200,model:'another-model',reasoningEffort:'low'}));
});
it('saves model selection globally without starting translation and restores it when reopened',async()=>{
  const invoke=bridge.invoke.getMockImplementation();let preferences={targetLang:'zh-CN',maxParagraphs:200};
  bridge.invoke.mockImplementation(async(command,input)=>{
    if(command==='preferences')return preferences;
    if(command==='settings'){preferences={...preferences,...input};return preferences;}
    return invoke(command,input);
  });
  await mount();await vi.waitFor(()=>expect(document.querySelector('[aria-label="翻译模型"]').options.length).toBe(3));
  const select=document.querySelector('[aria-label="翻译模型"]');select.value='available-model';select.dispatchEvent(new Event('change',{bubbles:true}));
  await vi.waitFor(()=>expect(preferences.model).toBe('available-model'));
  expect(bridge.invoke.mock.calls.some(([command])=>command==='start')).toBe(false);
  preact.render(null,document.getElementById('app'));await mount();
  await vi.waitFor(()=>expect(document.querySelector('[aria-label="翻译模型"]').value).toBe('available-model'));
});
it('keeps site persistence visible while a new document is waiting for automatic activation',async()=>{
  state={enabled:false,status:'idle',instanceId:null,site:'example.test',siteEnabled:true};
  await mount();await vi.waitFor(()=>expect(button('关闭本站并恢复原文')?.textContent).toBe('关闭本站翻译'));
  expect(document.body.textContent).toContain('example.test');expect(document.body.textContent).toContain('等待页面就绪');
  expect(button('关闭本站并恢复原文')).toBeDefined();button('关闭本站并恢复原文').click();
  await vi.waitFor(()=>expect(bridge.invoke).toHaveBeenCalledWith('stop',{tabId:7}));
});
it('does not block startup on slow model discovery and falls back to default and custom options',async()=>{
  const invoke=bridge.invoke.getMockImplementation();let reject;
  bridge.invoke.mockImplementation((command,input)=>command==='host.model.list'?new Promise((_resolve,fail)=>{reject=fail;}):invoke(command,input));
  await mount();await vi.waitFor(()=>expect(button('开启本站翻译').disabled).toBe(false));
  reject(new Error('Discovery unavailable'));await vi.waitFor(()=>expect(document.body.textContent).toContain('模型列表暂不可用'));
  expect(document.querySelector('[aria-label="翻译模型"]').options.length).toBe(2);
  expect(button('开启本站翻译').disabled).toBe(false);
});

it.each([false,true])('keeps a stable loading view until the initial page state settles (failed: %s)',async failed=>{
  const invoke=bridge.invoke.getMockImplementation();let resolve,reject;
  bridge.invoke.mockImplementation((command,input)=>command==='state'?new Promise((done,fail)=>{resolve=done;reject=fail;}):invoke(command,input));
  await mount();await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));
  expect(document.querySelector('.startup')).not.toBeNull();expect(button('开启本站翻译')).toBeUndefined();expect(button('Codex')).toBeUndefined();
  if(failed)reject(new Error('Initial state failed'));else resolve({enabled:false,status:'idle',instanceId:null});
  await vi.waitFor(()=>expect(button('开启本站翻译')?.disabled).toBe(false));
  expect(document.querySelector('.startup')).toBeNull();expect(Boolean(document.querySelector('[role=alert]'))).toBe(failed);
});

it('ignores late events from the replaced page subscription',async()=>{
  await mount();await vi.waitFor(()=>expect(button('开启本站翻译').disabled).toBe(false));
  button('开启本站翻译').click();await vi.waitFor(()=>expect(bridge.subscribe).toHaveBeenCalledOnce());
  const previous=receive;button('重新翻译当前页').click();await vi.waitFor(()=>expect(bridge.subscribe).toHaveBeenCalledTimes(2));
  previous({type:'invalidated'});await act(async()=>{});
  expect(button('关闭本站并恢复原文')).toBeDefined();
});

it('offers explicit apply after saved preferences change while preserving current translation',async()=>{
  state={enabled:true,status:'watching',instanceId:'pi_fixture',targetLang:'zh-CN',maxParagraphs:200,model:'',mode:'bilingual',translated:2,paragraphs:2,cached:0};
  await mount();await vi.waitFor(()=>expect(button('重新翻译当前页')?.textContent).toBe('重新翻译'));
  expect(document.body.textContent).not.toContain('全局偏好 · 自动保存');
  const language=document.querySelector('[aria-label="翻译为"]');language.value='ja';language.dispatchEvent(new Event('change',{bubbles:true}));
  await vi.waitFor(()=>expect(bridge.invoke).toHaveBeenCalledWith('settings',{targetLang:'ja'}));
  expect(bridge.invoke.mock.calls.some(([command])=>command==='start')).toBe(false);
  expect(button('重新翻译当前页').textContent).toBe('应用并重译');
  button('重新翻译当前页').click();
  await vi.waitFor(()=>expect(bridge.invoke).toHaveBeenCalledWith('start',{engine:'codex',tabId:7,targetLang:'ja',maxParagraphs:200,model:'',reasoningEffort:'low'}));
  await vi.waitFor(()=>expect(button('重新翻译当前页').textContent).toBe('重新翻译'));
});
it('uses explicit site action buttons and exposes display selection state accessibly',async()=>{
  await mount();await vi.waitFor(()=>expect(button('开启本站翻译').disabled).toBe(false));
  expect(document.querySelector('.site-name').textContent).toBe('example.test');
  expect(button('开启本站翻译').textContent).toBe('开启本站翻译');
  button('开启本站翻译').click();
  await vi.waitFor(()=>expect(button('关闭本站并恢复原文')?.textContent).toBe('关闭本站翻译'));
  expect(button('双语').getAttribute('aria-pressed')).toBe('true');
  button('译文').click();await vi.waitFor(()=>expect(button('译文').getAttribute('aria-pressed')).toBe('true'));
  expect(bridge.invoke).toHaveBeenCalledWith('display',{tabId:7,mode:'translated'});
  expect(button('双语').getAttribute('aria-pressed')).toBe('false');
  button('原文').click();await vi.waitFor(()=>expect(button('原文').getAttribute('aria-pressed')).toBe('true'));
  expect(button('译文').getAttribute('aria-pressed')).toBe('false');
  expect(button('双语').getAttribute('aria-pressed')).toBe('false');
  button('关闭本站并恢复原文').click();
  await vi.waitFor(()=>expect(button('开启本站翻译')?.textContent).toBe('开启本站翻译'));
});

it('persists reasoning effort globally and applies it only on explicit retranslation',async()=>{
  const invoke=bridge.invoke.getMockImplementation();let preferences={targetLang:'zh-CN',maxParagraphs:200,model:'available-model',reasoningEffort:'low'};
  bridge.invoke.mockImplementation(async(command,input)=>{
    if(command==='host.model.list')return {models:[{id:'available-model',displayName:'Available',reasoningEfforts:['none','low','high']}]};
    if(command==='preferences')return preferences;
    if(command==='settings'){preferences={...preferences,...input};return preferences;}
    return invoke(command,input);
  });
  await mount();await vi.waitFor(()=>expect([...document.querySelector('[aria-label="思考级别"]').options].map(option=>option.value)).toContain('none'));
  const select=document.querySelector('[aria-label="思考级别"]');
  expect([...select.options].map(option=>option.value)).toEqual(['default','none','low','high']);
  select.value='none';select.dispatchEvent(new Event('change',{bubbles:true}));
  await vi.waitFor(()=>expect(preferences.reasoningEffort).toBe('none'));
  expect(bridge.invoke.mock.calls.some(([command])=>command==='start')).toBe(false);
  preact.render(null,document.getElementById('app'));await mount();
  await vi.waitFor(()=>expect(document.querySelector('[aria-label="思考级别"]').value).toBe('none'));
  button('开启本站翻译').click();
  await vi.waitFor(()=>expect(bridge.invoke).toHaveBeenCalledWith('start',{engine:'codex',tabId:7,targetLang:'zh-CN',maxParagraphs:200,model:'available-model',reasoningEffort:'none'}));
});
it('selects a supported effort when changing to a model with different capabilities',async()=>{
  const invoke=bridge.invoke.getMockImplementation();
  bridge.invoke.mockImplementation(async(command,input)=>command==='host.model.list'?{models:[{id:'available-model',displayName:'Available',reasoningEfforts:['medium','high']}]}:invoke(command,input));
  await mount();await vi.waitFor(()=>expect(document.querySelector('[aria-label="翻译模型"]').options.length).toBe(3));
  const select=document.querySelector('[aria-label="翻译模型"]');select.value='available-model';select.dispatchEvent(new Event('change',{bubbles:true}));
  await vi.waitFor(()=>expect(bridge.invoke).toHaveBeenCalledWith('settings',{model:'available-model',reasoningEffort:'default'}));
  expect(document.querySelector('[aria-label="思考级别"]').value).toBe('default');
});

it('keeps a saved model selected while discovery is pending without showing a custom-model field',async()=>{
  const invoke=bridge.invoke.getMockImplementation();let resolve;
  bridge.invoke.mockImplementation((command,input)=>{
    if(command==='preferences')return Promise.resolve({targetLang:'zh-CN',maxParagraphs:200,model:'saved-model'});
    if(command==='host.model.list')return new Promise(done=>{resolve=done;});
    return invoke(command,input);
  });
  await mount();await vi.waitFor(()=>expect(document.querySelector('[aria-label="翻译模型"]').value).toBe('saved-model'));
  expect(document.querySelector('[aria-label="自定义模型"]')).toBeNull();
  await vi.waitFor(()=>expect(button('开启本站翻译').disabled).toBe(false));
  resolve({models:[{id:'saved-model',displayName:'Saved model'}]});
  await vi.waitFor(()=>expect(document.querySelector('[aria-label="翻译模型"]').selectedOptions[0].textContent).toBe('Saved model'));
});

it('shows partial failures separately from pending text and keeps the retry action available',async()=>{
  state={enabled:true,status:'partial',instanceId:'pi_fixture',engine:'browser',targetLang:'zh-CN',maxParagraphs:200,mode:'bilingual',translated:23,paragraphs:45,pending:0,failed:22,failureError:'Native failure',error:null};
  await mount();await vi.waitFor(()=>expect(document.body.textContent).toContain('部分段落未译'));
  expect(document.body.textContent).toContain('待译 0 · 未译 22');expect(document.body.textContent).not.toContain('当前区域已完成');
  expect(document.querySelector('progress').value).toBe(23);expect(document.querySelector('progress').max).toBe(45);
  button('重试失败段落').click();await vi.waitFor(()=>expect(bridge.invoke).toHaveBeenCalledWith('retry',{tabId:7}));
});
it('saves the floating switch setting without starting page translation',async()=>{
  await mount();await vi.waitFor(()=>expect(document.querySelector('[aria-label="页面悬浮开关"]')).not.toBeNull());
  const checkbox=document.querySelector('[aria-label="页面悬浮开关"]');expect(checkbox.checked).toBe(false);
  checkbox.checked=true;checkbox.dispatchEvent(new Event('change',{bubbles:true}));
  await vi.waitFor(()=>expect(bridge.invoke).toHaveBeenCalledWith('settings',{floating:true,tabId:7}));
  expect(bridge.invoke.mock.calls.some(([command])=>command==='start'||command==='start-page')).toBe(false);
});
it('does not flash translating status when a completed page subscription replays a running event',async()=>{
  state={enabled:true,status:'watching',instanceId:'pi_fixture',targetLang:'zh-CN',maxParagraphs:200,mode:'bilingual',translated:2,paragraphs:2,pending:0};
  await mount();await vi.waitFor(()=>expect(document.body.textContent).toContain('当前区域已完成'));
  receive({type:'running'});await act(async()=>{});
  expect(document.body.textContent).toContain('当前区域已完成');expect(document.body.textContent).not.toContain('正在翻译');
});

it('persists automatic mode, exposes Codex controls and distinguishes reading results from upgrades',async()=>{
  state={enabled:true,status:'refining',instanceId:'pi_fixture',engine:'auto',targetLang:'zh-CN',maxParagraphs:200,mode:'bilingual',translated:4,paragraphs:4,pending:0,refined:1,refining:3,cached:0};
  const invoke=bridge.invoke.getMockImplementation();bridge.invoke.mockImplementation((command,input)=>command==='preferences'?Promise.resolve({engine:'auto',model:'available-model',targetLang:'zh-CN',maxParagraphs:200,reasoningEffort:'low'}):invoke(command,input));
  await mount();await vi.waitFor(()=>expect(button('自动').getAttribute('aria-pressed')).toBe('true'));
  expect(document.querySelector('[aria-label="翻译模型"]')).not.toBeNull();expect(document.querySelector('[aria-label="思考级别"]')).not.toBeNull();
  await vi.waitFor(()=>expect(document.body.textContent).toContain('Codex 翻译中'));expect(document.body.textContent).toContain('Codex 译文 1 / 4 段');
  expect(document.querySelector('progress').value).toBe(4);expect(document.body.textContent).not.toContain('当前区域已完成');
  button('Codex').click();await vi.waitFor(()=>expect(bridge.invoke).toHaveBeenCalledWith('settings',{engine:'codex'}));
  button('自动').click();await vi.waitFor(()=>expect(bridge.invoke).toHaveBeenCalledWith('settings',{engine:'auto'}));
});
it('explains a single-engine failure while keeping automatic translation available',async()=>{
  state={enabled:true,status:'watching',instanceId:'pi_fixture',engine:'auto',targetLang:'zh-CN',maxParagraphs:200,mode:'bilingual',translated:2,paragraphs:2,pending:0,refined:0,refining:0,warningEngine:'codex',warning:'No credentials',cached:0};
  await mount();await vi.waitFor(()=>expect(document.body.textContent).toContain('Codex 暂不可用，继续使用浏览器译文。'));
  expect(button('重试失败段落')).toBeDefined();expect(document.body.textContent).not.toContain('翻译中断');
});
