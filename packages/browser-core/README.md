# @mearl/browser-core

[简体中文](README.md) | [English](README.en.md)

浏览器与 Node 可共享的页面控制逻辑和协议：DOM/AX 快照、动作观察、输入、滚动、导航、请求序列化、捕获游标、设备模拟、通用设备外观、Cookie/域名权限和插件任务、页面、状态合同。模块没有浏览器扩展或本机进程的安装副作用。

核心不预置 App 身份；端模拟 ID 由宿主的已激活能力目录校验。端模拟配置 schema、显式选项、revision 和页面运行时绑定是数据合同，完整桥实现由独立能力包提供。

`@mearl/browser-core/appProfileRuntime` 的内置安装器只同步 UA、navigator.appVersion、navigator.platform 和触摸点，不安装 App 桥、业务全局变量、容器栈或授权处理。有 pageRuntime 绑定时，宿主必须先从已安装的能力包准备确切代码，再通过页面运行时派发器执行；不能调用基础安装器代替。资源准备和派发见 [能力包](../../docs/browser-bundles.md#页面运行时)。

默认代理授权地址为 localhost 与 127.0.0.1。其余站点由宿主取得权限后传入授权列表。核心内置 Aplus/RUM/ARMS 事件解析；扩展解析器通过能力包注册。

Agent 合同源在本包的 agentChat.ts、agentSkills.ts 和 pluginModels.ts；分别通过同名子路径导出，agent-runtime 使用这些合同，避免并行维护副本。可序列化的页面函数保持自包含，便于 Extension 与 CDP 共同使用。
