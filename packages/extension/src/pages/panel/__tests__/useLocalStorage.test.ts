import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useLocalStorage, useLocalStorageBoolean } from '../hooks/useLocalStorage';

describe('useLocalStorage hook 测试', () => {
  // Mock chrome.storage.local
  let mockStorage: Record<string, any> = {};
  let storageChangeListeners: Set<
    (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void
  >;

  beforeEach(() => {
    mockStorage = {};
    storageChangeListeners = new Set();

    // 重置 chrome mock
    global.chrome = {
      ...global.chrome,
      storage: {
        local: {
          get: vi.fn((keys: any, callback: any) => {
            // 使用 queueMicrotask 模拟异步行为，比 setTimeout 更可靠
            queueMicrotask(() => {
              const result: Record<string, any> = {};
              if (Array.isArray(keys)) {
                keys.forEach((key: string) => {
                  if (key in mockStorage) {
                    result[key] = mockStorage[key];
                  }
                });
              }
              callback(result);
            });
          }) as any,
          set: vi.fn((items: any, callback: any) => {
            // 使用 queueMicrotask 模拟异步行为
            queueMicrotask(() => {
              const changes = Object.fromEntries(
                Object.entries(items).map(([key, value]) => [
                  key,
                  {
                    oldValue: mockStorage[key],
                    newValue: value,
                  },
                ]),
              );

              Object.assign(mockStorage, items);
              storageChangeListeners.forEach(listener => {
                listener(changes as Record<string, chrome.storage.StorageChange>, 'local');
              });
              if (callback) callback();
            });
          }) as any,
          remove: vi.fn(),
        },
        onChanged: {
          addListener: vi.fn(
            (
              listener: (
                changes: Record<string, chrome.storage.StorageChange>,
                areaName: string,
              ) => void,
            ) => {
              storageChangeListeners.add(listener);
            },
          ),
          removeListener: vi.fn(
            (
              listener: (
                changes: Record<string, chrome.storage.StorageChange>,
                areaName: string,
              ) => void,
            ) => {
              storageChangeListeners.delete(listener);
            },
          ),
        },
      } as any,
      runtime: {
        id: 'test-extension-id',
        lastError: undefined,
      },
    } as any;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reads and subscribes without writing an unset default or overwriting the owning view selection', async () => {
    const { result } = renderHook(() => useLocalStorage<string | undefined>('shared-selection', undefined, { sync: true, persist: false }));
    await waitFor(() => expect(result.current[2]).toBe(true));
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    act(() => { for (const listener of storageChangeListeners) listener({ 'shared-selection': { newValue: 'selected' } }, 'local'); });
    expect(result.current[0]).toBe('selected');
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  describe('useLocalStorage', () => {
    it('应该使用初始值初始化', async () => {
      const { result } = renderHook(() => useLocalStorage('test-key', 'initial'));

      await waitFor(() => {
        expect(result.current[0]).toBe('initial');
      });
    });

    it('应该从 chrome.storage 加载已存在的值', async () => {
      mockStorage['test-key'] = 'stored-value';

      const { result } = renderHook(() => useLocalStorage('test-key', 'initial'));

      await waitFor(
        () => {
          expect(result.current[0]).toBe('stored-value');
        },
        { timeout: 3000 },
      );
    });

    it('应该能够更新值', async () => {
      const { result } = renderHook(() => useLocalStorage('test-key', 'initial'));

      await waitFor(() => {
        expect(result.current[0]).toBe('initial');
      });

      act(() => {
        result.current[1]('updated');
      });

      await waitFor(() => {
        expect(result.current[0]).toBe('updated');
        expect(mockStorage['test-key']).toBe('updated');
      });
    });

    it('应该支持函数式更新', async () => {
      mockStorage['counter'] = 5;

      const { result } = renderHook(() => useLocalStorage('counter', 0));

      await waitFor(() => {
        expect(result.current[0]).toBe(5);
      });

      act(() => {
        result.current[1](prev => prev + 1);
      });

      await waitFor(() => {
        expect(result.current[0]).toBe(6);
        expect(mockStorage['counter']).toBe(6);
      });
    });

    it('应该处理对象类型的值', async () => {
      const initialObj = { name: 'test', count: 0 };
      const { result } = renderHook(() => useLocalStorage('obj-key', initialObj));

      await waitFor(() => {
        expect(result.current[0]).toEqual(initialObj);
      });

      const updatedObj = { name: 'updated', count: 5 };
      act(() => {
        result.current[1](updatedObj);
      });

      await waitFor(() => {
        expect(result.current[0]).toEqual(updatedObj);
        expect(mockStorage['obj-key']).toEqual(updatedObj);
      });
    });

    it('应该处理数组类型的值', async () => {
      const initialArray = [1, 2, 3];
      const { result } = renderHook(() => useLocalStorage('array-key', initialArray));

      await waitFor(() => {
        expect(result.current[0]).toEqual(initialArray);
      });

      act(() => {
        result.current[1]([...result.current[0], 4]);
      });

      await waitFor(() => {
        expect(result.current[0]).toEqual([1, 2, 3, 4]);
      });
    });

    it('默认不在其他 panel 更新 storage 时同步值', async () => {
      const { result } = renderHook(() => useLocalStorage('test-key', 'initial'));

      await waitFor(() => {
        expect(result.current[0]).toBe('initial');
      });

      expect(global.chrome.storage.onChanged.addListener).not.toHaveBeenCalled();

      act(() => {
        storageChangeListeners.forEach(listener => {
          listener(
            {
              'test-key': {
                oldValue: 'initial',
                newValue: 'synced-from-other-panel',
              },
            } as Record<string, chrome.storage.StorageChange>,
            'local',
          );
        });
      });

      await waitFor(() => {
        expect(result.current[0]).toBe('initial');
      });
    });

    it('应该在其他 panel 更新 storage 时同步值', async () => {
      const { result } = renderHook(() => useLocalStorage('test-key', 'initial', { sync: true }));

      await waitFor(() => {
        expect(result.current[0]).toBe('initial');
      });

      await waitFor(() => {
        expect(global.chrome.storage.local.set).toHaveBeenCalledWith(
          { 'test-key': 'initial' },
          expect.any(Function),
        );
      });

      vi.mocked(global.chrome.storage.local.set).mockClear();

      act(() => {
        storageChangeListeners.forEach(listener => {
          listener(
            {
              'test-key': {
                oldValue: 'initial',
                newValue: 'synced-from-other-panel',
              },
            } as Record<string, chrome.storage.StorageChange>,
            'local',
          );
        });
      });

      await waitFor(() => {
        expect(result.current[0]).toBe('synced-from-other-panel');
      });

      expect(global.chrome.storage.local.set).not.toHaveBeenCalledWith(
        { 'test-key': 'synced-from-other-panel' },
        expect.anything(),
      );
    });
  });

  describe('useLocalStorageBoolean', () => {
    it('应该使用初始布尔值初始化', async () => {
      const { result } = renderHook(() => useLocalStorageBoolean('bool-key', false));

      await waitFor(() => {
        expect(result.current[0]).toBe(false);
      });
    });

    it('应该能够切换布尔值', async () => {
      const { result } = renderHook(() => useLocalStorageBoolean('bool-key', false));

      await waitFor(() => {
        expect(result.current[0]).toBe(false);
      });

      act(() => {
        result.current[1](); // toggle
      });

      await waitFor(() => {
        expect(result.current[0]).toBe(true);
        expect(mockStorage['bool-key']).toBe(true);
      });

      act(() => {
        result.current[1](); // toggle again
      });

      await waitFor(() => {
        expect(result.current[0]).toBe(false);
        expect(mockStorage['bool-key']).toBe(false);
      });
    });

    it('应该从 chrome.storage 加载已存在的布尔值', async () => {
      mockStorage['bool-key'] = true;

      const { result } = renderHook(() => useLocalStorageBoolean('bool-key', false));

      await waitFor(() => {
        expect(result.current[0]).toBe(true);
      });
    });
  });

  it('does not expose or persist the previous value while a new key is loading', async () => {
    const pending = new Map<string, (value: Record<string, string>) => void>();
    chrome.storage.local.get = vi.fn((keys, callback) => { pending.set((keys as string[])[0], callback!); }) as any;
    const { result, rerender } = renderHook(({ key }) => useLocalStorage(key, 'initial'), { initialProps: { key: 'first' } });
    await act(async () => { pending.get('first')!({ first: 'first-value' }); });
    const oldSetter = result.current[1];
    vi.mocked(chrome.storage.local.set).mockClear();
    rerender({ key: 'second' });
    expect(result.current[2]).toBe(false);
    expect(result.current[0]).toBe('initial');
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    await act(async () => { pending.get('second')!({ second: 'second-value' }); });
    act(() => oldSetter('late-first-value'));
    expect(result.current[0]).toBe('second-value');
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    act(() => result.current[1]('updated-second'));
    await waitFor(() => expect(mockStorage.second).toBe('updated-second'));
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith({ second: 'first-value' }, expect.anything());
  });

  it('uses the new scope default for functional updates before its read completes', async () => {
    const pending = new Map<string, (value: Record<string, string>) => void>();
    chrome.storage.local.get = vi.fn((keys, callback) => { pending.set((keys as string[])[0], callback!); }) as any;
    const { result, rerender } = renderHook(({ key, initial }) => useLocalStorage(key, initial), { initialProps: { key: 'first', initial: 'first-default' } });
    await act(async () => { pending.get('first')!({ first: 'first-value' }); });
    rerender({ key: 'second', initial: 'second-default' });
    act(() => {
      result.current[1](previous => previous + '!');
      result.current[1](previous => previous + '!');
    });
    expect(result.current[0]).toBe('second-default!!');
    await act(async () => { pending.get('second')!({ second: 'stale-second' }); });
    await waitFor(() => expect(mockStorage.second).toBe('second-default!!'));
    expect(result.current[0]).toBe('second-default!!');
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith({ second: 'first-value!!' }, expect.anything());
  });

  it('ignores an earlier key read that finishes after the new key', async () => {
    const pending = new Map<string, (value: Record<string, string>) => void>();
    chrome.storage.local.get = vi.fn((keys, callback) => { pending.set((keys as string[])[0], callback!); }) as any;
    const { result, rerender } = renderHook(({ key }) => useLocalStorage(key, 'initial'), { initialProps: { key: 'first' } });
    rerender({ key: 'second' });
    await act(async () => { pending.get('second')!({ second: 'second-value' }); });
    await act(async () => { pending.get('first')!({ first: 'late-first-value' }); });
    expect(result.current[0]).toBe('second-value');
    expect(result.current[2]).toBe(true);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('initializes an unset new key from its default rather than the old key value', async () => {
    mockStorage.first = 'first-value';
    const { result, rerender } = renderHook(({ key }) => useLocalStorage(key, 'initial'), { initialProps: { key: 'first' } });
    await waitFor(() => expect(result.current[2]).toBe(true));
    rerender({ key: 'second' });
    await waitFor(() => expect(mockStorage.second).toBe('initial'));
    expect(mockStorage.first).toBe('first-value');
    expect(result.current[0]).toBe('initial');
  });

  it('preserves a newer storage event while its initial read is still pending', async () => {
    let finish!: (value: Record<string, string>) => void;
    chrome.storage.local.get = vi.fn((_keys, callback) => { finish = callback!; }) as any;
    const { result } = renderHook(() => useLocalStorage('selection', 'initial', { sync: true }));
    act(() => { for (const listener of storageChangeListeners) listener({ selection: { newValue: 'new-value' } }, 'local'); });
    await act(async () => { finish({ selection: 'stale-value' }); });
    expect(result.current[0]).toBe('new-value');
    expect(result.current[2]).toBe(true);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  describe('错误处理', () => {
    it('应该处理 chrome.storage.local.get 错误', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      global.chrome.storage.local.get = vi.fn((keys: any, callback: any) => {
        setTimeout(() => {
          global.chrome.runtime.lastError = { message: 'Test error' };
          callback({});
          // 需要在下一个 tick 清除，让错误被捕获
          setTimeout(() => {
            global.chrome.runtime.lastError = undefined;
          }, 0);
        }, 0);
      }) as any;

      const { result } = renderHook(() => useLocalStorage('test-key', 'initial'));

      await waitFor(() => {
        expect(result.current[0]).toBe('initial');
        expect(consoleErrorSpy).toHaveBeenCalled();
      });

      consoleErrorSpy.mockRestore();
    });

    it('应该处理 chrome.storage.local.set 错误', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      global.chrome.storage.local.set = vi.fn((items: any, callback: any) => {
        setTimeout(() => {
          global.chrome.runtime.lastError = { message: 'Test error' };
          if (callback) callback();
          // 需要在下一个 tick 清除，让错误被捕获
          setTimeout(() => {
            global.chrome.runtime.lastError = undefined;
          }, 0);
        }, 0);
      }) as any;

      const { result } = renderHook(() => useLocalStorage('test-key', 'initial'));

      await waitFor(() => {
        expect(result.current[0]).toBe('initial');
      });

      act(() => {
        result.current[1]('updated');
      });

      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalled();
      });

      consoleErrorSpy.mockRestore();
    });
  });
});
