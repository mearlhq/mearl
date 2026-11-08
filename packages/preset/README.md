# @mearl/preset

[简体中文](README.md) | [English](README.en.md)

用 Preset 将一组配置好的 Mearl 能力、Skills 和 Providers 一起分发。本包负责解析清单，并为浏览器与 Node 宿主准备资源。

3.x 的声明、配置、能力目录及对象存储设计见 [能力包模型](../../docs/capability-model.md)。包支持的位置从贡献推导，Preset 的可选 `targets` 仅选择启用子集；操作和登录定义归包，配置覆盖归 Preset 与用户。

浏览器包的准备与本地存储见 [能力包](../../docs/browser-bundles.md)，整套原子激活与 App 实现映射见 [浏览器 Preset](../../docs/browser-presets.md)。这两类能力通过 `@mearl/preset/bundles` 导出。

浏览器和 Node 共用一次继承解析及资源下载，见 [整套资源准备](../../docs/preset-preparation.md)。`preparePreset` 返回完整确切图与兼容的浏览器投影；Node 模块选择直接复用同批字节，准备过程不执行代码或安装外部环境。

主入口在浏览器和 Node 中共享 preset 清单校验与继承解析，没有文件系统、网络、凭据或浏览器权限副作用；清单加载由调用方提供。可选子入口 `@mearl/preset/bundles` 提供资源校验、受限下载和显式调用的浏览器本地存储，见 [能力包说明](../../docs/browser-bundles.md)。

```ts
import { resolvePreset, mergePresetDefaults } from '@mearl/preset';

const preset = await resolvePreset('https://example.com/presets/team.json', {
  mearlApiVersion: '1.0.0',
  async load(source) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Preset load failed: ${response.status}`);
    return response.json();
  },
});

const effectiveSettings = mergePresetDefaults(preset.defaults, userSettings);
```

加载器负责检查来源、响应大小、重定向、认证和取消请求；上例仅演示合同。浏览器加载器应根据产品来源策略限制 URL，解析器不会把 HTTP(S)/file 形式的 URL 自动视为可信。

Node 模块快照与宿主加载合同见 [Node 能力包](../../docs/node-capabilities.md)。

## 清单

```json
{
  "schemaVersion": 1,
  "id": "team",
  "version": "1.0.0",
  "extends": { "source": "../base/preset.json", "version": "^1" },
  "requires": { "mearlApi": "^1" },
  "packages": {
    "capture": { "source": "./capture/package.json", "targets": ["browser"] },
    "unused": { "enabled": false }
  },
  "skills": {},
  "providers": {},
  "defaults": { "simulation": { "app": "sample" } },
  "permissions": { "origins": ["https://*.example.com/*"] }
}
```

- 单继承，最多 32 层；拒绝循环和不满足的父版本/API 要求。`version` 是确切 semver，组件 `version` 是版本要求，具体安装版本留给安装器解析。
- packages、skills、providers 按 ID 合并，子级字段覆盖同 ID 声明；数组整体替换。启用项最终必须存在 source，`enabled:false` 保留停用声明。
- 组件 `dependsOn` 引用同类组件 ID；检查最终继承图中的缺失、停用和循环依赖。它不表示 runtime 兼容或安装已完成。
- source 相对声明它的清单解析；子级只修改版本时不会改变继承 source 的基准 URL。
- Skill 可声明 `migrateFrom` 旧来源列表（最多 16 项），相对地址按声明清单解析；子级整体覆盖，空数组清除。安装器仅在来源收据匹配旧来源、Skill 身份有效且所有关联插件均由 setup 托管时迁移。手动注册、共享的手动别名或其他来源保留并报告冲突；来源匹配仍严格检查 ref。
- defaults 递归合并对象，数组、标量和 null 替换；用户覆盖单独保存，在解析结果上应用。
- 权限汇总去重，结果仅表示需求；必须由浏览器安装器另行取得实际授权。
- appProfiles 是 App ID 到实现标识的覆盖映射。具体端模拟配置是否存在、所需包是否可执行，由后续能力目录校验，解析器不宣称已验证模拟效果。
- 结果保留父级到子级的确切版本链和各组件最近声明来源，加载失败不会生成部分成功的结果。
- 拒绝未知字段、非 JSON 配置和原型污染键。清单总量不超过 256 Ki UTF-16 code units，defaults 最大嵌套 32 层。

本包负责通用清单解析、校验和资源图，不执行安装或展示 UI。完整安装器、preset 锁文件持久化、权限、注册与激活由浏览器宿主及 setup 提供，见 [安装宿主](../../docs/preset-installation.md)；能力包本地存储负责已校验快照的事务替换。

Skill manager 的可选 `readSources(scope, cwd)` 返回该管理器核验过的来源收据，结构与 setup 的 `TrackedSkillSource` 一致。CLI 与 Native 安装状态共用该读取接口；管理器负责持久化、校验和失效自身补充记录，公共宿主继续核对来源、ref、清单身份与托管归属。未提供时读取标准 Skills 锁文件。

## 工具目录

Preset 可通过 `defaults.extension.toolCatalogs` 注册额外的可安装工具目录：

```json
{
  "defaults": {
    "extension": {
      "toolCatalogs": {
        "team": {
          "url": "https://tools.example.com/toolbox.json",
          "label": "Team"
        }
      }
    }
  }
}
```

目录使用绝对 HTTPS URL（本机开发允许 loopback HTTP），最多 16 个。使用稳定的目录 ID，子 preset 可只覆盖 `url` 或 `label`，或设置 `enabled: false` 禁用父级目录。官方目录始终保留且优先，不能使用保留 ID `official`。需要跨域访问时在 preset 的 `permissions.origins` 声明相应域名，由现有授权流程取得权限。

目录 JSON 与官方目录使用同一结构，最多 256 项、256 KiB：

```json
{
  "tools": [{
    "id": "plugin:team-tool",
    "plugin": "team-tool",
    "repository": "example/skills",
    "skill": "team-tool",
    "title": "Team tool",
    "description": "A tool for the team",
    "icon": "wrench"
  }]
}
```

`repository` 也支持 HTTPS/SSH Git 来源和固定 ref（例如 `git@code.example.com:team/skills.git#release/v3`），安装时原样交给 preset 选择的 Skills 管理器。清单不接受 shell 参数、凭据或本地文件路径，也不执行其中的代码；列出工具不会自动安装。

各来源并发读取、独立缓存，重试时刷新当前目录；失败时保留该来源已有缓存，其他来源仍可使用。相同插件 ID 与安装来源去重；同 ID 指向不同仓库或 Skill 时保留优先目录并提示冲突。较低优先目录的安装按钮会等待前面的目录完成检查，避免加载顺序改变安装目标。更换或禁用目录后，旧来源和迟到响应不会留在当前列表。
