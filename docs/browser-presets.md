# 浏览器 Preset 激活

[简体中文](browser-presets.md) | [English](browser-presets.en.md)

`@mearl/preset/bundles` 可以准备并原子激活 preset 的浏览器部分。包贡献决定支持的运行位置；Preset 可用 `targets: ["browser"]` 选择启用子集，省略时自动推导。确切图的 `packageTargets` 保存推导结果，包含两种位置的包仍需两端分别完成安装。完整模型见 [能力包模型](capability-model.md)。

```ts
const previous = await store.list();
const prepared = await prepareBrowserPreset(source, {
  load: createBundleFetchLoader(), mearlApiVersion: '1.0.0',
});
// 宿主验证所有贡献的 schema、命名空间和映射目标，再允许激活。
await validateHostContributions(prepared);
await store.activatePreset(prepared.snapshot, prepared.bundles.map(bundle => ({
  bundle, expectedRevision: previous.revisions[bundle.manifest.id] ?? null,
})), previous.activeRevision);
```

`prepareBrowserPreset` 解析继承、保存确切清单图，准备浏览器包，并检查 App 实现属于已启用的浏览器包。浏览器包不能以只在 Node 可用的包作为前置依赖。宿主仍需验证映射指向真实贡献，不能仅凭字符串格式接受端模拟配置。

下载共享 64 MiB 预算，包含 preset、包清单和资源；达到预算后停止后续请求。受限宿主可以用 `maxDownloadBytes` 降低该预算。持久化资源总预算也是 64 MiB。激活前先检查资源总量，再复制、校验全部包；最终事务还会检查现有独立包及被活动环境保留的页面运行时代码占用的空间。

包资源和 preset 指针在同一 IndexedDB 事务中切换，同时检查旧 preset revision 和各包 revision。任何下载、贡献校验、配额或并发检查失败都保留旧状态。版本 1 数据库升级时保留原有独立安装的包。

`activePreset()` 只用保存的父子清单图重新解析，得到确切继承链、默认值和全部组件声明，不访问网络。`profileBinding(appId)` 读取所选实现和确切本地资源，拒绝已经变更或损坏的提供者。宿主将该实现绑定回原 App ID，保留菜单位置、用户设置键及调用身份；页面配置仍固定其自身定义，已打开页面不会在安装时被改写。

`list()` 返回有效的绑定图、各包错误、当前 preset revision 和包 revisions。一个包损坏时仍保留有效清单的绑定信息，宿主只禁用受影响的 App。清单图本身损坏时报告 `activationError`，不能静默当成未安装 preset。已被当前 preset 管理的包不能用单包 install/remove 绕过整套更新。

切换 preset 保留独立安装及未选择的包。页面运行时代码按包和宿主 owner 引用回收，见 [能力包说明](browser-bundles.md#页面运行时)。Node 组件、Skills、Provider 和默认配置由各宿主管理；完整就绪状态由安装协调器汇总。

浏览器夹具 `node scripts/browser-bundle-fixture.mjs` 支持在全新本地 URL 上点击 **Install sample preset**，随后 **Reload and restore**：应持续显示 `selectedProvider: "sample/app"`，资源端点关闭后恢复不增加下载次数。该夹具验证本地事务和映射，不代替完整 App 模拟验收。

2026-10-22 已在隔离 Chrome 完成上述 preset 流程，并验证损坏更新被拒绝后映射仍可读取；资源端点已关闭，资源下载计数保持两次。测试驱动使用 Mearl，夹具页面和被测库不连接扩展或 Native Host。
