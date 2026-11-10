import type { Guide, Locale, Page } from './site';
import type { Screenshot } from './screenshots';

type Topic = Exclude<Guide, 'installation' | 'quick-start'>;
type Reference = { label: string } & (
  { page: Page } | { path: string; shared?: true } | { url: string }
);
interface Section {
  id: string;
  title: string;
  text: string;
  items?: string[];
  steps?: string[];
  flow?: { caption: string; nodes: { title: string; text: string }[] };
  screenshot?: Screenshot | Screenshot[];
  command?: string;
  links?: Reference[];
}
interface TopicCopy {
  title: string;
  lead: string;
  sections: Section[];
  routes?: Array<{ id: string; title: string; text: string }>;
}

const chooseBrowser = 'mearl browser_list';
const newSession = `mearl tab_open --browser '<browserId>' --session new --payload '{"url":"https://example.com","reuse":"prefer"}'`;
const snapshot = `mearl page_snapshot --payload '{"tabId":12345,"mode":"interactive"}'`;
const webMcp = `mearl page_snapshot --payload '{"tabId":12345,"includeWebMcp":"full"}'
mearl page_call_tool --payload '{"tabId":12345,"toolRef":"<ref>","arguments":{"orderId":"123"}}'`;
const diagnostics = `mearl tab_checkpoint --payload '{"tabId":12345}'
mearl get_requests --payload '{"tabId":12345,"after":"<cursor>","includeBody":false}'
mearl get_logs --payload '{"tabId":12345,"after":"<cursor>","level":"error"}'`;
const signedRequest = `mearl send_request --browser '<browserId>' --payload '{"url":"https://api.example.com/me"}'`;
const emulate = `mearl set_device_emulation --payload '{"tabId":12345,"enabled":true,"preset":"iphone-17-pro"}'`;
const findProfiles = 'mearl set_app_profile --help';
const wechatMiniProgram = `npx @mearl/setup plugin install mearlhq/wechat-profile --github --skill wechat-miniprogram
mearl wxa run ./dist`;
const chineseBqb = 'https://github.com/F-loat/ChineseBQB-weapp';
const egoSetup = `npx @mearl/setup provider install '@mearl/provider-ego@/absolute/path/to/provider-ego'
mearl browser_launch --payload '{"provider":"ego","providerOptions":{"name":"My task"}}'`;
const pluginSetup = `npx @mearl/setup plugin install mearlhq/mearl --github --skill notes-memory
mearl notes --help
mearl notes list`;
const adapterSetup =
  'npx @mearl/setup plugin install mearlhq/mearl --github --skill mearl-bbrowser';
const adapterCommands = `mearl bbrowser site search bilibili
mearl bbrowser site info bilibili/popular
mearl bbrowser site bilibili/popular 10`;

export const guideContent: Record<Topic, Record<Locale, TopicCopy>> = {
  browsers: {
    en: {
      title: 'Browsers and control sessions',
      lead: 'To reuse a sign-in, connect to the browser where you’re already signed in. For an isolated test, launch a separate instance.',
      sections: [
        {
          id: 'connections',
          title: 'Choose a connection',
          text: 'Mearl discovers connected browsers and reports each instance’s browserId and connection state.',
          items: [
            'Chrome extension: use the current Chrome profile and its signed-in pages.',
            'CDP: connect directly to Chrome or launch a separate managed instance.',
            'Cloud Connector: reach a browser on a remote host through a configured server.',
            'Browser Provider: connect another browser platform or device. Supported actions and lifecycle operations depend on the Provider.',
          ],
          command: chooseBrowser,
          links: [{ label: 'Provider reference', path: 'packages/provider/README.md' }],
        },
        {
          id: 'local-architecture',
          title: 'How a command reaches your browser',
          text: 'With the extension connection, actions run in the selected Chrome profile. If you pick a direct CDP connection, the Native Host sends commands to Chrome over CDP instead.',
          flow: {
            caption: 'Local browser control through the Chrome extension',
            nodes: [
              { title: 'CLI / SDK / MCP', text: 'Submit a browser action and its target.' },
              { title: 'Native Host', text: 'Resolve the browser and session over local IPC.' },
              { title: 'Mearl extension', text: 'Receive the action over Native Messaging.' },
              {
                title: 'Chrome tab',
                text: 'Run the action in the selected profile and return the result.',
              },
            ],
          },
        },
        {
          id: 'sessions',
          title: 'Keep actions on the same target',
          text: 'Use the returned browserId to select an instance and the tabId for subsequent page actions. A control session pins routing and task ownership while keeping that browser profile’s existing cookies and storage.',
          command: newSession,
        },
        {
          id: 'handoff',
          title: 'Hand control to a person',
          text: 'Pause the control session for login, a verification prompt, or manual inspection. After the person hands it back, read the page again before continuing. Releasing the session normally leaves the result tabs open.',
          links: [
            { label: 'CLI session reference', path: 'packages/client/README.md' },
            { label: 'EgoLite cooperation', page: 'ego-lite' },
          ],
        },
      ],
    },
    'zh-CN': {
      title: '浏览器连接与控制会话',
      lead: '要沿用登录状态，就连接已登录的浏览器。要隔离测试，就启动一个独立实例。',
      sections: [
        {
          id: 'connections',
          title: '选择连接方式',
          text: 'Mearl 会发现已连接的浏览器，并返回各实例的 browserId 和连接状态。',
          items: [
            'Chrome 扩展用于当前 Chrome 配置和已有登录态的页面。',
            'CDP 可直接连接 Chrome，也可启动独立的托管实例。',
            '云端 Connector 经配置好的服务访问远程主机上的浏览器。',
            'Browser Provider 接入其他浏览器平台或设备，动作和生命周期操作由 Provider 声明。',
          ],
          command: chooseBrowser,
          links: [{ label: 'Provider 文档', path: 'packages/provider/README.md' }],
        },
        {
          id: 'local-architecture',
          title: '一条命令怎样到达浏览器',
          text: '使用扩展连接时，动作在选中的 Chrome 配置里执行。如果选的是直连 CDP，Native Host 会通过 CDP 把命令发给 Chrome。',
          flow: {
            caption: '通过 Chrome 扩展控制本机浏览器',
            nodes: [
              { title: 'CLI / SDK / MCP', text: '提交浏览器动作和目标。' },
              { title: 'Native Host', text: '接收本机 IPC 请求，解析浏览器和会话。' },
              { title: 'Mearl 扩展', text: '通过 Native Messaging 接收动作。' },
              { title: 'Chrome 标签页', text: '沿用选中的浏览器配置执行，返回结果。' },
            ],
          },
        },
        {
          id: 'sessions',
          title: '保持任务目标一致',
          text: '用返回的 browserId 选择实例，后续页面动作沿用该页的 tabId。控制会话固定路由和任务归属，继续使用浏览器配置中原有的 Cookie 和存储。',
          command: newSession,
        },
        {
          id: 'handoff',
          title: '交给人接手',
          text: '遇到登录、验证或需要人工检查时，可以暂停控制会话。用户交还后先重新观察页面，再继续操作。释放会话时通常会保留结果标签页。',
          links: [
            { label: 'CLI 会话参考', path: 'packages/client/README.md' },
            { label: '与 EgoLite 协作', page: 'ego-lite' },
          ],
        },
      ],
    },
  },
  'browser-automation': {
    en: {
      title: 'Automate a page',
      lead: 'Use a page snapshot to find controls and verify the result of an interaction, or call tools a site provides through WebMCP.',
      sections: [
        {
          id: 'snapshot',
          title: 'Start with a snapshot',
          text: 'Use the tabId returned by tab_open or tab_list in the example. An interactive snapshot returns a compact view of the viewport’s controls. Use its element refs to click, type, hover, or select. Read a fresh snapshot after navigation or when refs go stale.',
          command: snapshot,
        },
        {
          id: 'observe',
          title: 'Read what the action changed',
          text: 'Page actions can report changed controls, notifications, navigation, and newly opened tabs. Use these results to decide whether you need another snapshot. Use a screenshot to check visual layout and page inspection to diagnose an overlapping or clipped element.',
          steps: [
            'For an order search, read a snapshot of the filters, then fill the order number and submit.',
            'Check the result count or the matching order in the action observation. Take a fresh snapshot of the results if the observation is inconclusive.',
            'If the site opens a new tab, use its returned tabId. Verify the order number there before reading the details.',
          ],
          links: [
            {
              label: 'Page action guide',
              path: 'packages/client/guides/api-page-automation.md',
              shared: true,
            },
            { label: 'Web debugging', page: 'web-debugging' },
          ],
        },
        {
          id: 'compose',
          title: 'Compose a repeatable flow',
          text: 'Use mearl run for JavaScript with conditions, loops, and browser or Skill commands. Applications can call the TypeScript SDK directly. MCP clients can run the shared actions or use browser_run_code for a scripted sequence.',
          links: [
            { label: 'Package a workflow as a Skill', page: 'skill-plugins' },
            { label: 'CLI and SDK reference', path: 'packages/client/README.md' },
            { label: 'MCP tools', path: 'packages/mcp-server/README.md' },
          ],
        },
        {
          id: 'webmcp',
          title: 'Discover and call WebMCP tools',
          text: 'WebMCP lets a site expose actions such as looking up an order. Mearl discovers tools registered by the main document in the selected Chrome tab. The extension connection and direct CDP both support discovery and calling, subject to the browser’s WebMCP capabilities.',
          steps: [
            'Check the webmcp array returned by tab_open, page_navigate, or page_snapshot. Discovery runs in the background. If the directory is missing or truncated, request it explicitly with includeWebMcp set to "full".',
            'Use the returned ref and the tool’s input schema with page_call_tool. The SDK exposes pageCallTool and MCP exposes browser_page_call_tool. Refresh the directory after navigation or if the ref expires.',
            'WebMCP is experimental in Chrome and must be enabled for the site or browser. If a browser can only list tools, Mearl reports discovery-only. If no callable tool is available, use the snapshot workflow above.',
          ],
          command: webMcp,
          links: [
            {
              label: 'Chrome WebMCP setup',
              url: 'https://developer.chrome.com/docs/ai/webmcp#get-started',
            },
            { label: 'MCP tools', path: 'packages/mcp-server/README.md' },
          ],
        },
      ],
    },
    'zh-CN': {
      title: '自动化操作网页',
      lead: '用页面快照找到控件，操作后核对结果；也可以直接调用站点提供的 WebMCP 工具。',
      sections: [
        {
          id: 'snapshot',
          title: '先读取页面快照',
          text: '示例中的 tabId 替换为 tab_open 或 tab_list 返回的实际值。交互快照精简输出视口内的控件，可用返回的元素引用点击、输入、悬停或选择。页面跳转或引用失效后重新取快照。',
          command: snapshot,
        },
        {
          id: 'observe',
          title: '用动作结果判断下一步',
          text: '页面动作可以返回控件变化、通知、跳转和新标签页。先读这些结果，再决定是否需要补快照。用截图检查视觉布局，用页面检查定位元素遮挡或裁切。',
          steps: [
            '查订单时，先读取筛选区域的快照，再填写订单号并提交查询。',
            '从动作结果中核对结果数量或匹配的订单。动作结果不足时，补读结果区域的快照。',
            '如果站点打开了新标签页，沿用返回的新 tabId，核对订单号后再读详情。',
          ],
          links: [
            {
              label: '页面动作指南',
              path: 'packages/client/guides/api-page-automation.md',
              shared: true,
            },
            { label: '网页调试', page: 'web-debugging' },
          ],
        },
        {
          id: 'compose',
          title: '编排可复用的流程',
          text: '用 mearl run 编写包含条件、循环、浏览器动作和 Skill 命令的 JavaScript。应用可直接调用 TypeScript SDK。MCP 客户端既可调用共享动作，也可通过 browser_run_code 运行一组脚本步骤。',
          links: [
            { label: '把流程封装成 Skill', page: 'skill-plugins' },
            { label: 'CLI 和 SDK 参考', path: 'packages/client/README.md' },
            { label: 'MCP 工具', path: 'packages/mcp-server/README.md' },
          ],
        },
        {
          id: 'webmcp',
          title: '发现和调用 WebMCP 工具',
          text: 'WebMCP 让站点可以提供查订单等操作。Mearl 会发现所选 Chrome 标签页的主文档注册的工具。扩展连接和直连 CDP 都支持发现与调用，实际可用范围取决于浏览器提供的 WebMCP 能力。',
          steps: [
            '查看 tab_open、page_navigate 或 page_snapshot 返回的 webmcp 数组。发现过程在后台运行。目录缺失或被截断时，把 includeWebMcp 设为 "full" 显式补查。',
            '用返回的 ref 和工具的输入 Schema 调用 page_call_tool。SDK 入口是 pageCallTool，MCP 入口是 browser_page_call_tool。页面跳转或引用失效后重新获取目录。',
            'WebMCP 在 Chrome 中仍是实验功能，需要站点或浏览器启用。浏览器只能列出工具时，Mearl 返回 discovery-only 状态。没有可调用工具时，可继续使用前面的快照工作流。',
          ],
          command: webMcp,
          links: [
            {
              label: '在 Chrome 中启用 WebMCP',
              url: 'https://developer.chrome.com/docs/ai/webmcp#get-started',
            },
            { label: 'MCP 工具', path: 'packages/mcp-server/README.md' },
          ],
        },
      ],
    },
  },
  'web-debugging': {
    en: {
      title: 'Debug a web app',
      lead: 'Reproduce the issue once and inspect the requests and logs from that attempt. Change one condition and repeat the same action to verify the result.',
      sections: [
        {
          id: 'devtools',
          title: 'Open the Mearl panel',
          text: 'On the page with the issue, open Chrome DevTools and select Mearl. Reproduce the issue, then check the request status, response body, and console errors.',
          links: [{ label: 'Extension reference', path: 'packages/extension/README.md' }],
        },
        {
          id: 'trace',
          title: 'Trace a single reproduction',
          text: 'Record a checkpoint on the target tab. Reproduce the issue, then substitute the returned cursor to inspect only the new requests and logs. Start with request metadata and read the response body when it matters.',
          command: diagnostics,
          screenshot: 'ordersResponse',
        },
        {
          id: 'change',
          title: 'Change one condition and verify',
          text: 'To test the empty state, mock an empty order list, refresh the page, and check that it shows zero orders. Use a request rule to test a redirect or header change. Available rules vary by connection.',
          screenshot: 'ordersMock',
          links: [
            {
              label: 'Request diagnostics guide',
              path: 'packages/client/guides/api-request-debugging.md',
              shared: true,
            },
            { label: 'Replay with browser sign-in', page: 'authenticated-requests' },
          ],
        },
      ],
    },
    'zh-CN': {
      title: '调试一个网页问题',
      lead: '先复现一次问题，查看这次操作产生的请求和日志。再改变一个条件，重做同样的操作，核对页面结果。',
      sections: [
        {
          id: 'devtools',
          title: '打开 Mearl 调试面板',
          text: '在出现问题的网页打开 Chrome DevTools，选择 Mearl。复现问题后，检查请求状态、响应正文和控制台错误。',
          links: [{ label: '扩展功能参考', path: 'packages/extension/README.md' }],
        },
        {
          id: 'trace',
          title: '只看这次复现的数据',
          text: '先在目标标签页记录一个检查点，再复现问题。把返回的 cursor 填入查询，只读取本次新增的请求和日志。先看请求元信息，定位到具体请求后再读正文。',
          command: diagnostics,
          screenshot: 'ordersResponse',
        },
        {
          id: 'change',
          title: '改变一个条件，核对结果',
          text: '要检查空订单状态，可以用 Mock 让订单接口返回空列表，再刷新页面，确认订单数变为 0。要测试重定向或请求头变化，则使用请求规则。可用规则取决于连接方式。',
          screenshot: 'ordersMock',
          links: [
            {
              label: '请求诊断指南',
              path: 'packages/client/guides/api-request-debugging.md',
              shared: true,
            },
            { label: '带浏览器登录态重放请求', page: 'authenticated-requests' },
          ],
        },
      ],
    },
  },
  'authenticated-requests': {
    en: {
      title: 'Send authenticated requests',
      lead: 'Replay an HTTP request using the cookies from a browser you have already signed in to.',
      sections: [
        {
          id: 'replay',
          title: 'Choose the signed-in browser',
          text: 'Open or sign in to the site in the target browser. Use browser_list to get its browserId, then replace the sample URL with a known endpoint. Mearl sends a GET request with matching browser cookies by default. The result includes the HTTP status, body, and attached cookie count.',
          command: signedRequest,
        },
        {
          id: 'permission',
          title: 'Handle permissions and expired sessions',
          text: 'If the host asks for domain access, grant access in Chrome before retrying. In extension mode, Mearl attaches the matching cookies inside the extension. Check for a login page, expired session, or unexpected browser if the response differs from what you saw in the original tab.',
          links: [
            {
              label: 'Request troubleshooting',
              path: 'packages/client/guides/api-request-debugging.md',
              shared: true,
            },
          ],
        },
        {
          id: 'choose',
          title: 'Choose the right request path',
          text: 'Use send_request when you know the HTTP endpoint. Inspect requests in DevTools or get_requests when you first need to learn what the page sends. For protocol-specific or managed authentication, use the installed capability’s command and its authorization flow.',
          links: [
            { label: 'Inspect and replay requests', page: 'web-debugging' },
            { label: 'Run a site adapter', page: 'bb-browser' },
          ],
        },
        {
          id: 'verify-result',
          title: 'Verify a report request before reusing it',
          text: 'For a recurring report, start with a read-only request you have observed in a successful page session.',
          steps: [
            'Apply a known date filter in the page and identify the request that loads the report.',
            'Reproduce the request with the same filter and the same browser profile. Check the response body and compare the rows with the page.',
            'Keep the date range as an input when packaging the call into a Skill. Check the response format as well as the status, since an expired session can return a login page.',
          ],
          links: [{ label: 'Package a reusable workflow', page: 'skill-plugins' }],
        },
      ],
    },
    'zh-CN': {
      title: '发送带登录态的请求',
      lead: '复用已经登录的浏览器 Cookie，重放一个 HTTP 请求。',
      sections: [
        {
          id: 'replay',
          title: '选择已登录的浏览器',
          text: '先在目标浏览器打开站点并登录，通过 browser_list 取得 browserId，再把示例 URL 替换为已知接口。Mearl 默认发送 GET 请求并附带匹配的浏览器 Cookie。结果包含 HTTP 状态、响应正文和附带的 Cookie 数量。',
          command: signedRequest,
        },
        {
          id: 'permission',
          title: '处理域权限和登录失效',
          text: '如果宿主要求域名权限，在 Chrome 中授权后再重试。使用扩展连接时，匹配的 Cookie 在扩展内附加。如果响应和原标签页不同，检查是否返回登录页、会话已失效，或选错了浏览器。',
          links: [
            {
              label: '请求排查指南',
              path: 'packages/client/guides/api-request-debugging.md',
              shared: true,
            },
          ],
        },
        {
          id: 'choose',
          title: '按请求类型选入口',
          text: '已知 HTTP 接口时用 send_request。需要先了解页面实际发了什么时，用 DevTools 或 get_requests 查看。特定协议和托管身份走已安装能力的命令和授权流程。',
          links: [
            { label: '检查与重放请求', page: 'web-debugging' },
            { label: '运行站点适配器', page: 'bb-browser' },
          ],
        },
        {
          id: 'verify-result',
          title: '先验证报表请求，再复用',
          text: '如果要定期读取报表，先从页面实际成功发出的一条只读请求开始。',
          steps: [
            '在页面上选择一个已知的日期范围，找到加载报表数据的请求。',
            '沿用同一个浏览器配置和日期范围重放请求，检查响应正文，对比返回的数据与页面。',
            '封装成 Skill 时，把日期范围留作输入。除了状态码，也要检查响应格式，避免把会话过期后返回的登录页当成报表。',
          ],
          links: [{ label: '封装可复用的流程', page: 'skill-plugins' }],
        },
      ],
    },
  },
  emulation: {
    en: {
      title: 'Device and App emulation',
      lead: 'Choose the environment that matches what you need to verify.',
      routes: [
        {
          id: 'device',
          title: 'Mobile website',
          text: 'Apply a device preset to a web page to check layout, touch, and viewport size.',
        },
        {
          id: 'app',
          title: 'App WebView',
          text: 'Use WeChat emulation to test H5 pages that depend on the WeChat User-Agent, JSBridge, or WebView behavior.',
        },
        {
          id: 'wechat-miniprogram',
          title: 'Local WeChat mini-program',
          text: 'Use the WeChat mini-program Skill with a native project or compiled WeChat output.',
        },
      ],
      sections: [
        {
          id: 'device',
          title: 'Test a mobile viewport',
          text: 'Pick a device preset for viewport size, device pixel ratio, user agent, and touch. Replace the sample tabId with your target. Use the Device Shell when you need system bars and a framed WebView. Set a time-zone override separately with set_timezone.',
          command: emulate,
          screenshot: 'phoneEmulation',
        },
        {
          id: 'app',
          title: 'Use App WebView emulation',
          text: 'Capability packages provide App emulation configurations. Query the target browser’s profile catalog to find supported IDs and options for user agent, JSBridge behavior, and WebView setup. Bridge responses simulate page-visible behavior. Native sign-in or payments depend on separately available capabilities.',
          command: findProfiles,
          steps: [
            'Open the page you want to test in a regular browser and capture its layout and available actions.',
            'Install the WeChat profile and select WeChat web page emulation. Reload the page and check the behavior that depends on the User-Agent or JSBridge.',
            'With the device shell enabled, use the bottom gesture bar to switch to WeChat mini-program web page. An Agent can use set_app_profile with the ID returned by get_capabilities.',
          ],
          screenshot: ['appBrowser', 'appWebView'],
          links: [
            { label: 'WeChat H5 emulation', url: 'https://github.com/mearlhq/wechat-profile' },
            { label: 'Capability packages', path: 'docs/capability-model.md' },
          ],
        },
        {
          id: 'wechat-miniprogram',
          title: 'Run a local WeChat mini-program',
          text: 'The WeChat mini-program Skill runs native projects and compiled WeChat output from frameworks such as Taro and uni-app. Open the local preview to switch devices, inspect the page and navigation stack, or mock WeChat APIs and responses. Each run compiles once and opens a local file. Run the project again to update the preview after changes. For a web page inside WeChat, use WeChat H5 emulation.',
          steps: [
            'For ChineseBQB-weapp, install the project dependencies and run npm run build:weapp to generate dist. The Skill also accepts a native mini-program project directly.',
            'Install the Skill and run the command below from the project root. With the Chrome extension, allow file URL access and user scripts as described in the runtime guide.',
            'Open a sticker pack in the preview and check that the page changes and renders the stickers.',
          ],
          command: wechatMiniProgram,
          screenshot: ['wechatCatalog', 'wechatPack'],
          links: [
            { label: 'ChineseBQB-weapp example project', url: chineseBqb },
            {
              label: 'WeChat mini-program runtime guide',
              url: 'https://github.com/mearlhq/wechat-profile/blob/main/docs/wechat-miniprogram.md',
            },
          ],
        },
        {
          id: 'verify',
          title: 'Apply before navigation when it matters',
          text: 'Pass emulation or appProfile to tab_open when a new page must see the environment on its first load. For an existing tab, apply the corresponding setting and use the response to verify the viewport and profile. Clear the setting explicitly when you want to restore the tab.',
          steps: [
            'For a mobile checkout layout, run the same steps at desktop size and at the target device preset. Capture the point where the layout changes.',
            'If the difference only appears inside an App, load its installed profile before navigation. Check the User-Agent or JSBridge behavior the page uses to choose its layout.',
            'Repeat the same steps after the fix and compare the screenshots and request results.',
          ],
          links: [
            {
              label: 'Environment guide',
              path: 'packages/client/guides/api-page-environment.md',
              shared: true,
            },
            { label: 'Use emulation in EgoLite', page: 'ego-lite' },
          ],
        },
        {
          id: 'extend-apps',
          title: 'Extend emulation with an App profile',
          text: 'To support another App WebView, define its User-Agent, JSBridge behavior, and container settings in an App profile. A browser capability package registers the profile under contributions.appProfiles. After installation, use mearl get_capabilities on the target browser to find its ID and options.',
          links: [
            { label: 'App profile reference', path: 'packages/app-profiles/README.md' },
            { label: 'Browser capability package manifest', path: 'docs/browser-bundles.md' },
          ],
        },
        {
          id: 'credits',
          title: 'Open source credits',
          text: 'The WeChat mini-program Skill uses wxa-runner (MIT). The screenshots show F-loat’s ChineseBQB-weapp (MIT). Tencent’s WeChat base library is a separate dependency and retains its own terms.',
          links: [
            { label: 'wxa-runner', url: 'https://github.com/open-wxa/wxa-runner' },
            { label: 'ChineseBQB-weapp', url: chineseBqb },
            {
              label: 'Runtime notices',
              url: 'https://github.com/mearlhq/wechat-profile/blob/main/skills/wechat-miniprogram/assets/runtime/THIRD_PARTY_NOTICES.md',
            },
          ],
        },
      ],
    },
    'zh-CN': {
      title: '设备与 App 模拟',
      lead: '先选要验证的环境，再按对应步骤操作。',
      routes: [
        {
          id: 'device',
          title: '移动网页',
          text: '给网页套用设备预设，检查移动端布局、触摸和视口大小。',
        },
        {
          id: 'app',
          title: 'App WebView',
          text: '使用微信端模拟验证依赖微信 User-Agent、JSBridge 或 WebView 行为的 H5 页面。',
        },
        {
          id: 'wechat-miniprogram',
          title: '本地微信小程序',
          text: '用微信小程序 Skill 运行原生工程或编译后的微信产物。',
        },
      ],
      sections: [
        {
          id: 'device',
          title: '测试移动端视口',
          text: '通过设备预设设置视口、DPR、User-Agent 和触摸。把示例中的 tabId 替换成目标页。需要系统栏和 WebView 外壳时启用设备外壳。时区可通过 set_timezone 单独设置。',
          command: emulate,
          screenshot: 'phoneEmulation',
        },
        {
          id: 'app',
          title: '开启 App WebView 端模拟',
          text: '端模拟配置由能力包提供。查询目标浏览器的端模拟列表，确认可用 ID、User-Agent、JSBridge 行为和容器设置。桥接回包模拟网页能感知的行为，真实原生登录或支付依赖另行可用的能力。',
          command: findProfiles,
          steps: [
            '在普通浏览器中打开待验证的网页，记录布局和可用操作。',
            '安装微信端模拟并选择「微信内网页」，刷新页面，检查依赖 User-Agent 或 JSBridge 的行为。',
            '开启设备外壳后，可从底部手势条切换到「微信小程序内网页」。Agent 可通过 get_capabilities 获取配置 ID，再用 set_app_profile 切换。',
          ],
          screenshot: ['appBrowser', 'appWebView'],
          links: [
            {
              label: '微信端模拟',
              url: 'https://github.com/mearlhq/wechat-profile/blob/main/README.zh-CN.md',
            },
            { label: '能力包文档', path: 'docs/capability-model.md' },
          ],
        },
        {
          id: 'wechat-miniprogram',
          title: '运行本地微信小程序',
          text: '微信小程序 Skill 支持运行原生工程，以及 Taro、uni-app 等框架编译出的微信产物。可以在预览中切换机型、检查页面和页面栈，也可以模拟微信 API 和接口回包。每次运行编译一次并打开本地预览，修改后再次运行即可更新。验证微信里的网页时，使用微信 H5 端模拟。',
          steps: [
            '以 ChineseBQB-weapp 为例，安装项目依赖后运行 npm run build:weapp，生成 dist。原生小程序可以直接传入项目目录。',
            '在项目根目录执行下方的安装和启动命令。通过 Chrome 扩展连接时，按运行指南开启文件网址访问和用户脚本。',
            '在预览里打开一个表情包，确认页面跳转且表情图正常渲染。',
          ],
          command: wechatMiniProgram,
          screenshot: ['wechatCatalog', 'wechatPack'],
          links: [
            { label: 'ChineseBQB-weapp 示例项目', url: chineseBqb },
            {
              label: '微信小程序运行指南',
              url: 'https://github.com/mearlhq/wechat-profile/blob/main/docs/wechat-miniprogram.zh-CN.md',
            },
          ],
        },
        {
          id: 'verify',
          title: '让环境在需要时首屏生效',
          text: '新页面首次加载就需要环境时，在 tab_open 中传入 emulation 或 appProfile。已有页可直接应用对应设置，并以回执核对视口和端模拟环境。需要恢复标签页时，显式清除模拟配置。',
          steps: [
            '验收移动端结算页时，分别在桌面视口和目标设备预设下走同一套步骤，截图记录布局出现差异的位置。',
            '如果问题只在 App 里出现，在导航前开启对应的端模拟，检查页面用来判断环境的 User-Agent 或 JSBridge 行为。',
            '修复后跑同一套步骤，对照截图和请求结果。',
          ],
          links: [
            {
              label: '环境准备指南',
              path: 'packages/client/guides/api-page-environment.md',
              shared: true,
            },
            { label: '在 EgoLite 中模拟', page: 'ego-lite' },
          ],
        },
        {
          id: 'extend-apps',
          title: '添加新的端模拟环境',
          text: '要模拟新的 App WebView，可以用端模拟配置定义 User-Agent、JSBridge 行为和容器设置，并在浏览器能力包的 contributions.appProfiles 中注册。安装后，通过 mearl get_capabilities 查询目标浏览器中的端模拟 ID 和选项。',
          links: [
            { label: '端模拟配置参考', path: 'packages/app-profiles/README.md' },
            { label: '浏览器能力包清单', path: 'docs/browser-bundles.md' },
          ],
        },
        {
          id: 'credits',
          title: '开源致谢',
          text: '微信小程序 Skill 使用 wxa-runner（MIT）。示例截图来自 F-loat 的 ChineseBQB-weapp（MIT）。腾讯微信基础库作为独立依赖，适用其自身条款。',
          links: [
            { label: 'wxa-runner', url: 'https://github.com/open-wxa/wxa-runner' },
            { label: 'ChineseBQB-weapp', url: chineseBqb },
            {
              label: '运行时第三方声明',
              url: 'https://github.com/mearlhq/wechat-profile/blob/main/skills/wechat-miniprogram/assets/runtime/THIRD_PARTY_NOTICES.md',
            },
          ],
        },
      ],
    },
  },
  'ego-lite': {
    en: {
      title: 'Use Mearl with EgoLite',
      lead: 'Use the independent Ego Provider for Spaces, page operations, human handoff, and device or App emulation through the native Ego channel. No browser extension is required.',
      sections: [
        {
          id: 'setup',
          title: 'Install the independent Provider',
          text: 'Register a built provider-ego directory with Mearl setup. Requires Node.js 22.23.4+, Mearl 3.0.5+ and ego-browser on PATH. The development package is not yet published to npm. No separate mearl-ego Skill is required. Source builds require a Native Host SDK archive exporting external-page-host; npm 3.0.5 does not include that API.',
          command: egoSetup,
          links: [
            {
              label: 'Provider source and build instructions',
              url: 'https://github.com/mearlhq/provider-ego',
            },
          ],
        },
        {
          id: 'extension-agent',
          title: 'Keep the extension optional',
          text: 'The Provider works without the extension. On macOS, its EgoLite declaration defaults extension Agent access off for that browser profile, while manual debugging panels remain available. Update both the extension and Native Host to versions supporting coordination, then register the Provider again to activate this behavior.',
          items: [
            'You can explicitly enable or disable Agent access in extension settings. This preference stays local to the browser profile and does not sync to other browsers.',
            'Provider outages or removal do not automatically re-enable extension Agent access. Access stays closed until the policy handshake completes; an older Native Host must be updated.',
            'Coordination uses change notifications without periodic polling. Ego ownership checks run only while host requests are pending; each native page operation still checks control. Other platforms do not automatically identify EgoLite.',
          ],
        },
        {
          id: 'identify',
          title: 'Use one Space per task',
          text: 'Launch with providerOptions.name or attach an existing Agent Space with providerOptions.spaceId. Reuse the Provider browserId and tabId. Page mapping is handled by the Provider, without manual extension matching or Mearl --session.',
        },
        {
          id: 'control',
          title: 'Keep control in Ego',
          text: 'Use the Provider CLI for handoff, resume and finish; resume only after the user explicitly returns control. Ego blocks native page operations during takeover. finish keeps no Agent pages by default; use --keep with Ego Page labels to retain results. browser_release only detaches the Provider and does not finish the Space or clear emulation.',
          command: `node /absolute/path/to/provider-ego/dist/cli.js handoff <spaceId>
node /absolute/path/to/provider-ego/dist/cli.js resume <spaceId>
node /absolute/path/to/provider-ego/dist/cli.js finish <spaceId> --keep p1,p2`,
        },
        {
          id: 'emulation',
          title: 'Device shells, WebViews and App services',
          text: 'Configure device and App emulation independently through set_device_emulation and set_app_profile. Enable deviceShell to use a device shell and root WebView. The shared native page host supplies installed App protocol and authorization services; real authorization requires user approval, and takeover cancels pending authorization. Retained pages depend on the Provider connection for emulation and host services. Clear emulation before finish when ordinary pages are needed. Extension-specific request/log entry points are not provided.',
          links: [
            { label: 'Provider contracts', path: 'packages/provider/README.en.md', shared: true },
            { label: 'Device and App emulation', page: 'emulation' },
          ],
        },
        {
          id: 'credits',
          title: 'Open source credits',
          text: 'EgoLite is a separate browser from Citro Labs; its public ego-browser runtime is MIT licensed. The Mearl Provider uses its native automation channel.',
          links: [
            { label: 'EgoLite upstream project', url: 'https://github.com/citrolabs/ego-lite' },
          ],
        },
      ],
    },
    'zh-CN': {
      title: '与 EgoLite 协作',
      lead: '独立 Ego Provider 通过 Ego 原生通道管理 Space、页面操作、人工交接及设备/App 模拟，无需浏览器扩展。',
      sections: [
        {
          id: 'setup',
          title: '安装独立 Provider',
          text: '通过 Mearl setup 注册已构建的 provider-ego 本地目录。需要 Node.js 22.23.4+、Mearl 3.0.5+，且 ego-browser 可执行。开发包尚未发布到 npm，无需单独安装 mearl-ego Skill。源码构建需要包含 external-page-host 导出的 Native Host SDK 归档，npm 3.0.5 尚无此接口。',
          command: egoSetup,
          links: [
            { label: 'Provider 源码与构建说明', url: 'https://github.com/mearlhq/provider-ego' },
          ],
        },
        {
          id: 'extension-agent',
          title: '扩展按需安装，Agent 默认关闭',
          text: 'Provider 无需扩展即可工作。在 macOS 上，其 EgoLite 声明会让该浏览器配置的扩展 Agent 接入默认关闭，人工调试面板仍可使用。需将扩展和 Native Host 都更新到支持协调协议的版本，再重新注册 Provider 后生效。',
          items: [
            '可在扩展设置中明确开启或关闭 Agent 接入。偏好仅保存在当前浏览器配置中，不同步到其他浏览器。',
            'Provider 离线或移除不会自动重新开启扩展 Agent。策略握手完成前保持关闭；旧版 Native Host 需要更新。',
            '协调使用变更通知，不做定时轮询。Ego 控制权检查仅在有待完成的宿主请求时运行，每次原生页面操作仍校验控制权。其他平台暂不自动识别 EgoLite。',
          ],
        },
        {
          id: 'identify',
          title: '一个任务对应一个 Space',
          text: '通过 providerOptions.name 创建任务，或用 providerOptions.spaceId 关联已有 Agent Space。复用 Provider 返回的 browserId 和 tabId；页面映射由 Provider 处理，无需手工匹配扩展标签页，不使用 Mearl --session。',
        },
        {
          id: 'control',
          title: '由 Ego 统一控制权',
          text: '使用 Provider CLI 交接、恢复和完成任务，仅在用户明确交还后恢复。接管期间 Ego 阻断原生页面操作。finish 默认不保留 Agent 页面；用 --keep 指定 Ego Page label 保留结果页。browser_release 只解绑 Provider，不结束 Space，也不清除模拟。',
          command: `node /absolute/path/to/provider-ego/dist/cli.js handoff <spaceId>
node /absolute/path/to/provider-ego/dist/cli.js resume <spaceId>
node /absolute/path/to/provider-ego/dist/cli.js finish <spaceId> --keep p1,p2`,
        },
        {
          id: 'emulation',
          title: '设备外壳、WebView 与 App 服务',
          text: '通过 set_device_emulation 和 set_app_profile 分别配置设备与 App 模拟，启用 deviceShell 可使用设备外壳和根 WebView。共享原生页面宿主提供已安装 App 的协议和授权服务；真实授权仍需用户批准，接管会取消待授权会话。保留页面的模拟与宿主服务依赖 Provider 连接，需要普通页面时应在 finish 前清除模拟。不提供扩展专属请求/日志入口。',
          links: [
            { label: 'Provider 接口', path: 'packages/provider/README.md', shared: true },
            { label: '设备与 App 模拟', page: 'emulation' },
          ],
        },
        {
          id: 'credits',
          title: '开源致谢',
          text: 'EgoLite 是 Citro Labs 的独立浏览器，其公开 ego-browser 运行时使用 MIT 许可证。Mearl Provider 使用其原生自动化通道。',
          links: [{ label: 'EgoLite 上游项目', url: 'https://github.com/citrolabs/ego-lite' }],
        },
      ],
    },
  },
  'skill-plugins': {
    en: {
      title: 'Extend Mearl with Skill plugins',
      lead: 'Turn a workflow you have verified once into a Skill your team can run again from an agent, a command, or the Toolbox.',
      sections: [
        {
          id: 'reuse-workflow',
          title: 'From a platform task to a reusable Skill',
          text: 'Say you export a list of pending orders every week. First, ask the agent to filter and export the list in the browser where you are signed in. Verify the result, then package the workflow with inputs such as date range. If a suitable endpoint can be called reliably with the right permissions, have the Skill call it directly. Keep browser actions for steps that depend on the page.',
          links: [
            { label: 'Send authenticated requests', page: 'authenticated-requests' },
            {
              label: 'Design an API-backed Skill',
              path: 'skills/mearl-skill-creator/references/api-skill-pattern.md',
              shared: true,
            },
          ],
        },
        {
          id: 'choose',
          title: 'Decide what the Skill should provide',
          text: 'A guidance Skill teaches an agent when and how to use existing tools. A Skill plugin also registers executable commands. An optional Toolbox page makes selected commands available in the browser UI. Examples include Notes, Format Converter, and Design Overlay.',
          links: [{ label: 'Skill catalog', path: 'skills/README.md' }],
        },
        {
          id: 'plugin-architecture',
          title: 'How a Skill command runs',
          text: 'The Toolbox and agent tools can share the same business operation. The plugin defines its inputs and results, and can call Mearl browser actions when the task needs the current page or sign-in.',
          flow: {
            caption: 'Execution path for a registered Skill command',
            nodes: [
              {
                title: 'CLI / SDK / MCP or Toolbox',
                text: 'Send the command name and its inputs.',
              },
              {
                title: 'Plugin service',
                text: 'Resolve the installed command and start its task.',
              },
              {
                title: 'Isolated worker',
                text: 'Run the command. Call browser actions as needed.',
              },
              { title: 'Caller', text: 'Receive the result, such as a list or export file.' },
            ],
          },
          links: [{ label: 'Plugin host capabilities', path: 'docs/plugin-runtime.md' }],
        },
        {
          id: 'install',
          title: 'Install and invoke a plugin',
          text: 'Use setup plugin install to install a Skill and register its script in one step. For local development, register the Skill directory with setup plugin <path>. The registered name is shared by the CLI, SDK invokePlugin, and MCP plugin_invoke.',
          command: pluginSetup,
        },
        {
          id: 'design-review',
          title: 'Compare a design with a live page',
          text: 'Install the design-overlay Skill plugin. On the page you want to review, open Design Overlay from the Mearl Toolbox. Import a design, align it with the page, then compare pixels in the current viewport.',
          command: 'npx @mearl/setup plugin install mearlhq/mearl --github --skill design-overlay',
          links: [
            {
              label: 'Design Overlay reference',
              path: 'skills/design-overlay/SKILL.md',
              shared: true,
            },
          ],
        },
        {
          id: 'create',
          title: 'Choose the right extension point',
          text: 'Use a Skill plugin for a reusable task or tool and a Provider to connect another browser or device. Use an App profile to emulate another client environment. Capability packages deliver these profiles and host implementations, while a Preset distributes a configured selection.',
          links: [
            {
              label: 'Build a Skill plugin',
              path: 'skills/mearl-skill-creator/references/cli-plugin.md',
              shared: true,
            },
            { label: 'Extend device and App emulation', page: 'emulation' },
            { label: 'Provider reference', path: 'packages/provider/README.md' },
            { label: 'Capability model', path: 'docs/capability-model.md' },
            { label: 'Preset reference', path: 'packages/preset/README.md' },
          ],
        },
      ],
    },
    'zh-CN': {
      title: '用 Skill 插件扩展 Mearl',
      lead: '把验证过的工作流程做成团队可复用的 Skill，可通过 Agent、命令或工具箱使用。',
      sections: [
        {
          id: 'reuse-workflow',
          title: '把日常平台操作沉淀成 Skill',
          text: '比如每周要导出待处理订单，先让 Agent 在已登录的浏览器里筛选并导出，核对结果后再把日期范围等做成输入参数。有稳定、可授权调用的接口，就在 Skill 里直接调用；依赖页面的步骤则保留浏览器操作。',
          links: [
            { label: '发送带登录态的请求', page: 'authenticated-requests' },
            {
              label: '设计接口型 Skill',
              path: 'skills/mearl-skill-creator/references/api-skill-pattern.md',
              shared: true,
            },
          ],
        },
        {
          id: 'choose',
          title: '决定 Skill 提供什么',
          text: '指引型 Skill 告诉 Agent 何时以及如何调用现有工具。Skill 插件还会注册可执行命令，可选的工具箱页面则把指定命令提供给浏览器用户。仓库中的示例包括记事本、格式转换和设计叠图。',
          links: [{ label: 'Skill 目录', path: 'skills/README.md' }],
        },
        {
          id: 'plugin-architecture',
          title: '一条 Skill 命令怎样执行',
          text: '工具箱和 Agent 可以复用同一项业务操作。插件定义输入和结果，任务需要使用当前网页或登录态时，可以调用 Mearl 的浏览器动作。',
          flow: {
            caption: '已注册 Skill 命令的执行路径',
            nodes: [
              { title: 'CLI / SDK / MCP 或工具箱', text: '提交命令名和输入参数。' },
              { title: '插件服务', text: '找到已安装的命令，启动任务。' },
              { title: '隔离 Worker', text: '执行业务逻辑，按需调用浏览器动作。' },
              { title: '调用方', text: '收到列表、导出文件等结果。' },
            ],
          },
          links: [{ label: '插件宿主能力', path: 'docs/plugin-runtime.md' }],
        },
        {
          id: 'install',
          title: '安装并调用插件',
          text: '用 setup plugin install 一次完成 Skill 安装和脚本注册。本地开发时可用 setup plugin <path> 注册 Skill 目录。注册名可用于 CLI、SDK 的 invokePlugin 和 MCP 的 plugin_invoke。',
          command: pluginSetup,
        },
        {
          id: 'design-review',
          title: '用设计稿核对真实页面',
          text: '安装 design-overlay Skill 插件。在要验收的网页上，从 Mearl 工具箱打开「设计稿对比」。导入设计稿、对齐页面，再比较当前视口中的像素差异。',
          command: 'npx @mearl/setup plugin install mearlhq/mearl --github --skill design-overlay',
          links: [
            { label: '设计稿对比使用说明', path: 'skills/design-overlay/SKILL.md', shared: true },
          ],
        },
        {
          id: 'create',
          title: '为需求选择扩展点',
          text: '用 Skill 插件复用任务和工具，用 Provider 接入其他浏览器或设备，用端模拟配置还原其他客户端环境。能力包可分发这些配置和宿主实现，Preset 则把选定的能力和配置一起分发。',
          links: [
            {
              label: '开发 Skill 插件',
              path: 'skills/mearl-skill-creator/references/cli-plugin.md',
              shared: true,
            },
            { label: '扩展端模拟', page: 'emulation' },
            { label: 'Provider 文档', path: 'packages/provider/README.md' },
            { label: '能力模型', path: 'docs/capability-model.md' },
            { label: 'Preset 文档', path: 'packages/preset/README.md' },
          ],
        },
      ],
    },
  },
  'bb-browser': {
    en: {
      title: 'Run bb-browser site adapters',
      lead: 'Reuse community or private bb-browser site scripts in a Mearl-connected browser, including the page’s existing sign-in state.',
      sections: [
        {
          id: 'install',
          title: 'Install the adapter plugin',
          text: 'Register the mearl-bbrowser Skill plugin. It runs site adapters through Mearl’s Chrome extension or direct CDP connection.',
          command: adapterSetup,
        },
        {
          id: 'run',
          title: 'Find an adapter and check its inputs',
          text: 'Search the local catalog for Bilibili adapters, then use site info to check the arguments for bilibili/popular. The first argument, count, sets how many videos to fetch. The second, page, defaults to 1. The last command requests 10 popular videos from the first page. If the adapter is missing, run mearl bbrowser site update to download the community catalog.',
          command: adapterCommands,
          links: [
            {
              label: 'Bilibili popular videos adapter',
              url: 'https://github.com/epiral/bb-sites/blob/main/bilibili/popular.js',
            },
          ],
        },
        {
          id: 'context',
          title: 'Run in the intended browser context',
          text: 'Select the browser that owns the sign-in state. An adapter with a declared domain can reuse a matching tab or open one. The script runs in the page’s main world and can use its companion _helper.js. Site permissions, login prompts, and page changes still determine the outcome.',
          links: [
            {
              label: 'Adapter compatibility and command reference',
              path: 'skills/mearl-bbrowser/SKILL.md',
              shared: true,
            },
            { label: 'Choose a browser', page: 'browsers' },
          ],
        },
        {
          id: 'credits',
          title: 'Open source credits',
          text: 'The Mearl plugin supports the site adapter format from bb-browser (MIT). The community catalog comes from the upstream bb-sites project.',
          links: [
            { label: 'bb-browser', url: 'https://github.com/epiral/bb-browser' },
            { label: 'bb-sites', url: 'https://github.com/epiral/bb-sites' },
          ],
        },
      ],
    },
    'zh-CN': {
      title: '运行 bb-browser 站点适配器',
      lead: '在 Mearl 连接的浏览器里复用社区或私有 bb-browser 站点脚本，并使用该页面已有的登录态。',
      sections: [
        {
          id: 'install',
          title: '安装适配器插件',
          text: '注册 mearl-bbrowser Skill 插件。它通过 Mearl 扩展连接或直连 CDP 执行站点适配器。',
          command: adapterSetup,
        },
        {
          id: 'run',
          title: '查找适配器并确认参数',
          text: '先在本地目录搜索 B 站适配器，再用 site info 查看 bilibili/popular 的参数。第一个参数 count 是视频条数，第二个参数 page 是页码，默认从第 1 页开始。最后一条命令获取第 1 页的 10 条热门视频。如果找不到适配器，先运行 mearl bbrowser site update 下载社区目录。',
          command: adapterCommands,
          links: [
            {
              label: 'B 站热门视频适配器',
              url: 'https://github.com/epiral/bb-sites/blob/main/bilibili/popular.js',
            },
          ],
        },
        {
          id: 'context',
          title: '在正确的浏览器上下文运行',
          text: '选择已经登录的浏览器。声明了域名的适配器可复用匹配的标签页，也可打开新页。脚本在页面主世界运行，可以加载同目录的 _helper.js。执行结果仍取决于站点权限、登录和当前页面状态。',
          links: [
            {
              label: '适配器兼容范围和命令参考',
              path: 'skills/mearl-bbrowser/SKILL.md',
              shared: true,
            },
            { label: '选择浏览器', page: 'browsers' },
          ],
        },
        {
          id: 'credits',
          title: '开源致谢',
          text: 'Mearl 插件兼容 bb-browser（MIT）的站点适配器格式，社区目录来自上游 bb-sites 项目。',
          links: [
            { label: 'bb-browser', url: 'https://github.com/epiral/bb-browser' },
            { label: 'bb-sites', url: 'https://github.com/epiral/bb-sites' },
          ],
        },
      ],
    },
  },
};
