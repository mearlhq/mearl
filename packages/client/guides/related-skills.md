# 专用 Skill 使用与安装

站点或业务对象与任务意图都匹配时，优先使用已安装的专用 Skill。通用网页操作继续使用 Mearl；不要仅因关键词相同就改用其他能力。专用站点的路由说明由对应 Skill 提供。

| 意图 | Skill |
| --- | --- |
| 运行或验证本地微信小程序，包括 uni-app / Taro 的微信产物 | wechat-miniprogram |
| 时间戳、Base64、图片编码、URL 编解码 | format-converter |
| 记录或检索笔记与跨会话记忆 | notes-memory |
| 管理已有浏览器标签分组、关闭受控标签页 | browser-tab-manager |
| 用户明确要求使用 TinyPNG 压缩图片 | tinypng-compress |
| 把设计稿叠加到网页并做像素差异对比 | design-overlay |
| 为网页提供持续双语阅读 | immersive-translate |
| 运行 bb-browser 站点适配器 | mearl-bbrowser |
| 开发或审查外部浏览器、真机 Provider | mearl-provider-creator |
| 把网站操作沉淀为可复用 Skill、CLI 或工具箱 GUI | mearl-skill-creator |

有脚本入口的 Skill 可安装并自动注册插件：

```bash
{{setup}} plugin install https://github.com/mearlhq/mearl --github --skill <skill-name> --yes
```

已可用的专用 Skill 按其说明执行。用户明确要求使用表中某项专用能力、且执行任务需要该插件时，可在缺失时按需安装并继续。普通网页操作使用通用流程。

## 运行本地微信小程序

任务要运行小程序工程或已编译的微信产物时，先用 `mearl --help` 检查已注册插件中是否有 `wxa`。缺失时，从已包含此 Skill 且当前可访问的官方来源补装：

```bash
{{setup}} plugin install https://github.com/mearlhq/wechat-profile --github --skill wechat-miniprogram --yes
```

官方来源暂不可用且本机已有包含此 Skill 的源码时，可直接注册：

```bash
{{setup}} plugin "/path/to/wechat-profile/skills/wechat-miniprogram"
```

两种方式都会准备运行依赖并注册 `wxa`。读取对应目录中的 `wechat-miniprogram` Skill，查看 `mearl wxa run --help` 后用 `mearl wxa run <项目路径>` 编译并打开预览。框架项目先构建微信产物。看完可以直接关闭预览标签页。若安装失败，报告具体阻塞。用户只要求普通微信 H5 / WebView 模拟时，查询目标浏览器是否支持微信端模拟。

## 开发与协作指引

EgoLite 使用独立 `@mearl/provider-ego`，具体流程见工具协作（`mearl guide cooperation`），不需要额外协作 Skill。

`mearl-skill-creator` 与 `mearl-provider-creator` 是指引型 Skill，没有可注册的脚本入口；直接用标准 Skills 工具安装，不运行 `setup plugin`：

```bash
npx skills add https://github.com/mearlhq/mearl --skill mearl-skill-creator --global
```

已有源码时也可将 Git 来源替换为实际 Skill 目录。安装前核对所选分支或标签确实包含目标 Skill；普通任务不主动安装开发指引。
