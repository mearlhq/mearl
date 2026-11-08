# @mearl/plugin-tracking

[简体中文](README.md) | [English](README.en.md)

Aplus、RUM、ARMS 的纯解析能力。通用请求采集、事件缓冲与查询仍在核心；协议地址识别、字段归一化和 SPM 解析在本包中。默认发行使用本包的同一工厂，已安装的 `tracking.request` / `tracking.decode` / `tracking.spm` 可以覆盖它；运行中的批次保留已接受实现。

构建后 `dist/capability/` 包含 Browser / Node 自包含模块、摘要清单及示例 preset。可将 bundle 地址加入现有 preset 的 `packages`，通过 `@mearl/setup preset apply` 安装；没有另一个插件注册或权限系统。本包仅解析已捕获数据，不发送埋点或上传用户数据。
