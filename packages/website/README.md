# 产品官网

[简体中文](README.md) | [English](README.en.md)

官网包含产品概览，以及安装、首个 Agent 任务、浏览器连接、网页自动化、网页调试、带登录态的请求、设备与 App 模拟、EgoLite、Skill 插件和 bb-browser 适配器的独立指南。默认使用简体中文。语言切换链接指向对应的英文页面，英文首页为 `en.html`，其余英文页面位于 `en/`。两种语言默认跟随浏览器配色，也支持手动切换。

扩展首次安装时会打开 `packages/preset/installation-site.json` 中 URL 下的 `installed.html`，默认为 `https://mearlhq.github.io/mearl/`。欢迎页包含工具栏、DevTools 和 Agent 配置说明。已配置的安装引导连接检测在欢迎页运行。

```sh
pnpm dev:website
pnpm build:website
```

静态产物为 `packages/website/dist/`。Astro 使用配置站点 URL 的路径作为 base。默认 `installation.json` 为 `{"schemaVersion":1}`；没有引导配置时，欢迎页显示本地说明。

构建时从 GitHub Releases 解析离线 ZIP。优先使用最新正式版的 ZIP，没有正式版 ZIP 时选用最新已发布的预发布 ZIP。无法获取离线 ZIP 时，安装页仍提供 Chrome 应用商店入口。私有仓库的本地预览可设置 `GH_TOKEN`，或通过 `gh auth login` 登录。

参考页面在构建时直接编译 `src/lib/reference-docs.mjs` 列出的仓库 Markdown。更新站内内容时，直接修改中英文原稿。编译会将已纳入站点的文档链接指向对应页面，其余仓库相对链接指向 GitHub 源文件。

内容先交代读者能得到什么，再归纳支撑结论的能力或关键选择，最后展开示例和参考细节。中英文介绍页和指南都遵循这个顺序。

## 部署配置

构建网站时，将 `MEARL_INSTALLATION_CONFIG_FILE` 设为 JSON 文件的绝对路径：

```json
{
  "schemaVersion": 1,
  "guide": {
    "url": "https://guide.example.test/installed.html",
    "registry": "https://registry.example.test/"
  }
}
```

引导和 npm registry 必须使用与公共网站不同的 HTTPS origin。registry 为不含查询参数和片段的目录 URL，无需与引导同源。只有 npm ping 成功后才重定向到配置的引导 URL；URL 参数和 ping 响应不能提供目标地址、命令或插件来源。

GitHub Actions 的 `Deploy installation website` 工作流**仅手动触发**。它读取可选仓库密钥 `MEARL_INSTALLATION_CONFIG`，在构建时校验，再将配置后的产物上传至 GitHub Pages。未设置密钥时使用默认配置。显式运行前需将 Pages 设为使用 GitHub Actions。普通 push 或 pull request 不发布网站。部署配置会在发布的 `installation.json` 中公开，不得包含凭据或机密数据。

## 环境检测

页面请求 registry 的标准 `-/ping` 端点，要求成功返回含 `pong: true` 的 JSON。registry 必须通过 CORS 允许配置的网站 origin。无需专用引导探测页或 frame 协议。这与 setup 通过 `npm ping` 检测环境的方式对应；下载包使用的 npm registry 仍由安装流程单独管理。

请求不带凭据、拒绝重定向、禁用缓存并携带新的查询值；响应最多 4 KiB。登录 HTML、兜底 JSON、CORS 失败、重定向和请求失败均保留公共引导。ping 成功只说明网络可达，不代表身份或授权；重定向目标始终来自配置的引导 URL。

支持时，欢迎页自动检测归类为公共 IP 空间的 registry，或在已取得 Local Network Access 授权时自动检测。其他地址需点击**检测引导连接**后再申请权限。网络超时为五秒；待决定的权限申请单独限制为 120 秒且可取消。重试创建新请求，导航释放当前尝试。直接引导链接与本地说明始终可用。

网站是安装入口。已安装的能力包必须在网站关闭或离线时继续运行。网页到扩展的安装桥是独立集成步骤。
