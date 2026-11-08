# @mearl/agent-runtime

[简体中文](README.md) | [English](README.en.md)

本机 Codex app-server、通用 Agent Provider 合同与受管理的一次性模型执行适配。Qoder ACP 由可选的 [`@mearl/plugin-qoder`](../plugin-qoder/README.md) 提供。

此包提供可独立使用的本地 Agent 适配、模型调用和会话能力，依赖 daemon-core、browser-core 的纯协议合同和公开 Provider SDK，不依赖浏览器扩展、安装器或浏览器执行宿主。

模型、会话和 Skill 类型合同的源文件由 browser-core 维护，通过纯协议子路径引用；本包继续公开这些类型。浏览器界面和其他调用方应复用公开导出的合同，不维护第二份类型源。

`runCodexModel` 每次拥有独立 Provider 进程，只提供 capabilities 中声明的只读 Agent 模式；宿主负责结构化结果校验、任务持久化和进程树终止。纯生成模式需 Provider 提供可靠的无工具执行能力后才能加入。
