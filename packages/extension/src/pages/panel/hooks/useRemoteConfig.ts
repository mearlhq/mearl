import { useEffect, useState } from 'react';
import { fetchRemoteConfig, type RemoteConfig } from '../../../shared/remoteConfig';
import { storageGetSafely, storageSetSafely } from '../utils/safeChrome';

const CONFIG_CACHE_KEY = 'mearl-remote-config-cache';
export type { RemoteConfig } from '../../../shared/remoteConfig';

/**
 * 远端 config.json 承载 Banner 文案、最新版本号、下载链接等运行时配置。
 * 先返回 chrome.storage 里上次拉取的缓存让 UI 立即渲染，同时请求远端，
 * 成功后覆盖返回值并刷新缓存；两者都失败时返回 null，调用方需自行做兜底
 */
export function useRemoteConfig(): RemoteConfig | null {
  const [config, setConfig] = useState<RemoteConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    // 远端结果比缓存新，一旦到达就不允许缓存读取再覆盖它
    let remoteLoaded = false;

    storageGetSafely<RemoteConfig>([CONFIG_CACHE_KEY])
      .then(result => {
        const cached = result?.[CONFIG_CACHE_KEY];
        if (!cancelled && !remoteLoaded && cached) {
          setConfig(cached);
        }
      })
      .catch(() => {
        /* 读缓存失败则等远端结果 */
      });

    fetchRemoteConfig()
      .then(data => {
        remoteLoaded = true;
        if (!cancelled) {
          setConfig(data);
        }
        // 组件卸载也照常回写，供下次打开面板直接使用
        storageSetSafely({ [CONFIG_CACHE_KEY]: data }).catch(() => {
          /* ignore */
        });
      })
      .catch(() => {
        /* 获取失败则保持缓存值或 null */
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}
