// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDeviceChromeView } from '../deviceChromeView.js';

const iosConfig = {
  platform: 'ios',
  statusBarHeight: 47,
  bottomBarHeight: 34,
  cutout: 'dynamic-island',
} as const;

function createShadowRoot(): ShadowRoot {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return host.attachShadow({ mode: 'open' });
}

describe('device chrome view', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('renders shared iOS chrome and updates host-owned state', () => {
    const onBottomAction = vi.fn();
    const root = createShadowRoot();
    const view = installDeviceChromeView(root, iosConfig, {
      onBottomAction,
      initialState: { bottomActionEnabled: true },
      labels: { bottomAction: 'Open settings' },
    });

    expect(root.getElementById('device-chrome')?.getAttribute('data-platform')).toBe('ios');
    expect(root.getElementById('device-cutout')?.getAttribute('data-kind')).toBe('dynamic-island');
    expect(root.getElementById('signal')).toBeTruthy();
    expect(root.getElementById('wifi')).toBeTruthy();
    expect(root.getElementById('battery')).toBeTruthy();
    expect(root.querySelector('style')?.textContent).toContain('height: calc(47px + 1px)');
    expect(root.querySelector('style')?.textContent).toContain('height: 34px');

    const bottomAction = root.getElementById('gesture-surface') as HTMLButtonElement;
    expect(bottomAction.disabled).toBe(false);
    expect(bottomAction.getAttribute('aria-label')).toBe('Open settings');
    bottomAction.click();
    expect(onBottomAction).toHaveBeenCalledOnce();

    view.updateState({
      statusBarVisible: false,
      statusBarBackground: 'rgb(12, 34, 56)',
      textColor: 'rgb(240, 240, 240)',
    });
    expect(root.getElementById('status-bar')?.style.display).toBe('none');
    expect(root.getElementById('status-bar')?.style.background).toBe('rgb(12, 34, 56)');
    expect(root.getElementById('device-chrome')?.style.color).toBe('rgb(240, 240, 240)');

    view.destroy();
    expect(root.childNodes).toHaveLength(0);
  });

  it('keeps the Dynamic Island screenshot interaction in the shared renderer', async () => {
    const captureScreenshot = vi.fn().mockRejectedValue(new Error('capture unavailable'));
    const root = createShadowRoot();
    const view = installDeviceChromeView(root, iosConfig, { captureScreenshot });

    root.getElementById('device-cutout')!.click();

    await vi.waitFor(() => expect(captureScreenshot).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(root.getElementById('device-cutout')?.getAttribute('data-state')).toBe('failed'),
    );
    view.destroy();
  });

  it('renders Duo controls in the reserved right-side rail', () => {
    const root = createShadowRoot();
    const view = installDeviceChromeView(root, {
      platform: 'ios',
      statusBarHeight: 0,
      bottomBarHeight: 34,
      sideBarWidth: 84,
      cutout: 'side-camera',
    });

    expect(root.getElementById('device-chrome')?.getAttribute('data-side-bar')).toBe('true');
    expect(root.getElementById('device-cutout')?.getAttribute('data-kind')).toBe('side-camera');
    expect(root.getElementById('duo-status-icon')).toBeTruthy();
    expect(root.getElementById('duo-battery-arc')?.getAttribute('d')).toBe(
      'M6.7 34A20 20 0 1 1 41.3 34',
    );
    const signalDots = [...root.querySelectorAll('#duo-signal-arc circle')];
    expect(signalDots).toHaveLength(4);
    const dotPositions = signalDots.map(dot => Number(dot.getAttribute('cx')));
    expect(dotPositions.slice(1).map((position, index) => position - dotPositions[index]!)).toEqual(
      [7, 7, 7],
    );
    expect(root.getElementById('duo-wifi')).toBeTruthy();
    expect(root.getElementById('signal')).toBeNull();
    expect(root.getElementById('battery')).toBeNull();
    expect(root.querySelector('style')?.textContent).toContain('width: 84px');
    expect(root.querySelector('style')?.textContent).toContain(
      '#device-chrome[data-side-bar="true"] #status-indicators',
    );
    expect(root.querySelector('style')?.textContent).toMatch(
      /#device-chrome\[data-side-bar="true"\] #time \{[^}]*top: 77px/s,
    );
    view.updateState({ statusBarVisible: false });
    expect(root.getElementById('status-bar')?.style.display).not.toBe('none');
    expect(root.getElementById('status-content')?.style.visibility).toBe('hidden');
    view.destroy();
  });

  it('does not reserve the outer camera slot in the unfolded Duo side rail', () => {
    const root = createShadowRoot();
    const view = installDeviceChromeView(root, {
      platform: 'ios',
      statusBarHeight: 0,
      bottomBarHeight: 34,
      sideBarWidth: 84,
      cutout: 'none',
    });

    expect(root.getElementById('device-cutout')).toBeNull();
    const style = root.querySelector('style')?.textContent;
    expect(style).toMatch(/#device-chrome\[data-side-bar="true"\] #time \{[^}]*top: 25px/s);
    expect(style).toMatch(
      /#device-chrome\[data-side-bar="true"\] #status-indicators \{[^}]*top: 49px/s,
    );
    view.destroy();
  });

  it('can be serialized for Native CDP document injection', () => {
    const serializedInstaller = (0, eval)(
      `(${installDeviceChromeView.toString()})`,
    ) as typeof installDeviceChromeView;
    const root = createShadowRoot();
    const view = serializedInstaller(root, {
      platform: 'android',
      statusBarHeight: 24,
      bottomBarHeight: 24,
      cutout: 'dynamic-island',
    });

    expect(root.getElementById('device-chrome')?.getAttribute('data-platform')).toBe('android');
    expect(root.getElementById('device-cutout')).toBeNull();
    expect(root.getElementById('time')?.textContent).toMatch(/^\d{2}:\d{2}$/);
    view.destroy();
  });

  it('applies and restores a status-bar time offset immediately', () => {
    const now = new Date(2026, 8, 5, 12, 34, 0);
    vi.spyOn(Date, 'now').mockReturnValue(now.getTime());
    const root = createShadowRoot();
    const view = installDeviceChromeView(root, iosConfig);
    const nativeTime = root.getElementById('time')?.textContent;
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);

    view.updateState({ timeOffsetMs: midnight.getTime() - now.getTime() });
    expect(root.getElementById('time')?.textContent).toBe('00:00');

    view.updateState({ timeOffsetMs: null });
    expect(root.getElementById('time')?.textContent).toBe(nativeTime);
    view.destroy();
  });
});
