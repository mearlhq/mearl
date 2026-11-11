export const extensionCopy = {
  en: {
    quietTitle: 'Keep your current window in focus',
    quietText:
      'The extension prevents foreground activation by default. When an agent requests activation, the page stays in the background without switching tabs or bringing a window forward. Turn off this preference in settings when you want the agent to bring pages forward.',
    toolsTitle: 'Open the Popup toolbox',
    toolsEntry: 'Format JSON or URLs, configure request rules, and launch installed tools.',
    chatEntry: 'Summarize or annotate the page you already have open.',
    devtoolsEntry: 'Use requests and console logs to explain what happened on the page.',
    urlExample: 'See the URL formatter',
    toolsLead:
      'Click Mearl in the Chrome toolbar. Open a pinned tool directly or choose Toolbox to see the other tools.',
    formatterTitle: 'Inspect JSON and URLs',
    formatterText:
      'Open Data Formatter and paste JSON or a URL. Expand and search fields, edit values, and copy the result. For a URL, you can also edit query parameters or copy a QR code to open it on your phone.',
    rulesTitle: 'Change how a request is sent',
    rulesText:
      'Open Request Rules to redirect traffic to a test endpoint or change a request header. Enable the rule, repeat the page action, and verify the request in DevTools.',
    moreToolsTitle: 'Work with browsers and devices',
    moreTools: [
      {
        title: 'Browsers',
        text: 'See connected browsers and control sessions. If an agent has access to several browser profiles, use this view to identify the one you want it to use.',
      },
      {
        title: 'Device Debugging',
        text: 'Capture requests from a connected physical device and inspect responses. This entry appears when the corresponding capture capability is enabled.',
      },
    ],
    pinTitle: 'Put the tools you use most at the top',
    pinText:
      'Open Toolbox → Reorder tools. Drag tools above the divider to put them in the Popup toolbar. Move the divider to control how many tools appear there.',
    pluginsTitle: 'Add tools from Skill plugins',
    pluginsText:
      'After setting up the local service, use Install tools in the Toolbox to find tools such as Notes, Format Converter, and Design Overlay. Once installed, you can put them in the toolbar alongside built-in tools.',
    miniProgramLink: 'Run a local WeChat mini-program',
    devtoolsTitle: 'Trace a problem in DevTools',
    devtoolsText:
      'Open DevTools on the page you want to inspect and choose Mearl. If clicking Refresh leaves an order list blank, reproduce it once and use the request and console views to determine whether the response failed or the page failed to render it.',
    devtoolsSteps: [
      'Inspect the request status and response body, then check console errors from the same attempt.',
      'Replay the request to check whether the endpoint still returns the same result.',
      'Mock an empty response or an error and repeat the action to verify how the page handles it.',
    ],
    chatTitle: 'Work with the current page in Agent Chat',
    chatText:
      'After local setup and agent configuration, open Agent Chat in the Popup and ask a question about the tab. You can ask Codex to summarize a list and return a chart for review in the conversation. Continue in the side panel to point out a particular element or mark a place that needs attention.',
    prompt:
      'Read the visible Hacker News headlines, group them by topic, and show the counts in a bar chart.',
  },
  'zh-CN': {
    quietTitle: '默认不打扰当前工作',
    quietText:
      '扩展默认开启「免打扰」。Agent 请求激活页面时，保持页面在后台运行，不切换标签页或唤起窗口。需要 Agent 将页面带到前台时，可在设置中关闭「免打扰」。',
    toolsTitle: '使用 Popup 工具箱',
    toolsEntry: '处理 JSON 和链接、设置请求规则，或打开已安装的工具。',
    chatEntry: '总结当前网页，或选中元素添加批注。',
    devtoolsEntry: '用网络请求和控制台日志查清网页发生了什么。',
    urlExample: '看网址格式化示例',
    toolsLead:
      '点击 Chrome 工具栏的 Mearl 图标。已置顶的工具可以直接打开，其他工具在「工具箱」里。',
    formatterTitle: '查看 JSON 和链接',
    formatterText:
      '打开「数据格式化」，粘贴 JSON 或网址。展开、搜索或编辑字段后，可以复制结果。处理网址时，还可以修改查询参数，或复制二维码让手机打开同一个链接。',
    rulesTitle: '修改网页请求',
    rulesText:
      '打开「请求规则」，可以把请求重定向到测试接口，或修改请求头。开启规则后重做一次页面操作，到 DevTools 确认实际发出的请求。',
    moreToolsTitle: '操作浏览器和设备',
    moreTools: [
      {
        title: '浏览器',
        text: '查看已连接的浏览器和控制会话。Agent 能访问多个浏览器配置时，可在这里确认要使用的是哪一个。',
      },
      {
        title: '真机调试',
        text: '连接真机后抓取请求、检查响应。开启相应的抓包能力后，工具箱才会显示这个入口。',
      },
    ],
    pinTitle: '把常用工具放到顶部',
    pinText:
      '打开「工具箱」→「调整工具顺序」，把常用工具拖到分隔线上方，即可在 Popup 顶部直接打开。移动分隔线可以调整顶部展示数量。',
    pluginsTitle: '用 Skill 插件添加工具',
    pluginsText:
      '配置好本地服务后，在工具箱点「安装工具」，可以查找记事本、格式转换、设计稿对比等工具。安装后也能和内置工具一起放到顶部。',
    miniProgramLink: '运行本地微信小程序',
    devtoolsTitle: '在 DevTools 追踪一次故障',
    devtoolsText:
      '在目标网页打开 DevTools，选择 Mearl。比如订单列表点刷新后变空白，可以复现一次，然后结合请求和控制台日志判断是接口返回异常，还是页面没渲染出来。',
    devtoolsSteps: [
      '查看该请求的状态和响应正文，再对照这次操作触发的控制台错误。',
      '重放请求，确认接口是否仍返回同样的结果。',
      '用 Mock 模拟空响应或错误，再点一次刷新，验证页面的处理逻辑。',
    ],
    chatTitle: '在 Agent 对话里分析当前页面',
    chatText:
      '完成本机安装并配置好 Agent 后，在 Popup 打开 Agent 对话，就能围绕当前标签页提问。可以让 Codex 汇总列表并生成图表，直接在对话里查看。如果要指给 Agent 看某个元素，或标记待处理的位置，可以转到侧边栏继续。',
    prompt: '读取 Hacker News 当前可见的标题，按主题分类，用条形图展示每类的数量。',
  },
};
