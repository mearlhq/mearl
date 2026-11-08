# @mearl/app-profiles

[简体中文](README.md) | [English](README.en.md)

核心不内置具体客户端的端模拟配置。App UA、版本、桥对象、设置、scheme 路由、业务响应和容器实现均由安装的能力包提供；本包负责声明式端模拟配置校验、编译与设置覆盖。

```ts
import { resolveAppProfileDefinition, type AppProfile } from '@mearl/app-profiles';

export function compileInstalledApp(definition: AppProfile) {
  return resolveAppProfileDefinition(definition, { os: 'android' });
}
```

宿主可以向 resolveAppProfile 或 resolveAppProfileDefinition 提供已校验的动态定义；编译器保留桥、设置及 pageRuntime 描述，不执行能力代码。定义与选项被复制并绑定 revision，插件升级不直接改写活动文档。

resolveAppProfileUpdate、rebuildAppProfileConfig 和 updateAppProfileSetting 保持显式选项、设备外观及方法覆盖的优先级。preset 默认值由宿主传入，用户已有选择继续优先；能力包安装成功不等于默认配置已经应用。

App 行为由能力包声明并安装到受控页面；页面代码和宿主处理器通过 [能力包模型](../../docs/capability-model.md) 关联。

同一个浏览器能力包里的端模拟配置可以共用 `settingsGroup`，以便在设备外壳的底部手势条配置页切换。每种环境也可通过独立的配置 ID 选用。

## Agent 能力发现

`mearl get_capabilities`、SDK `getCapabilities()`、MCP `browser_get_capabilities` 查询当前目标浏览器，沿用 browser/session 路由。默认返回动作、设备预设和 App 摘要；传 `{ "app": "package/app" }` 按需展开桥方法、可调设置和默认版本。目录为 partial 或 unsupported 时不能据此断言 App 未安装，available=false 的条目不可启用。方法按声明组分类：responses 为固定回包，noop 为成功空实现，behaviors 为模拟行为；这些都不证明真实业务操作可用。

能力包可在每份 App 定义中声明可选 `usage`，浏览器包与 Node/Skill 插件共用同一格式：

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
