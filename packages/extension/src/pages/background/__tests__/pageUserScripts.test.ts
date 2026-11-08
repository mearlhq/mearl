import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../toolboxPageFrame', () => ({ resolveToolboxPageFrame: vi.fn().mockResolvedValue(0) }));
import { resolveToolboxPageFrame } from '../toolboxPageFrame';
import { executePageUserScript } from '../pageUserScripts';

function event() {
  const listeners = new Set<(...args: any[]) => void>();
  return {
    addListener: vi.fn(fn => listeners.add(fn)),
    fire: (...args: any[]) => listeners.forEach(fn => fn(...args)),
  };
}

let api: { configureWorld: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn> };
let connected: ReturnType<typeof event>;
let updated: ReturnType<typeof event>;
let removed: ReturnType<typeof event>;
let send: ReturnType<typeof vi.fn>;
let completed: ReturnType<typeof event>;

beforeEach(() => {
  vi.mocked(resolveToolboxPageFrame).mockResolvedValue(0);
  api = {
    configureWorld: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue([{ result: { ok: true, value: 42 } }]),
  };
  connected = event();
  updated = event();
  removed = event();
  completed = event();
  send = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('chrome', {
    userScripts: api,
    runtime: { onUserScriptConnect: connected, sendMessage: send },
    tabs: { onUpdated: updated, onRemoved: removed },
    webNavigation: { onCompleted: completed },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('plugin user scripts', () => {
  it('executes dynamic code in an isolated world without persistent messaging', async () => {
    expect(
      await executePageUserScript({
        tabId: 7,
        worldId: 'design-overlay',
        code: 'Promise.resolve(42)',
      }),
    ).toEqual({ result: 42 });
    expect(api.configureWorld).toHaveBeenCalledWith({
      worldId: 'mearl-eval-design-overlay',
      messaging: false,
    });
    expect(api.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 7, frameIds: [0] },
        world: 'USER_SCRIPT',
        worldId: 'mearl-eval-design-overlay',
        js: [{ code: expect.stringContaining('await (Promise.resolve(42)') }],
      }),
    );
  });
  it('injects into the selected business WebView and accepts its event port', async () => {
    vi.mocked(resolveToolboxPageFrame).mockResolvedValueOnce(12);
    await executePageUserScript({ tabId: 70, worldId: 'design-overlay', code: '1' });
    expect(api.execute).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 70, frameIds: [12] } }),
    );
  });
  it('reports disabled permissions and script errors without falling back to debugger', async () => {
    api.configureWorld.mockRejectedValueOnce(new Error('not enabled'));
    await expect(executePageUserScript({ tabId: 7, worldId: 'test', code: '1' })).rejects.toThrow(
      'Allow User Scripts',
    );
    expect(api.execute).not.toHaveBeenCalled();
    api.execute.mockResolvedValueOnce([{ error: 'script failed' }]);
    await expect(executePageUserScript({ tabId: 7, worldId: 'test', code: '1' })).rejects.toThrow(
      'script failed',
    );
  });
  it('reports unsupported plugin page scripts before accessing Chrome 120 APIs', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Chrome/120.0.0.0' });

    await expect(executePageUserScript({ tabId: 7, worldId: 'test', code: '1' })).rejects.toThrow(
      'USER_SCRIPTS_UNSUPPORTED: Plugin page scripts require Chrome 135 or newer',
    );
    expect(api.configureWorld).not.toHaveBeenCalled();
  });
  it('directs Chrome 135 users to Developer mode when access to userScripts throws', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Chrome/135.0.0.0' });
    Object.defineProperty(chrome, 'userScripts', {
      get() {
        throw new Error('not enabled');
      },
    });

    await expect(executePageUserScript({ tabId: 7, worldId: 'test', code: '1' })).rejects.toThrow(
      'USER_SCRIPTS_DISABLED: Enable Developer mode',
    );
  });
  it('captures sync throws and rejected promises even when Chrome omits injection errors', async () => {
    api.execute.mockImplementation(async ({ js }) => [
      { result: await new Function(`return ${js[0].code}`)() },
    ]);
    await expect(
      executePageUserScript({
        tabId: 7,
        worldId: 'test',
        code: '(() => { throw new Error("invalid design"); })()',
      }),
    ).rejects.toThrow('invalid design');
    await expect(
      executePageUserScript({
        tabId: 7,
        worldId: 'test',
        code: 'Promise.reject(new Error("decode failed"))',
      }),
    ).rejects.toThrow('decode failed');
    await expect(
      executePageUserScript({ tabId: 7, worldId: 'test', code: 'Promise.resolve(42)' }),
    ).resolves.toEqual({ result: 42 });
    api.execute.mockResolvedValueOnce([{ result: undefined }]);
    await expect(executePageUserScript({ tabId: 7, worldId: 'test', code: '(' })).rejects.toThrow(
      'expression syntax',
    );
  });
  it('validates targets before injection', async () => {
    await expect(executePageUserScript({ tabId: -1, worldId: 'test', code: '1' })).rejects.toThrow(
      'target tab',
    );
    await expect(
      executePageUserScript({ tabId: 1, worldId: '../test', code: '1' }),
    ).rejects.toThrow('worldId');
    expect(api.configureWorld).not.toHaveBeenCalled();
  });
});
