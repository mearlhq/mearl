# 通用 Skills

[简体中文](README.md) | [English](README.en.md)

每个一级目录是一份可独立发现的 Skill；脚本和工具箱资源跟随 Skill 分发，测试统一位于 `__tests__/`，不放入安装目录。

| Skill | 插件名 | 功能 |
| --- | --- | --- |
| [mearl](mearl/SKILL.md) | — | 浏览器控制入口及按需加载的操作参考 |
| [format-converter](format-converter/SKILL.md) | convert | 本地时间戳、Base64、图片与 URL 编解码 |
| [notes-memory](notes-memory/SKILL.md) | notes | 笔记、跨会话记忆和图片附件 |
| [browser-tab-manager](browser-tab-manager/SKILL.md) | tabs | 标签摘要、智能分组和受控标签清理 |
| [tinypng-compress](tinypng-compress/SKILL.md) | tinypng | TinyPNG 图片压缩及工具箱 |
| [design-overlay](design-overlay/SKILL.md) | overlay | 设计稿叠加、截图和像素差异对比 |
| [immersive-translate](immersive-translate/SKILL.md) | translate | 通过本机模型或浏览器提供持续双语阅读 |
| [mearl-bbrowser](mearl-bbrowser/SKILL.md) | bbrowser | 执行社区或自定义 bb-browser 站点适配器 |
| [mearl-provider-creator](mearl-provider-creator/SKILL.md) | — | 开发和验证外部浏览器、设备 Provider |
| [mearl-skill-creator](mearl-skill-creator/SKILL.md) | — | 探索网站并生成或改造 Skill、CLI 与工具箱 GUI |

通过标准 Skills 工具安装，例如：

```bash
npx skills add https://github.com/mearlhq/mearl --skill format-converter --global
```

setup 将标准 Skills 安装和插件注册合并为一次操作：

```bash
npx @mearl/setup plugin install https://github.com/mearlhq/mearl --github --skill format-converter --yes
```

标准 Skills 安装与 Mearl 插件注册是两个动作，不能假设前者会执行 frontmatter 中的 install 元数据。setup 的 plugin install 会解析 Skills 本次安装结果，再注册其中的插件；也可用 `setup plugin "$SKILL_DIR"` 注册本地入口。整套 preset 可通过 `npx @mearl/setup preset apply <source>` 安装，Skills 管理工具由 preset 配置并可继承覆盖。

这些资源保留现有工具箱合同，需对应的 Mearl 宿主；Node 插件和工具箱服务需要本地组件。浏览器能力包可在扩展内独立加载。TinyPNG 会按原有功能上传图片到外部压缩服务。

安装来源可指定发行标签，以固定 Skill 版本。本地脚本插件使用 `setup plugin <实际 Skill 目录>` 注册；`mearl-skill-creator` 和 `mearl-provider-creator` 是指引型 Skill，通过标准 Skills 工具安装。EgoLite 由独立 `@mearl/provider-ego` 接入，使用通用 Mearl 指引。

## 通过 skills.sh 分发

将完整 Skill 目录发布到公开的 `mearlhq/mearl` GitHub 仓库，包含脚本和生成的资源。标准 `skills/<name>/SKILL.md` 目录可直接被发现，不需要为 Skill 单独创建注册清单或 npm 包。

先检查仓库发现结果，再安装主 Skill：

```bash
npx skills add mearlhq/mearl --list
npx skills add mearlhq/mearl --skill mearl --global
```

[skills.sh FAQ](https://skills.sh/docs/faq) 说明了通过安装遥测自动收录的机制。收录是异步过程，应检查平台条目，不能将安装成功当作已经上榜。公开收录要求来源仓库可被匿名访问；托管 Skills Pack 是可选方案。

Mearl 插件型 Skill 使用合并安装入口，一次完成依赖准备和注册：

```bash
npx @mearl/setup plugin install mearlhq/mearl --github --skill browser-tab-manager --yes
```

依赖新宿主或扩展能力的 Skill，应在对应 Mearl 版本发布后再对外推广。见[发布说明](../docs/releases.md)。

微信小程序 Skill 从 [WeChat Profile](https://github.com/mearlhq/wechat-profile) 安装。
