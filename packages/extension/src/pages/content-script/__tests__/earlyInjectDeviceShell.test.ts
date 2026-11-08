// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../injected/eventSource', () => ({ interceptEventSource: vi.fn() }));
vi.mock('../injected/fetch', () => ({ interceptFetch: vi.fn(), listenForOverrideMessages: vi.fn() }));
vi.mock('../injected/xhr', () => ({ interceptXHR: vi.fn() }));
vi.mock('../injected/resend', () => ({ listenForResendRequests: vi.fn() }));
vi.mock('../injected/collectElement', () => ({ collectElementData: vi.fn(), installElementCollectorBridge: vi.fn() }));
vi.mock('../injected/windowOpen', () => ({ hookWindowOpen: vi.fn() }));
vi.mock('../injected/envSwitch', () => ({ installEnvSwitch: vi.fn(), readInjectedProtocolEnvironment: vi.fn() }));
vi.mock('../injected/pageTime', () => ({ applyPageTimeOverride: vi.fn(), listenForPageTimeOverride: vi.fn() }));
beforeEach(() => {
  vi.resetModules(); delete window.__mearlEarlyInjected;
  document.documentElement.innerHTML='<head></head><body></body>';
  // Happy DOM rejects replacing documentElement while the old root is attached.
  vi.spyOn(document, 'replaceChild').mockImplementation(((_node: Node, previous: Node) => previous) as typeof document.replaceChild);
  Object.defineProperty(document,'contentType',{configurable:true,value:'text/html'});
  window.__mearlInstallAppProfileRuntime__=vi.fn(); Object.defineProperty(window,'stop',{configurable:true,value:vi.fn()});
});
afterEach(()=>{vi.restoreAllMocks();delete window.__mearlEarlyInjected;});
it.each([undefined,{profile:'reader',userAgent:'basic UA'}])('builds a root WebView for the built-in device shell with profile %j', async profile=>{
  const timing=[{name:'mearl-device-shell',description:btoa(JSON.stringify({version:1,config:{platform:'ios',safeAreaInsets:{top:0,right:0,bottom:0,left:0}}}))}];
  if(profile)timing.push({name:'mearl-app-profile',description:btoa(JSON.stringify({version:1,config:profile}))});
  vi.spyOn(performance,'getEntriesByType').mockReturnValue([{serverTiming:timing}] as any);
  await import('../early-inject');
  const replacement = vi.mocked(document.replaceChild).mock.calls[0]?.[0] as HTMLElement;
  const frame=replacement?.querySelector<HTMLIFrameElement>('iframe[data-mearl-root-webview]');
  expect(frame?.name).toBe('__mearl_root__'); expect(frame?.src).toBe(location.href);
  if(profile)expect(window.__mearlInstallAppProfileRuntime__).toHaveBeenCalledOnce();
});
it('leaves container creation to the bound dynamic runtime', async()=>{
  vi.spyOn(performance,'getEntriesByType').mockReturnValue([{serverTiming:[
    {name:'mearl-device-shell',description:btoa(JSON.stringify({version:1,config:{platform:'ios',safeAreaInsets:{top:0,right:0,bottom:0,left:0}}}))},
    {name:'mearl-app-profile',description:btoa(JSON.stringify({version:1,config:{profile:'fixture/app',pageRuntime:{id:'fixture',sha256:'test'}}}))},
  ]}] as any);
  await import('../early-inject');
  expect(window.__mearlInstallAppProfileRuntime__).toHaveBeenCalledOnce(); expect(document.querySelector('iframe[data-mearl-root-webview]')).toBeNull(); expect(window.stop).not.toHaveBeenCalled(); expect(document.replaceChild).not.toHaveBeenCalled();
});

it('lets a bridge runtime use the built-in root WebView', async () => {
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ serverTiming: [
    { name: 'mearl-device-shell', description: btoa(JSON.stringify({ version: 1, config: { platform: 'ios' } })) },
    { name: 'mearl-app-profile', description: btoa(JSON.stringify({ version: 1, config: { pageRuntime: { id: 'fixture', sha256: 'test' } } })) },
  ] }] as unknown as PerformanceEntry[]);
  const root = window as Window & { __mearlInstallDeviceShellRootWebView__?: () => void };
  try {
    vi.mocked(window.__mearlInstallAppProfileRuntime__).mockImplementation(() => {
      root.__mearlInstallDeviceShellRootWebView__?.();
    });
    await import('../early-inject');
    const replacement = vi.mocked(document.replaceChild).mock.calls[0]?.[0] as HTMLElement;
    expect(replacement?.querySelector('iframe[data-mearl-root-webview]')).not.toBeNull();
  } finally {
    delete root.__mearlInstallDeviceShellRootWebView__;
  }
});
