# 浏览器本地能力包

[简体中文](browser-bundles.md) | [English](browser-bundles.en.md)

`@mearl/preset/bundles` 提供浏览器与 Node 可共享的资源准备，以及浏览器专用的 IndexedDB 快照存储。调用它不需要 native-host。它还提供受控页面运行时的资源存储和注入源码生成；尚不提供 preset 一键安装 UI、网页通信桥或 App 专用 schema。

整套包的事务激活和 App 实现选择见 [浏览器 Preset 激活](browser-presets.md)。

## 准备和激活

```ts
import {
  BrowserBundleStore, createBundleFetchLoader, prepareBundle,
} from '@mearl/preset/bundles';

const store = new BrowserBundleStore({ mearlApiVersion: '1.0.0' });
const previous = await store.get('sample');
const bundle = await prepareBundle('https://example.com/sample/bundle.json', {
  expectedId: 'sample',
  mearlApiVersion: '1.0.0',
  version: '^1',
  load: createBundleFetchLoader(),
});

// 宿主在这里验证贡献内容、命名空间和授权；资源摘要不等于来源可信。
await validateHostContributions(bundle);
await store.install(bundle, previous?.revision ?? null);
```

`prepareBundle` 读取清单和全部资源，校验预期包 ID、版本/API 范围、资源大小和 SHA-256，成功后返回独立快照。安装器固定期望来源并检查浏览器权限；默认下载不带凭据、不接受重定向。需要认证的资源加载由宿主提供受控 fetch 实现。

清单格式：

```json
{
  "schemaVersion": 1,
  "id": "sample",
  "version": "1.0.0",
  "requires": { "mearlApi": "^1" },
  "resources": {
    "profiles/app.json": {
      "sha256": "<64 位小写十六进制摘要>",
      "byteLength": 1234
    }
  },
  "contributions": { "appProfiles": ["profiles/app.json"] }
}
```

摘要和大小需由真实资源生成，示例占位值不能直接安装。路径只允许包目录内的普通相对路径，不接受 URL、父目录、百分号编码、查询参数或片段。清单最多 64 KiB、1–64 个资源，资源合计最多 16 MiB。

## 持久化与更新

- `install` 再次验证资源后，以当前 revision 作为条件，在同一个 IndexedDB 事务里替换快照。并发更新或移除导致 revision 改变时，陈旧请求报 `BUNDLE_CONFLICT`。
- revision 覆盖来源、清单和其中的全部资源摘要。改变下载来源也会改变 revision。
- `get` 和 `list` 从本地恢复并重新验证，不读取在线目录。`list` 单独报告每个损坏包，其他包继续可用。
- 未完成下载、摘要不符、宿主校验失败和事务失败都不会先删除旧快照。
- 最多保存 64 个包，全部资源与活动文档保留的代码共用 64 MiB 唯一字节预算。包只保存清单和引用；资源在 `objects` 中按摘要保存一份，多个包或页面引用相同资源不重复计费。正在使用的端模拟配置由宿主复制并绑定定义，不能通过重新查询最新快照来替换在途文档。开发存储格式见 [能力包模型](capability-model.md)。
- `remove` 同样需要预期 revision。活动文档的资源归属与停用由宿主管理；存储层不猜测哪些 tab 正在使用某个包。

只有通过宿主贡献校验的快照才能被标为“已安装可用”。旧 Node 插件目录缓存不能直接导入为本地安装，否则离线可能启用已经卸载的插件。

## 页面运行时

包可声明 `contributions.pageRuntimes: { main: "runtime/main.cjs" }`；文件必须列入 resources，并且不超过 2 MiB。宿主贡献通过 `{ id: "sample/main", sha256 }` 绑定代码，验证命名空间、文件摘要和贡献 schema。`readBundleText` 只解码 UTF-8，不执行代码。

运行时是无外部依赖的 CommonJS 文件，导出 `install(config)`。宿主通过 `buildPageRuntimeRegistrationSource` 为受控页面的 MAIN world 生成注册源码，配置派发使用 `buildPageRuntimeCallSource`。安装函数应可重复调用。静态 document_start 入口和 debugger 注册的先后顺序均可：未找到对应摘要时配置等待注册，有绑定的配置不能回退到其他运行时。模块代码只在受控页面执行，不在扩展 Service Worker 中求值。

`pageRuntimeSource(sha256)` 从本地代码缓存读取并重新校验。宿主在切换生效前通过 `pinPageRuntimes({ owner: sha256 })` 保留确切版本，切换失败后恢复原引用，关闭或清除环境时通过 `{ owner: null }` 释放。包替换、卸载和引用变更会在同一事务内回收没有包或 owner 引用的代码。宿主重启后应从自己的权威会话状态调用 `synchronizePageRuntimePins`，清理中断操作残留的临时引用；此操作允许保留指向缺失代码的引用，让受影响环境单独报告损坏。

同一缓存也保存浏览器后台模块，`browserRuntimeBytes(sha256)` 校验并返回其字节。扩展的 App 绑定同时固定页面代码、用户信息及 PROTOCOL 宿主模块的摘要、配置和处理器；提供者更新或移除后，该绑定继续使用已接受实现。修改同一定义的设置或版本保留绑定，显式刷新定义重新选择模块。规则恢复会重建引用，清除绑定会释放引用；每次请求仍检查当前域名及 Cookie 权限，缺失或损坏的已绑定代码不会回退到其他实现。

代码摘要只验证完整性，不构成信任或授权。宿主负责来源策略、用户授权、运行位置和浏览器扩展发布渠道的适用要求；本库不向页面提供扩展 API，也不执行宿主特权代码。

界面的异步后台操作可通过 [浏览器后台能力](browser-services.md) 声明，使用受限宿主接口执行请求与 Cookie 操作。

## 验证

自动测试覆盖下载完整性、路径越界、版本/API 要求、取消、重开存储、损坏更新、并发冲突及单包损坏隔离；`pnpm check:preset-browser` 在无 Node 全局环境执行准备与校验。

真实浏览器夹具：

```bash
node scripts/browser-bundle-fixture.mjs
```

夹具返回本地 URL。在隔离浏览器中依次点击 Install sample bundle、Reload and restore、Attempt corrupt update。预期版本始终为 1.0.0；首次安装后资源端点主动返回 503，重载仍显示 restored，损坏更新显示 rejected-corrupt-update。`/state.json` 应显示资源只下载两次且 packagesAvailable 为 false。终端按 Ctrl+C 或输入 close 停止。

2026-10-22 已在隔离 Chrome 中通过上述流程；测试驱动使用现有 Mearl，但夹具页面和被测包不连接扩展或 native-host。这验证浏览器持久化及准备流程，不代替完整扩展的首屏桥、子 WebView 或 UI 等价验收。
