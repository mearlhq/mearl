// @vitest-environment happy-dom
import { beforeAll, beforeEach, afterEach, expect, it, vi, type Mock } from 'vitest';
import { installAppBridgeConfigOverlay } from '../appBridgeConfigOverlay';
const host = () => document.querySelector<HTMLElement>('[data-mearl-app-bridge-config]');
const show = (extra = {}) => window.dispatchEvent(new MessageEvent('message', { source: window, data: { source: 'mearl-app-bridge', type: 'showBridgeConfig', profile: 'sample/app', actions: { noop: [], responses: { feature: { enabled: false } } }, settings: [{ id: 'feature', label: 'Feature', type: 'boolean', target: { method: 'feature', field: 'enabled' } }], ...extra } }));
let showProfileSettings: ReturnType<typeof installAppBridgeConfigOverlay>;
beforeAll(() => { showProfileSettings = installAppBridgeConfigOverlay(); });
beforeEach(() => { (chrome.runtime as unknown as { id: string }).id = 'test-extension'; (chrome.runtime.sendMessage as unknown as Mock).mockReset().mockResolvedValue({ success: true, responses: { feature: { enabled: true } } }); });
afterEach(() => { host()?.shadowRoot?.querySelector<HTMLButtonElement>('#close')?.click(); vi.restoreAllMocks(); });
it('renders declared controls and applies successful responses to the current document', async () => {
  const post = vi.spyOn(window, 'postMessage'); show();
  const control = host()!.shadowRoot!.querySelector<HTMLButtonElement>('[data-value="true"]')!;
  control.click();
  await vi.waitFor(() => expect(control).toHaveAttribute('aria-pressed', 'true'));
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'appBridgeSetSetting', profile: 'sample/app', settingId: 'feature', value: true });
  expect(post).toHaveBeenCalledWith({ source: 'mearl-content', type: 'APP_BRIDGE_RUNTIME_RESPONSES', profile: 'sample/app', responses: { feature: { enabled: true } } }, '*');
});
it('keeps the accepted value when persistence fails', async () => {
  (chrome.runtime.sendMessage as unknown as Mock).mockResolvedValue({ success: false }); show();
  const control = host()!.shadowRoot!.querySelector<HTMLButtonElement>('[data-value="true"]')!; control.click();
  await vi.waitFor(() => expect(host()!.shadowRoot!.getElementById('status')).toHaveTextContent('settingsSaveFailed'));
  expect(control).toHaveAttribute('aria-pressed', 'false');
});
it('lets an installed runtime own its settings surface', () => { show({ settingsUi: 'runtime' }); expect(host()).toBeNull(); });
it('selects another web page environment and closes the settings after the switch', async () => {
  const profile = 'wechat';
  const next = 'wechat-mini-program-webview';
  (chrome.runtime.sendMessage as unknown as Mock)
    .mockResolvedValueOnce({ success: true, profile, variants: [
      { label: 'WeChat web page', value: profile },
      { label: 'WeChat mini-program web page', value: next },
    ] })
    .mockResolvedValueOnce({ success: true });
  await showProfileSettings!();
  const shadow = host()!.shadowRoot!;
  expect(shadow.querySelector('[data-value="wechat"]')).toHaveAttribute('aria-pressed', 'true');
  shadow.querySelector<HTMLButtonElement>('[data-value="wechat-mini-program-webview"]')!.click();
  await vi.waitFor(() => expect(host()).toBeNull());
  expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({
    action: 'appBridgeProfileVariants', profile, next,
  });
});
it('keeps the no-options state and Escape lifecycle', () => { show({ settings: [] }); expect(host()!.shadowRoot!.querySelectorAll('.method-card')).toHaveLength(0); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); expect(host()).toBeNull(); });
