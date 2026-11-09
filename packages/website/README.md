# 产品官网

[简体中文](README.md) | [English](README.en.md)

官网包含产品概览，以及安装、首个 Agent 任务、浏览器连接、网页自动化、网页调试、带登录态的请求、设备与 App 模拟、EgoLite、Skill 插件和 bb-browser 适配器的独立指南。默认使用简体中文。语言切换链接指向对应的英文页面，英文首页为 `en.html`，其余英文页面位于 `en/`。两种语言默认跟随浏览器配色，也支持手动切换。

标准扩展首次安装时会打开 `packages/preset/installation-site.json` 中 URL 下的 `installed.html`，默认为 `https://mearlhq.github.io/mearl/`。欢迎页包含工具栏、DevTools 和 Agent 配置说明。

```sh
pnpm dev:website
pnpm build:website
```

静态产物为 `packages/website/dist/`。Astro 使用配置站点 URL 的路径作为 base。默认 `installation.json` 为 `{"schemaVersion":1}`；没有引导配置时，欢迎页显示本地说明。

构建时从 GitHub Releases 解析离线 ZIP。优先使用最新正式版的 ZIP，没有正式版 ZIP 时选用最新已发布的预发布 ZIP。无法获取离线 ZIP 时，安装页仍提供 Chrome 应用商店入口。私有仓库的本地预览可设置 `GH_TOKEN`，或通过 `gh auth login` 登录。

参考页面在构建时直接编译 `src/lib/reference-docs.mjs` 列出的仓库 Markdown。更新站内内容时，直接修改中英文原稿。编译会将已纳入站点的文档链接指向对应页面，其余仓库相对链接指向 GitHub 源文件。

内容先交代读者能得到什么，再归纳支撑结论的能力或关键选择，最后展开示例和参考细节。中英文介绍页和指南都遵循这个顺序。

## 部署配置

构建网站时，`MEARL_INSTALLATION_CONFIG` 接收安装目录的 JSON 内容。可以从本地文件读取：

```sh
MEARL_INSTALLATION_CONFIG="$(cat /path/to/installation.json)" pnpm build:website
```

安装目录示例：

```json
{
  "schemaVersion": 1,
  "guide": {
    "url": "https://guide.example.test/installed.html"
  }
}
```

引导 URL 必须使用与公网官网不同的 HTTPS origin。探测到可访问时，公网官网在导航栏下方显示横幅，用户可点击进入内网官网。「关闭」在当前标签页会话内隐藏横幅，「不再提示」会记住此浏览器中的选择。

将 Pages 的部署来源设为 GitHub Actions。`Deploy installation website` 工作流在 `main` 收到涉及官网代码、构建依赖、站内参考文档或部署配置的推送时自动运行。其他推送跳过官网工作流。更新仓库密钥后也可以手动运行。

工作流读取可选仓库密钥 `MEARL_INSTALLATION_CONFIG`，在构建时校验，再将配置后的产物上传至 GitHub Pages。未设置密钥时使用默认配置。部署配置会在发布的 `installation.json` 中公开，不得包含凭据或机密数据。

## 环境检测

官网通过跨域 `HEAD` 探测引导地址。请求使用 `no-cors` 模式，跟随重定向，省略凭据，禁用缓存并携带新的查询值。浏览器返回不透明响应时，官网将其视为网络可达。HTTP 状态和响应内容对官网不可见。连接失败、五秒内未收到最终响应或无法静默探测时，横幅保持隐藏。

公网官网在已取得 Local Network Access 授权时自动检测引导地址。未获授权时，支持权限策略的浏览器在禁用本地网络权限的 iframe 内检测，兼容经代理访问的 HTTPS 引导。其他支持地址空间限制的浏览器仅自动探测公共 IP 空间。离开页面时取消探测。

网站是安装入口。已安装的能力包必须在网站关闭或离线时继续运行。网页到扩展的安装桥是独立集成步骤。

## 定制扩展欢迎页

构建团队扩展时，通过一个 HTTPS 官网目录 URL 指定欢迎页，支持子路径。

```sh
MEARL_WEBSITE_URL=https://team.example.com/mearl/ pnpm --filter @mearl/extension... build
```

首次安装时，扩展向该目录下的 `installed.html` 发送不带凭据的 `HEAD` 请求。五秒内收到成功响应时打开团队欢迎页，否则打开公网欢迎页。定制构建声明团队官网的主机权限，用于检测响应。用户可以在官网手动启用 Preset，或运行 setup 命令。
