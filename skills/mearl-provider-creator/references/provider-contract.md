# Mearl Browser Provider 契约

实现 Provider 或评审状态、控制、生命周期和安全边界时读取。完整 TypeScript 类型以目标项目实际解析到的 `@mearl/provider` 版本为准；通过依赖清单和模块解析定位，不假定其源码或文档位于固定仓库目录。

## 包元数据

Provider 包在 `package.json` 的 `mearl.provider` 中声明 `providerId`、名称、协议版本、构建入口和 `browserType`。manifest 和 runtime descriptor 的 ID、名称、版本与协议必须一致；`entry` 指向发布包内真实存在的产物。当前 Socket 协议为 3，SDK 请求携带 `protocolVersion`；管理消息按 `browser_providers`（`configure/launch_form`）和 `browser_instances`（`start/detach/sync_cookies`）分组。SDK 将它们映射到对应 TypeScript 方法；会话仍由 Mearl 控制进程管理。协议升级时，打包 SDK 的 Provider 需要重新构建并更新安装注册，随后重启进程；不保留旧消息别名。最小结构如下，省略的 scripts、files 和 dependencies 按实际工具链补充：

```json
{
  "name": "@example/mearl-provider-device",
  "version": "1.0.0",
  "type": "module",
  "mearl": {
    "provider": {
      "providerId": "example-device",
      "name": "Example device provider",
      "protocolVersion": 3,
      "entry": "./dist/runtime.js",
      "browserType": {
        "name": "Device",
        "help": ["Pair a device, then use its browserId."],
        "inputSchema": {
          "type": "object",
          "properties": {
            "code": { "type": "string", "title": "Pairing code" }
          }
        }
      }
    }
  }
}
```

`browserType.inputSchema` 描述 `browser_manage.providerOptions`。Provider 自有配置放在 `browserType.configuration.inputSchema`。包含凭据的字段标记 `secret`，敏感值只用于当次调用，不返回到实例列表。

runtime 应把 manifest 当作 Provider 元数据的单一事实源。可在一个轻量模块中读取与校验 `package.json#mearl.provider`，再用同一对象填充 descriptor 和 `browserType`；版本也从 package 读取，避免发布时只更新其中一份。构建后的 `entry` 必须能从安装目录独立启动：可以把 `@mearl/provider` runtime 打进单文件产物，也可以声明真实的运行时依赖，但不能只依赖开发工作区的模块提升或源码路径。平台 SDK 可按其分发方式保留为外部依赖。

依赖 Python CLI、系统程序或登录工具时，不在 runtime import、Provider help 或插件注册阶段安装。由明确的安装命令完成幂等 setup，并提供不修改环境的 doctor；Provider 找不到依赖时返回 setup 命令和可选的显式路径覆盖方式。

## 状态与控制

| `status` | 语义 | 常规 action |
| --- | --- | --- |
| `connected` | 实例运行且控制通道可用 | 按 capability 允许 |
| `pairing` | 实例已创建，等待扫码或外部配对 | 不可用 |
| `running_disconnected` | 外部资源在运行，控制链路未建立或已中断 | 不可用 |
| `stopped` | 持久化资源保留但未运行 | 不可用 |

`control` 与状态独立：

- `provider`：Provider 通过 `handleAction` 执行 action，必须声明 actions 与 screenshot capability。
- `host`：宿主通过 Extension 或 CDP 控制浏览器，Provider 只管理外部资源和连接信息。
- `none`：当前没有控制通道，用于配对、失联或停止状态。

只有 `connected` 且 control 可用时才能执行常规 action。Provider 控制模式下，Runtime 会先检查 capability，再进入 `handleAction`。

动作清单使用明确的已实现集合，不用 SDK 全量动作减排除项生成，避免依赖升级时误声明新增能力。SDK 中存在某个 action 不代表适配器后端已经实现该 action，例如宿主页运行时不能仅凭普通 CDP 求值能力声明支持。

## 资源与生命周期

控制会话由 Mearl 统一管理，Provider 的 `handleAction` 接收目标实例、页面和普通动作，无需实现会话归属、排队或人工交接。会话释放结束 Mearl 任务控制；实例 `close`、`detach` 与 `syncCookies` 保持各自语义。上传与下载分别按 `capabilities.actions` 中的 `page_upload`、`page_download` 声明使用。

`page_upload` 接收执行宿主上的 `filePaths`，调用方文件与浏览器产物由 Mearl 中转。`page_download` 接收 `{ tabId, trigger, url?, timeout? }`，先监听下载再执行点击，完成后返回 `ProviderDownloadResult`：`{ filename, filePath, action, owned? }`。`filePath` 必须是本地 Provider 进程宿主上的绝对路径，云端文件由 Provider 取回；`action` 是点击结果，`owned:true` 允许 Mearl 在导入后删除中转文件。Mearl 负责生成统一产物、保存到调用方及会话清理。下载超时或来源不确定时返回错误，不重复点击。

- `ownership`：`owned` 表示 Provider 负责资源生命周期；`attached` 表示接入已有资源。
- `persistence`：`ephemeral` 随任务或关闭结束；`persistent` 可保留并继续使用。
- `operations`：实例当前允许的 `start`、`close`、`detach`、`deleteData`、`access` 或 `syncCookies`。`start`、`detach`、`syncCookies` 分别要求同名实现，`access` 要求 `getAccess`，`close` 与 `deleteData` 使用必需的 `close` 实现，其中删除数据通过 `request.deleteData: true` 区分。
- `references` 是稳定的资源标识；`details` 是可展示的非敏感 JSON。临时访问地址只通过 `getAccess` 返回并标记 `sensitive: true`。

`close` 表示关闭实例；`detach` 表示解除控制但保留外部资源；`deleteData` 允许删除持久化数据。三者不得互相代替。

适配器的 Socket 转发应正确处理跨分块 UTF-8，并有界累计消息。只有请求尚未发送时的连接失败可以自动重连后重试；已发送请求的超时、断连或业务失败不能直接重放。Mearl 控制宿主以调用方绝对期限限制排队和后续动作，适配器自己的等待预算也需覆盖长时间等待、文件传输及持久化关闭，不能统一截断在固定两分钟。

## Runtime 骨架

```ts
import { createProviderServer, type BrowserProviderDefinition } from '@mearl/provider';

const baseDefinition: BrowserProviderDefinition = {
  descriptor: {
    providerId: 'example-device',
    name: 'Example device provider',
    version: '1.0.0',
  },
  browserType: {
    name: 'Device',
    inputSchema: { type: 'object', properties: {} },
  },
  listBrowsers: () => adapter.list(),
  launch: (options, context) => adapter.launch(options, context),
  close: (request, context) => adapter.close(request, context),
  handleAction: actionContext => adapter.dispatch(actionContext),
};

let server: ReturnType<typeof createProviderServer>;
const publish = async () => server.updateBrowsers(await baseDefinition.listBrowsers!({}));
const definition: BrowserProviderDefinition = {
  ...baseDefinition,
  launch: async (options, context) => {
    const browser = await baseDefinition.launch(options, context);
    await publish();
    return browser;
  },
  close: async (request, context) => {
    const result = await baseDefinition.close(request, context);
    await publish();
    return result;
  },
  handleAction: baseDefinition.handleAction
    ? async context => {
        try {
          return await baseDefinition.handleAction!(context);
        } finally {
          await publish();
        }
      }
    : undefined,
};
server = createProviderServer({ definition });
await server.start();
await publish();
```

骨架不代表能力已完成。`launch` 必须返回合法 `ProviderBrowser`；`listBrowsers` 必须在创建、配对、失联、停止和关闭后反映真实终态。如果 action、轮询或 SDK 事件会改变状态，也要在变化后发布快照；只实现 `listBrowsers` 不会让实例自动出现在宿主清单。如果平台由宿主控制，不添加 `handleAction`。

## 验证矩阵

| 层级 | 必须证明 |
| --- | --- |
| 静态 | manifest 和 descriptor 一致，schema、状态、operation 与 capability 通过 Runtime 校验 |
| 单测 | 创建、列表、快照发布时间、状态转换、拒绝未声明 action、关闭与敏感信息边界 |
| 包 | typecheck 和 build 通过，发布包包含 manifest 指向的 entry，entry 不依赖开发工作区解析 |
| 安装（包已在可访问注册源时） | `mearl <providerId> --help` 可读，`browser_manage` 和 `browser_list` 对同一实例语义一致 |
| 端到端 | 一个真实 action 返回可核对结果，关闭或释放后外部资源达到预期终态 |

不默认发布包、创建计费云资源、扫码配对或删除持久化数据。这些动作只在用户明确授权并确认目标后执行；没有可安装的已发布包时，将安装层标记为未验证，不用发布动作换取验证结论。
