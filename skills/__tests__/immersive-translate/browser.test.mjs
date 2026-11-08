// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserTranslation } from '../../immersive-translate/scripts/browser.mjs';
let engine, translators, detector, status, signal;
beforeEach(()=>{
  translators=[];status=vi.fn();signal=new AbortController();
  detector={detect:vi.fn(async text=>[{detectedLanguage:text.startsWith('Bonjour')?'fr':'en',confidence:.99}]),destroy:vi.fn()};
  vi.stubGlobal('LanguageDetector',{availability:vi.fn(async()=> 'available'),create:vi.fn(async()=>detector)});
  vi.stubGlobal('Translator',{availability:vi.fn(async()=> 'available'),create:vi.fn(async options=>{const translator={options,translate:vi.fn(async text=>'译文 '+text),destroy:vi.fn()};translators.push(translator);return translator;})});
  engine=createBrowserTranslation(status);
});
afterEach(()=>{engine.dispose();vi.unstubAllGlobals();vi.restoreAllMocks();});
const run=(items=[{id:'1',text:'An English paragraph.',sourceLanguage:'en'}],target='zh-CN')=>engine.translate(items,target,signal.signal);
describe('browser translation engine',()=>{
  it('detects each paragraph language, reuses resources, and emits results as paragraphs finish',async()=>{
    const result=vi.fn();
    const output=await engine.translate([{id:'1',text:'An English paragraph.'},{id:'2',text:'Bonjour le monde.'},{id:'3',text:'Another English paragraph.'}], 'zh-CN',signal.signal,result);
    expect(globalThis.LanguageDetector.create).toHaveBeenCalledOnce();expect(globalThis.Translator.create).toHaveBeenCalledTimes(2);
    expect(translators.map(value=>value.options)).toEqual([expect.objectContaining({sourceLanguage:'en',targetLanguage:'zh'}),expect.objectContaining({sourceLanguage:'fr',targetLanguage:'zh'})]);
    expect(output.translations.map(value=>value.id)).toEqual(['1','2','3']);expect(result).toHaveBeenCalledTimes(3);
    engine.dispose();await Promise.resolve();expect(detector.destroy).toHaveBeenCalledOnce();for(const translator of translators)expect(translator.destroy).toHaveBeenCalledOnce();
  });
  it('preserves every code literal verbatim without exposing it to native translation',async()=>{
    const text='Assign Enterprise Open-Source License Manager and foo() to Enterprise Open-Source License Manager.';
    const result=await run([{id:'1',text,codeLiterals:['Enterprise Open-Source License Manager','foo()']}]);
    expect(result.translations[0].text.match(/Enterprise Open-Source License Manager/g)).toHaveLength(2);expect(result.translations[0].text).toContain('foo()');
    expect(translators[0].translate.mock.calls.flatMap(([text])=>text).join(' ')).not.toContain('Enterprise Open-Source License Manager');
    expect(translators[0].translate.mock.calls.flatMap(([text])=>text).join(' ')).not.toContain('foo()');
  });
  it('uses declared language when detection is unavailable and keeps already-target-language content intact',async()=>{
    globalThis.LanguageDetector.availability.mockResolvedValue('unavailable');
    const items=[{id:'1',text:'A paragraph already in English.',sourceLanguage:'en-US'}];
    expect(await run(items,'en')).toEqual({translations:[{id:'1',text:items[0].text}]});expect(globalThis.Translator.create).not.toHaveBeenCalled();
    await run([{id:'2',text:'Traditional source text.',sourceLanguage:'zh-TW'}],'en');
    expect(translators[0].options.sourceLanguage).toBe('zh-Hant');
  });
  it('reports unavailable pairs and unknown languages without choosing another engine',async()=>{
    globalThis.Translator.availability.mockResolvedValue('unavailable');expect(await run()).toMatchObject({translations:[],failures:[{id:'1',error:'BROWSER_TRANSLATION_UNAVAILABLE'}]});
    globalThis.Translator.availability.mockResolvedValue('available');
    detector.detect.mockResolvedValue([{detectedLanguage:'und',confidence:.9}]);
    expect(await run([{id:'2',text:'An ambiguous source.'}])).toMatchObject({translations:[],failures:[{id:'2',error:'BROWSER_TRANSLATION_LANGUAGE_UNKNOWN'}]});
  });
  it('uses the declared language for ambiguous brand labels without requesting unrelated language packs',async()=>{
    detector.detect.mockResolvedValueOnce([{detectedLanguage:'da',confidence:.78},{detectedLanguage:'en',confidence:.06}]).mockResolvedValueOnce([{detectedLanguage:'de',confidence:.51},{detectedLanguage:'en',confidence:.06}]).mockResolvedValueOnce([{detectedLanguage:'fr',confidence:.99}]);
    await run([{id:'1',text:'GitHub Marketplace',sourceLanguage:'en'},{id:'2',text:'GitHub Copilot Autofix',sourceLanguage:'en'},{id:'3',text:'Bonjour le monde.',sourceLanguage:'en'}]);
    expect(translators.map(value=>value.options.sourceLanguage)).toEqual(['en','fr']);expect(translators[0].translate).toHaveBeenCalledTimes(2);
  });
  it('recreates a failed translator once and reuses the replacement for later paragraphs',async()=>{
    const create=globalThis.Translator.create.getMockImplementation();
    globalThis.Translator.create.mockImplementationOnce(async options=>{const value=await create(options);value.translate.mockRejectedValue(new DOMException('Other generic failures occurred.','UnknownError'));return value;});
    const result=vi.fn(),items=[{id:'1',text:'First paragraph.'},{id:'2',text:'Second paragraph.'}];
    expect(await engine.translate(items,'zh-CN',signal.signal,result)).toMatchObject({translations:[{id:'1'},{id:'2'}]});
    expect(translators).toHaveLength(2);expect(translators[0].destroy).toHaveBeenCalledOnce();expect(translators[0].translate).toHaveBeenCalledOnce();
    expect(translators[1].translate).toHaveBeenCalledTimes(2);expect(result).toHaveBeenCalledTimes(2);
  });
  it('isolates a persistent paragraph failure, bounds retries and continues subsequent text',async()=>{
    const create=globalThis.Translator.create.getMockImplementation();
    globalThis.Translator.create.mockImplementation(async options=>{const value=await create(options);value.translate.mockImplementation(async text=>{if(text==='Broken paragraph.')throw new DOMException('Native failure','UnknownError');return '译文 '+text;});return value;});
    const result=vi.fn();
    expect(await engine.translate([{id:'1',text:'First paragraph.'},{id:'2',text:'Broken paragraph.'},{id:'3',text:'Last paragraph.'}],'zh-CN',signal.signal,result)).toEqual({translations:[{id:'1',text:'译文 First paragraph.'},{id:'3',text:'译文 Last paragraph.'}],failures:[{id:'2',error:'Native failure'}]});
    expect(translators).toHaveLength(3);expect(translators.flatMap(value=>value.translate.mock.calls).filter(([text])=>text==='Broken paragraph.')).toHaveLength(2);
    expect(result.mock.calls.map(([item])=>item.id)).toEqual(['1','3']);expect(translators.slice(0,2).every(value=>value.destroy.mock.calls.length===1)).toBe(true);
  });
  it('recreates a failed detector without recreating healthy translators',async()=>{
    detector.detect.mockRejectedValueOnce(new DOMException('Detector resource lost','InvalidStateError'));
    const next={detect:vi.fn(async()=>[{detectedLanguage:'en',confidence:.99}]),destroy:vi.fn()};globalThis.LanguageDetector.create.mockResolvedValueOnce(detector).mockResolvedValueOnce(next);
    expect(await run()).toHaveProperty('translations');expect(detector.destroy).toHaveBeenCalledOnce();expect(next.detect).toHaveBeenCalledOnce();expect(translators).toHaveLength(1);
  });
  it('does not retry validation errors or recreate resources after cancellation',async()=>{
    const create=globalThis.Translator.create.getMockImplementation();
    globalThis.Translator.create.mockImplementation(async options=>{const value=await create(options);value.translate.mockImplementation(async()=>{signal.abort();throw new DOMException('Resource failed','UnknownError');});return value;});
    await expect(run()).rejects.toBeDefined();expect(translators).toHaveLength(1);
    signal=new AbortController();globalThis.Translator.create.mockImplementation(async options=>{const value=await create(options);value.translate.mockRejectedValue(new DOMException('Too large','QuotaExceededError'));return value;});
    expect(await run()).toMatchObject({failures:[{id:'1',error:'Too large'}]});expect(translators).toHaveLength(2);
  });
  it('waits for document activation when needed, reports downloads and removes gesture listeners',async()=>{
    const create=globalThis.Translator.create.getMockImplementation();let attempts=0;
    globalThis.Translator.create.mockImplementation(async options=>{if(!attempts++)throw new DOMException('User interaction required','NotAllowedError');const monitor=new EventTarget();options.monitor(monitor);const event=new Event('downloadprogress');Object.assign(event,{loaded:.5,total:1});monitor.dispatchEvent(event);return create(options);});
    const remove=vi.spyOn(document,'removeEventListener'),pending=run();
    await vi.waitFor(()=>expect(status).toHaveBeenCalledWith({status:'activation-required'}));
    document.dispatchEvent(new Event('pointerdown'));await expect(pending).resolves.toHaveProperty('translations');
    expect(status).toHaveBeenCalledWith({status:'downloading',progress:.5});expect(status).toHaveBeenLastCalledWith({status:'ready'});
    expect(remove).toHaveBeenCalledWith('pointerdown',expect.any(Function),true);expect(remove).toHaveBeenCalledWith('keydown',expect.any(Function),true);
  });
  it('cancels activation waits and destroys resources that finish creating after cancellation',async()=>{
    let resolve;globalThis.Translator.create.mockRejectedValueOnce(new DOMException('Interaction required','NotAllowedError')).mockImplementation(()=>new Promise(done=>{resolve=done;}));
    const pending=run(),rejected=expect(pending).rejects.toBeDefined();
    await vi.waitFor(()=>expect(status).toHaveBeenCalledWith({status:'activation-required'}));document.dispatchEvent(new Event('keydown'));
    signal.abort();await rejected;const resource={destroy:vi.fn()};resolve(resource);await vi.waitFor(()=>expect(resource.destroy).toHaveBeenCalledOnce());
  });
  it('cancels a slow translation immediately without emitting a late result',async()=>{
    let resolve;globalThis.Translator.create.mockImplementation(async()=>({translate:()=>new Promise(done=>{resolve=done;}),destroy:vi.fn()}));
    const result=vi.fn(),pending=engine.translate([{id:'1',text:'A slow paragraph.'}],'zh',signal.signal,result),rejected=expect(pending).rejects.toBeDefined();
    await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));signal.abort();await rejected;resolve('Late text');await Promise.resolve();expect(result).not.toHaveBeenCalled();
  });
});
