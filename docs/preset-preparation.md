# Preset 资源准备

[简体中文](preset-preparation.md) | [English](preset-preparation.en.md)

`@mearl/preset/bundles` 的 `preparePreset` 用于 setup 与浏览器安装视图共享的资源准备。一次解析继承图，按最终启用的 `packages` 下载资源；同时用于浏览器和 Node 的包只下载一次。继承清单、包清单和资源共用最多 64 MiB 的下载预算，最多选择 64 个包。

```ts
import { preparePreset, verifyPreset, createBundleFetchLoader } from '@mearl/preset/bundles';
import { prepareNodeBundleSnapshot } from '@mearl/preset';

const prepared = await preparePreset('https://example.com/presets/team.json', {
  mearlApiVersion: '1.0.0',
  load: createBundleFetchLoader(),
});
const node = await prepareNodeBundleSnapshot(
  prepared.bundles.filter(bundle => prepared.preset.packages[bundle.manifest.id].targets?.includes('node')),
  'native-host',
  '1.0.0',
);
const restored = await verifyPreset(prepared.snapshot, '1.0.0');
```

加载器仍负责来源信任、凭据、实际网络权限和取消。以上代码不安装、执行工厂、写本机文件或申请浏览器权限。`node` 是确切模块/配置/hook 选择与已校验代码，交给 Node 安装宿主接续；Node 处理器冲突在此步骤拒绝。

`prepared.snapshot` 记录带 `schemaVersion: 1` 的完整包图、确切继承清单、包 revision 及 `packageTargets`。`verifyPreset` 离线重新解析和核对图，资源字节仍须由安装存储校验。`prepared.browser` 是同批资源投影出的 `PreparedBrowserPreset`，接入 IndexedDB 原子激活；其 revision 覆盖确切包选择和目标端。完整快照与浏览器快照互不接受，防止 Node 包被遗漏后把局部结果误作整套记录。

包贡献决定支持的执行位置，Preset 可通过 `targets` 选择子集，省略时自动推导并将结果保存为 `packageTargets`。发现全部目标后，先校验每端依赖，再下载所选资源。浏览器独立安装继续使用 `prepareBrowserPreset`，可以读取待发现包的清单，但不下载仅用于 Node 的资源，不要求 Node 在线。完整准备遇到版本、摘要或下载失败时整体拒绝，不返回局部成功。

`skills`、`providers`、默认配置、权限需求和声明来源保留在解析结果中；此步骤不运行 Skills/npm 安装，也不报告其已就绪。完整的安装回执、用户配置覆盖、两侧同步与 UI 仍需由安装宿主接续。不得因资源准备成功显示“整套可用”。
