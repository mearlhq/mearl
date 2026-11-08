import {
  APP_PROFILE_RUNTIME_ASSET,
  APP_PROFILE_RUNTIME_INSTALLER,
} from '../../shared/appProfileRuntimeAsset';
import type { InjectedAppProfileConfig } from '@mearl/browser-core';
import {
  buildPageRuntimeCallSource,
  buildPageRuntimeRegistrationSource,
} from '@mearl/preset/bundles';
import { browserCapabilityRegistry } from './browserCapabilityRegistry';

let runtimeSource: Promise<string> | undefined;

/** 后台只缓存包内脚本文本，目标文档通过 CDP 同步执行完整启动脚本。 */
export function loadAppProfileRuntimeSource(): Promise<string> {
  if (!runtimeSource) {
    runtimeSource = fetch(chrome.runtime.getURL(APP_PROFILE_RUNTIME_ASSET))
      .then(async response => {
        if (!response.ok) {
          throw new Error(`Failed to load app profile runtime asset: HTTP ${response.status}`);
        }
        const source = await response.text();
        if (!source.trim()) throw new Error('App profile runtime asset is empty');
        return source;
      })
      .catch(error => {
        runtimeSource = undefined;
        throw error;
      });
  }
  return runtimeSource;
}

export async function buildAppProfileRuntimeProgram(
  configExpression: string,
  config?: InjectedAppProfileConfig,
) {
  if (config?.pageRuntime) {
    const source = await browserCapabilityRegistry().pageRuntimeSource(config.pageRuntime.sha256);
    return {
      registration: buildPageRuntimeRegistrationSource(
        config.pageRuntime,
        source,
        APP_PROFILE_RUNTIME_INSTALLER,
      ),
      call: buildPageRuntimeCallSource(configExpression),
    };
  }
  const source = await loadAppProfileRuntimeSource();
  return {
    registration: '',
    call: `${source};window[${JSON.stringify(APP_PROFILE_RUNTIME_INSTALLER)}](${configExpression});`,
  };
}

export async function buildAppProfileRuntimeCallSource(
  configExpression: string,
  config?: InjectedAppProfileConfig,
): Promise<string> {
  const program = await buildAppProfileRuntimeProgram(configExpression, config);
  return program.registration + program.call;
}
