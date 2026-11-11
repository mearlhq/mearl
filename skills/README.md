# 探索 Mearl Skills

[简体中文](README.md) | [English](README.en.md)

点击卡片标题查看用法。安装时，把示例中 `--skill` 后的名称换成卡片底部的 Skill ID。

- [格式转换](format-converter/SKILL.md)

  在本地转换时间戳，以及对 Base64、图片和 URL 编解码。

  `format-converter`

- [记事本](notes-memory/SKILL.md)

  记笔记、添加图片附件，让 Agent 在不同会话间复用记忆。

  `notes-memory`

- [标签管理](browser-tab-manager/SKILL.md)

  汇总并分组标签页，清理 Mearl 控制的标签页。

  `browser-tab-manager`

- [图片压缩](tinypng-compress/SKILL.md)

  在工具箱粘贴或拖入 PNG、JPEG 或 WebP 图片，通过 TinyPNG 压缩后下载。

  `tinypng-compress`

- [设计稿对比](design-overlay/SKILL.md)

  在工具箱导入设计稿，与实际网页对齐，再截图对比当前视口的像素差异。

  `design-overlay`

- [沉浸式翻译](immersive-translate/SKILL.md)

  通过本机模型或浏览器翻译网页，边浏览边看双语对照。

  `immersive-translate`

## 安装 Skills

用 Mearl setup 安装 Skill 并注册插件，例如安装格式转换：

```bash
npx @mearl/setup plugin install https://github.com/mearlhq/mearl --github --skill format-converter --yes
```

工具箱和 Node 插件需要兼容的 Mearl 本地组件。图片压缩会把图片上传到 TinyPNG。安装来源可指定发行标签，以固定 Skill 版本。

## 查找其他 Skills

列出仓库中可安装的 Skills：

```bash
npx skills add mearlhq/mearl --list
```

微信小程序 Skill 从 [WeChat Profile](https://github.com/mearlhq/profile-wechat) 安装。
