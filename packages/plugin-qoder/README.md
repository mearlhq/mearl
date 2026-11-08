# @mearl/plugin-qoder

[简体中文](README.md) | [English](README.en.md)

可选的 Qoder 接入：本地 CLI/ACP Agent 与 Cloud Session API/SSE 连接器。核心不依赖本包，也不默认注册 Qoder、读取 PAT 或启动 CLI。本包作为独立 npm 包分发。

构建后的 `dist/capability/` 包含自包含 Node 模块、摘要清单与 `preset.json`。使用现有安装流程：

```bash
npx @mearl/setup preset apply ./node_modules/@mearl/plugin-qoder/dist/capability/preset.json
```

若已有其他能力，请将这里的 `qoder` 包声明合并进现有 preset；`preset apply` 选择的是整套预设。仅 `npm install` 不会自动获得权限或激活能力。包资源同样可通过受信任 HTTPS 地址分发。

使用本地 Agent 时，可在 Agent 对话中选择 Qoder 并安装缺失组件。当前预设提供的 Qoder 能力优先，云端配对通过预设启用。

本地 Agent 在安装后通过 `agent.provider.qoder` 被发现。卸载后禁止新会话；已接受会话仍可继续和关闭。更新期间有会话时，关闭会话后才启用新运行时。

Cloud 配对在 Agent 机器生成一次性地址：

```bash
npx @mearl/plugin-qoder pair
```

按输出在浏览器机器启动 `mearl-cloud-connector`，随后立即调用 Qoder 的 `mearl` 自定义工具完成配对。浏览器机器须先安装此能力，提供 `QODER_PERSONAL_ACCESS_TOKEN`；凭据解析顺序为进程环境、`MEARL_ENV_FILE`、`~/.mearl/.env`、macOS Keychain `ai.mearl.qoder.pat`。凭据不写入配对 URL、注册记录或日志。

也可在已安装能力后使用 `npx @mearl/setup --cloud-mode qoder --yes`，复用 cloud-server 的管理命令。`cloud.connector.qoder` 与 `cloud.server.qoder` 都由本包提供；未安装时明确报告能力缺失。ACP 权限事件使用标准 `acp/requestPermission` 合同。
