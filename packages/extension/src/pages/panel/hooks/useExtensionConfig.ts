import { useEffect, useState } from 'react';
import { DEFAULT_CONFIG, getConfig, onConfigChange, type ExtensionConfig } from '../utils/config';

/** 配置订阅与初始快照合并，异步页面准备不参与配置状态的写入。 */
export function useExtensionConfig(
  initialConfig?: ExtensionConfig,
  { localOnly = false }: { localOnly?: boolean } = {},
): [ExtensionConfig, boolean] {
  const [state, setState] = useState(() => ({
    config: initialConfig ?? DEFAULT_CONFIG,
    ready: initialConfig !== undefined,
  }));

  useEffect(() => {
    let disposed = false;
    const updates: Partial<ExtensionConfig> = {};
    const unsubscribe = onConfigChange(changes => {
      if (disposed) return;
      Object.assign(updates, changes);
      setState(previous => ({ ...previous, config: { ...previous.config, ...changes } }));
    });
    if (!initialConfig) {
      void getConfig({ localOnly }).then(
        config => {
          if (!disposed)
            setState({ config: { ...DEFAULT_CONFIG, ...config, ...updates }, ready: true });
        },
        error => {
          console.warn('[Config] Failed to load initial config:', error);
          if (!disposed) setState(previous => ({ ...previous, ready: true }));
        },
      );
    }
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [initialConfig, localOnly]);

  return [state.config, state.ready];
}
