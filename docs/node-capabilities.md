# Node 能力包

[简体中文](node-capabilities.md) | [English](node-capabilities.en.md)

Native Host 提供浏览器/CDP 控制、插件执行与 Agent 服务。Node 能力包通过同一资源清单和 Preset 包图提供处理器；浏览器本地能力包可独立运行。Setup 与网页安装桥共用安装协调器、组件状态和部分安装恢复。

本机确切记录、Node 激活/回滚及 setup 命令见 [安装宿主](preset-installation.md)。浏览器同步和外部组件尚未安装时，会报告真实待同步状态。

## 资源和选择

包通过 `contributions.nodeRuntimes` 声明宿主、一个自包含 `.cjs` 入口及有限的 hook → 导出处理器映射：

```json
{
  "appProfiles": [],
  "nodeRuntimes": {
    "native-host": {
      "entry": "runtime.cjs",
      "bindings": { "sample.value": "value" }
    }
  }
}
```

入口导出工厂，接收宿主服务和该模块的 JSON 配置，返回函数表：

```js
module.exports = (host, config) => ({
  value: () => ({ version: host.version, enabled: config.enabled === true }),
});
```

`prepareNodeBundleSnapshot` 先校验全部模块元数据与配额，再复制和摘要代码。选择上限为 64 个模块、256 个 hook、单模块 16 MiB、总资源 64 MiB。模块摘要、配置与 hook 映射共同构成 revision。重复模块或同一 hook 的多个提供者会拒绝；继承覆盖由安装器先解析为最终选择。

安装宿主将确切代码准备到能力目录 `objects/<sha256>.cjs`，最后原子替换 `active-node.json`。`MEARL_CAPABILITY_DIR` 可显式指定目录，默认位于 `~/.mearl/capabilities`。Native Host 启动或收到 `node_capabilities_reload` 时加载选择；所有代码通过大小与摘要校验后才执行工厂，最后核对选择 revision，成功后一次替换活动函数表。失败保留旧表；移除选择会停用新调用，已开始的授权和请求保留其原处理器。

同一宿主更新时，代码摘要与有效配置均未变化的模块复用原工厂结果和处理器引用；仅变更其他模块不会让未变化的 Agent 被视为已更新。复用前仍校验本次选择的全部目标资源，失败不接纳新选择。

这是受信任的本机代码扩展，拥有宿主进程权限；SHA 校验只保证确切资源，`vm.Script` 的 CommonJS 包装不是安全沙箱。来源授权属于安装器。浏览器包的 MAIN world 执行合同独立，不要求 Native Host。

## Native Host 贡献

`@mearl/native-host/capabilities` 导出宿主服务类型和通用注册表。处理器覆盖端模拟配置、页面代码、请求协议、事件解析和浏览器入口。默认埋点解析由 `@mearl/plugin-tracking` 提供；已安装能力可覆盖 `tracking.request`。缺失必需 hook 时返回能力未安装。

请求协议的 `prepareRequest(resolved, cookies, stream?)` 接收 `readonly { name: string; value: string }[]`。宿主按完整 URL 与一方分区筛选 Cookie，并按路径长度降序排列；协议签名取所需名称的首个值，生成请求头时保留列表中的同名 Cookie。浏览器纯计算 hook 使用同一 JSON 列表，不在能力边界传递 `Map`。普通 HTTP 和签名请求的响应 Cookie 由宿主写回浏览器，业务能力无需实现存储同步。

App 目录使用清单声明的 ID 注册。端模拟配置声明 UA、版本、运行时代码和可用方法。完整配置必须提供确切的运行时代码。更新与回滚固定已接受版本；切换只能选择已安装且可用的端模拟配置，清除模拟无需安装能力。

## 页面代码生命周期

CDP 按摘要保存经过校验的页面代码。浏览器身份与目标 ID 持有当前及待导航版本的引用，宿主重启不释放它们；本地 Chrome 进程退出、目标关闭、权威目标清单确认关闭或显式清除模拟时释放。完成主文档导航后收敛旧版本，激活/回滚事务单独保护旧代码。远端浏览器暂时不可达时保留引用，恢复连接后按真实目标清单对账。

缓存总量限制为 64 MiB、256 个代码对象与 4096 个目标引用；跨进程修改复用记录锁。没有引用的对象按需淘汰，清除/对账时回收；活跃引用不会为新安装让位，超限会保留当前环境并报告失败。缓存完整性错误不会执行替代代码。

## 可选协议与 Agent

自定义请求命令由 CLI 插件提供，插件通过 `send_request` 发送 HTTP 请求。App 模拟使用 `request.protocol` 的宿主合同，核心不提供签名算法、默认 appKey 或网关。Browser 使用 `request.protocol.resolve/prepare/streamError`，一轮请求必须来自同一已接受模块。`request.inspect` 返回可选的请求名称、namespace、代理信息与环境注解；未安装时保留普通 HTTP 采集。`request.import` 可以转换导入响应，未安装时不添加协议包裹。

`set_app_profile.networkControl` 使用 `{id,value}` 选择已安装网络控件，`null` 清除。Node 的 `browser.control` 与 Browser 的 `browserControls` 提供同一声明，路由与跨域处理仍使用核心的通用引擎。页面代码的私有选项通过 `runtimeOptions` JSON 传递；核心不解释内容。

`agent.provider.<id>` 返回本地 Agent Provider 工厂。已卸载/更新的运行时不接受新会话；正在使用的会话保留原实现，关闭后释放。云协议使用 `cloud.connector.<scheme>` 和 `cloud.server.<mode>`；未安装时失败。Qoder 的实现、ACP SDK 和凭据处理都在可选包 `@mearl/plugin-qoder` 中。
