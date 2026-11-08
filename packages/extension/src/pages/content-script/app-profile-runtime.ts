import {
  installAppProfileRuntime,
  installRootWebViewDocumentTransport,
} from '@mearl/browser-core/appProfileRuntime';
import { APP_PROFILE_RUNTIME_INSTALLER } from '../../shared/appProfileRuntimeAsset';
import { installPageRuntimeHost } from '@mearl/preset/bundles';

const host = installPageRuntimeHost();

installRootWebViewDocumentTransport();

// 同一 MAIN world 的 document_start 和 CDP bootstrap 共用这个同步安装入口。
Object.defineProperty(window, APP_PROFILE_RUNTIME_INSTALLER, {
  configurable: true,
  value: (config: Parameters<typeof installAppProfileRuntime>[0]) =>
    host.install(config, installAppProfileRuntime),
});
