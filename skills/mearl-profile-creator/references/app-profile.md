# App Profile 开发参考

以目标版本的 [App Profile 编译器](https://github.com/mearlhq/mearl/blob/main/packages/app-profiles/README.md)、[浏览器能力包](https://github.com/mearlhq/mearl/blob/main/docs/browser-bundles.md)和 [Preset 激活](https://github.com/mearlhq/mearl/blob/main/docs/browser-presets.md)为准。微信项目演示了多份 WebView 定义共用页面运行时，以及从真实字节生成清单的做法。 [微信端模拟示例](https://github.com/mearlhq/profile-wechat/blob/main/scripts/build-profile.mjs)

## 最小 UA 示例

以下定义存为 `profiles/webview.json`。示例用 `uaTemplate` 在两种移动 UA 中带上 `ExampleReader/1.0.0`。为真实客户端开发时，按对应 iOS 和 Android 版本的样本填写完整模板。

```json
{
  "name": "example-reader/webview",
  "label": "Example Reader WebView",
  "appName": "example-reader",
  "defaultAppVersion": "1.0.0",
  "uaTemplate": {
    "ios": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 ExampleReader/{v}",
    "android": "Mozilla/5.0 (Linux; Android 17; {deviceModel}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/152.0.0.0 Mobile Safari/537.36 ExampleReader/{v}"
  },
  "uaTokens": [],
  "globals": {},
  "bridges": [],
  "activeEvents": [],
  "actions": {
    "open": [],
    "close": [],
    "title": [],
    "systemInfo": [],
    "protocol": [],
    "noop": []
  },
  "schemes": []
}
```

在包根目录运行以下示例生成 `bundle.json`。已有项目可把生成逻辑放入其构建流程，对每个贡献资源计算摘要和字节数。

```js
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const path = 'profiles/webview.json';
const bytes = await readFile(path);
const manifest = {
  schemaVersion: 1,
  id: 'example-reader',
  version: '1.0.0',
  requires: { mearlApi: '^1' },
  resources: {
    [path]: {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
    },
  },
  contributions: { appProfiles: [path] },
};
await writeFile('bundle.json', JSON.stringify(manifest, null, 2) + '\n');
```

用 `@mearl/browser-core` 的 `validateAppProfileDefinition` 校验定义，用 `@mearl/app-profiles` 的 `resolveAppProfileDefinition` 检查目标系统上的 UA 等编译结果。用 `@mearl/preset/bundles` 的 `prepareBundle` 校验资源及清单，可用读取本地生成文件的 loader 在分发前运行。最终由扩展校验贡献的命名空间和运行时引用。

## 桥方法和页面运行时

- `bridges` 声明桥对象，`actions.responses` 声明固定 JSON 回包，`actions.noop` 声明成功空实现，`actions.behaviors` 选择受支持的模拟行为。能力目录可以展示方法声明。页面上的桥对象、回调和容器交互由匹配的页面运行时实现，核心默认运行时提供 UA 等基础标识。
- 自带运行时的包在 `contributions.pageRuntimes` 中将本地名称映射到 `resources` 中的 CommonJS 文件。定义中的 `pageRuntime` 绑定 `{ id: "<bundle-id>/<runtime-name>", sha256 }`，摘要取同一份运行时资源。运行时无外部依赖，导出可重复调用的 `install(config)`，在页面 MAIN world 运行。
- 以页面真实依赖的调用约定验证桥对象、参数、回调时序、事件及错误行为。使用固定回包模拟登录、支付或授权结果时，在 `usage.limitations` 明确说明。需要宿主侧能力时核对相应宿主契约。

## 安装与验收

独立安装支持公开 GitHub 仓库的 `owner/repo[@ref]` 或完整 HTTPS 清单地址。选定有 Mearl 扩展的测试浏览器，按需在扩展中完成来源授权。

```bash
npx @mearl/setup profile install 'https://example.com/example-reader/bundle.json' --browser '<browser-id>'
mearl get_capabilities --browser '<browser-id>' --payload '{"app":"example-reader/webview"}'
mearl tab_open --browser '<browser-id>' --payload '{"url":"https://example.com","reuse":"never","appProfile":"example-reader/webview","os":"android"}'
```

替换示例来源、浏览器和测试 URL，启用时使用目标浏览器目录中返回的 ID。独立安装通常使用定义的完整名称。可选的 `defaultAppId` 在无同名 Preset 绑定、且独立包中的别名唯一时生效。由 Preset 管理时，将包加入 `packages` 并指定 `targets: ["browser"]`，再以 `appProfiles` 将用户可见 App ID 映射到定义全名。

在受控测试页检查首个请求的 `User-Agent` 和首屏脚本读取的 `navigator.userAgent`。需要时分别测试纯 App 模拟与带设备外壳的模式，覆盖相关桥回调、WebView 导航与重载。用 `set_app_profile` 的 `enabled: false` 验证清除后页面恢复，使用了设备联动时同时传 `emulation: {}` 清理设备配置。对于已有包的更新，分别检查新开文档与已开启文档的行为。
