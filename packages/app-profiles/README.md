# @mearl/app-profiles

[简体中文](README.md) | [English](README.en.md)

安装 App Profile 后即可模拟指定客户端的 UA、版本、桥对象、设置、scheme 路由、业务响应和容器行为。本包校验和编译 Profile，并应用设置覆盖。

## 开发 App Profile

用 [App Profile Creator](../../skills/mearl-profile-creator/SKILL.md) 根据已有配置、客户端行为样本或文档创建配置。在[资源清单](../../docs/browser-bundles.md)的 `contributions.appProfiles` 中登记 Profile，再在测试浏览器打开新标签页验证首屏和桥接行为。

## 编译 Profile

```ts
import { resolveAppProfileDefinition, type AppProfile } from '@mearl/app-profiles';

export function compileInstalledApp(definition: AppProfile) {
  return resolveAppProfileDefinition(definition, { os: 'android' });
}
```

宿主可以向 resolveAppProfile 或 resolveAppProfileDefinition 提供已校验的动态定义；编译器保留桥、设置及 pageRuntime 描述，不执行能力代码。定义与选项被复制并绑定 revision，插件升级不直接改写活动文档。

resolveAppProfileUpdate、rebuildAppProfileConfig 和 updateAppProfileSetting 保持显式选项、设备外观及方法覆盖的优先级。Preset 默认值由宿主传入，用户已有选择优先。安装 Profile 后，可按需应用其推荐配置。

Profile 声明在受控页面模拟的 App 行为。资源清单关联页面运行时和宿主处理器。详见[运行时合同](../../docs/capability-model.md)。

同一份资源清单中的 Profile 可以共用 `settingsGroup`，以便在设备外壳的底部手势条配置页切换。每种环境也可通过独立的 Profile ID 选用。

## Agent 能力发现

`mearl get_capabilities`、SDK `getCapabilities()`、MCP `browser_get_capabilities` 查询当前目标浏览器，沿用 browser/session 路由。默认返回动作、设备预设和 App 摘要；传 `{ "app": "package/app" }` 按需展开桥方法、可调设置和默认版本。目录为 partial 或 unsupported 时不能据此断言 App 未安装，available=false 的条目不可启用。方法按声明组分类：responses 为固定回包，noop 为成功空实现，behaviors 为模拟行为；这些都不证明真实业务操作可用。

每个 Profile 可声明可选的 `usage`，浏览器包与 Node/Skill 插件共用同一格式：

```json
{
  "usage": {
    "description": "WebView 与桥接行为模拟",
    "limitations": ["真实设备授权需要对应的宿主能力"],
    "skills": ["example-skill"],
    "documentation": [{ "title": "使用说明", "url": "https://example.com/docs" }]
  }
}
```

usage 最大 4 KiB；description 最多 512 字符，limitations/skills/documentation 各最多 8 项。文档只接受无凭据的 HTTPS URL。查询只读取已安装元数据，不执行插件刷新、不打开文档、不安装或加载 Skill，也不输出桥接脚本、全局变量值及固定回包内容。Skill 名称是作者提供的入口，不代表该 Skill 已安装；通用调用继续使用 set_app_profile/tab_open，特殊流程才读取配套说明。
