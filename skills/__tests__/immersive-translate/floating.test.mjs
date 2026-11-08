// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installTranslation } from '../../immersive-translate/scripts/runtime.mjs';
import { createFloatingSwitch } from '../../immersive-translate/scripts/floating.mjs';

let runtime,host,shadows;
beforeEach(()=>{
  document.body.innerHTML='<main><p>A complete English paragraph for translation.</p></main>';document.documentElement.lang='en';
  vi.stubGlobal('location',window.location);vi.stubGlobal('innerHeight',800);vi.stubGlobal('innerWidth',1200);
  vi.spyOn(window.HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({top:20,bottom:70,left:0,right:600,width:600,height:50});
  shadows=[];const attach=window.Element.prototype.attachShadow;
  vi.spyOn(window.Element.prototype,'attachShadow').mockImplementation(function(options){const shadow=attach.call(this,options);shadows.push(shadow);return shadow;});
  host={identity:{instanceId:'floating-fixture'},emit:vi.fn(async()=>({accepted:true}))};
  runtime=installTranslation(host,undefined,createFloatingSwitch);
});
afterEach(()=>{runtime.dispose();vi.restoreAllMocks();vi.unstubAllGlobals();});
const floating=()=>document.querySelector('[data-mearl-translation-floating]');
const button=()=>shadows.at(-1).querySelector('button');

it('inserts one isolated switch below the right midpoint and excludes it from translation',()=>{
  runtime.receive({type:'FLOATING',enabled:true});const element=floating();
  expect(element.shadowRoot).toBeNull();expect(element.style.left).toBe('1144px');expect(Number.parseFloat(element.style.top)).toBeCloseTo(489.2);expect(runtime.receive({type:'STATE'}).enabled).toBe(false);
  runtime.receive({type:'FLOATING',enabled:true,position:{x:0,y:1}});expect(floating()).toBe(element);expect(shadows).toHaveLength(1);expect(element.style.left).toBe('16px');expect(element.style.top).toBe('744px');
  expect(runtime.receive({type:'START',targetLang:'zh-CN',maxParagraphs:200}).paragraphs).toBe(1);expect(floating()).toBe(element);
  expect(button().getAttribute('aria-pressed')).toBe('true');
  runtime.receive({type:'FLOATING',enabled:false});expect(floating()).toBeNull();expect(runtime.receive({type:'STATE'}).enabled).toBe(true);
});
it('waits for a toggle result, reflects the display mode, and releases a failed click',async()=>{
  runtime.receive({type:'FLOATING',enabled:true});button().click();button().click();
  expect(host.emit).toHaveBeenCalledExactlyOnceWith('toggle',{});expect(button().disabled).toBe(true);expect(button().querySelector('.loading')).not.toBeNull();expect(button().textContent).not.toContain('…');
  runtime.receive({type:'START',targetLang:'zh-CN',maxParagraphs:200});expect(button().disabled).toBe(false);
  button().click();runtime.receive({type:'DISPLAY',mode:'original'});expect(button().disabled).toBe(false);expect(button().getAttribute('aria-pressed')).toBe('false');
  button().click();runtime.receive({type:'FLOATING_ERROR',error:'Temporarily unavailable'});expect(button().disabled).toBe(false);expect(button().title).toBe('Temporarily unavailable');
  host.emit.mockRejectedValueOnce(new Error('Disconnected'));button().click();await Promise.resolve();await Promise.resolve();expect(button().disabled).toBe(false);expect(button().title).toBe('Disconnected');
});
it('removes the floating switch on document disposal and validates placement',()=>{
  expect(()=>runtime.receive({type:'FLOATING',enabled:'yes'})).toThrow('floating switch');
  runtime.receive({type:'FLOATING',enabled:true,position:{x:0,y:.65}});runtime.dispose();expect(floating()).toBeNull();
});

const pointer=(target,type,x,y)=>target.dispatchEvent(new window.PointerEvent(type,{pointerId:1,isPrimary:true,button:0,clientX:x,clientY:y,bubbles:true,cancelable:true,composed:true}));
it('drags without translating, saves only on release, clamps to the viewport and restores after refresh',()=>{
  runtime.receive({type:'FLOATING',enabled:true});
  button().setPointerCapture=vi.fn(()=>{throw new Error('No active native pointer');});
  pointer(floating(),'pointerdown',1164,509);pointer(window,'pointermove',600,200);
  expect(host.emit).not.toHaveBeenCalled();expect(button().classList.contains('is-dragging')).toBe(true);
  pointer(window,'pointerup',600,200);button().click();
  expect(host.emit).toHaveBeenCalledOnce();expect(host.emit.mock.calls[0][0]).toBe('move');
  const position=host.emit.mock.calls[0][1],left=floating().style.left,top=floating().style.top;
  runtime.dispose();runtime=installTranslation(host,undefined,createFloatingSwitch);runtime.receive({type:'FLOATING',enabled:true,position});
  expect(floating().style.left).toBe(left);expect(floating().style.top).toBe(top);
  pointer(button(),'pointerdown',600,200);pointer(window,'pointermove',-1000,2000);pointer(window,'pointerup',-1000,2000);
  expect(host.emit).toHaveBeenLastCalledWith('move',{x:0,y:1});expect(floating().style.left).toBe('16px');expect(floating().style.top).toBe('744px');
  vi.stubGlobal('innerWidth',400);vi.stubGlobal('innerHeight',300);window.dispatchEvent(new Event('resize'));
  expect(floating().style.top).toBe('244px');
});
it('keeps a click after small pointer movement and cancels an interrupted drag',()=>{
  runtime.receive({type:'FLOATING',enabled:true});
  pointer(button(),'pointerdown',100,200);pointer(window,'pointermove',102,201);pointer(window,'pointerup',102,201);button().click();
  expect(host.emit).toHaveBeenCalledExactlyOnceWith('toggle',{});
  runtime.receive({type:'DISPLAY',mode:'original'});host.emit.mockClear();const top=floating().style.top;
  pointer(button(),'pointerdown',100,200);pointer(window,'pointermove',100,300);pointer(window,'pointercancel',100,300);button().click();
  expect(host.emit).not.toHaveBeenCalled();expect(floating().style.top).toBe(top);
  pointer(button(),'pointerdown',100,200);runtime.dispose();pointer(window,'pointerup',200,200);expect(host.emit).not.toHaveBeenCalled();
});
