export const screenshots = {
  formatter: {
    file: 'popup-formatter.webp', width: 1360, height: 540,
    en: 'Paste a URL into Data Formatter to inspect and edit its query parameters or copy a QR code for your phone.',
    'zh-CN': '把网址粘贴到数据格式化工具，可以检查和编辑查询参数，也可以复制二维码在手机上打开。',
  },
  json: {
    file: 'popup-json-tree.webp', width: 1360, height: 668,
    en: 'Data Formatter expands the nested JSON for a sample order, including its line items and delivery fields.',
    'zh-CN': '数据格式化工具把示例订单的 JSON 展开成树，可以逐层查看商品和配送字段。',
  },
  toolOrder: {
    file: 'popup-tool-order.webp', width: 880, height: 480,
    en: 'In the tool order dialog, the divider places Data Formatter, Agent Chat, and Request Rules in the Popup toolbar.',
    'zh-CN': '在「调整工具顺序」中，分隔线上方的数据格式化、Agent 对话和请求规则显示在 Popup 顶部。',
  },
  requestRule: {
    file: 'popup-request-rule.webp', width: 1360, height: 970,
    en: 'An enabled request rule adds X-Demo-Mode: staging to requests for the sample orders endpoint.',
    'zh-CN': '这条已启用的规则为示例订单接口的请求添加 X-Demo-Mode: staging 请求头。',
  },
  agentChart: {
    file: 'agent-topic-chart.webp', width: 1640, height: 764,
    en: 'Codex grouped the visible Hacker News headlines and returned a topic chart in the Popup conversation.',
    'zh-CN': 'Codex 汇总了 Hacker News 当前页面的标题，并在 Popup 对话里展示话题分布。',
  },
  ordersResponse: {
    file: 'orders-response.webp', width: 1800, height: 1080,
    en: 'In the Mearl panel, the Response tab shows the three orders returned by GET /api/orders. The phone preview shows the same orders.',
    'zh-CN': 'Mearl 调试面板的 Response 标签页显示 GET /api/orders 返回的 3 条订单，左侧手机预览也显示了这 3 条。',
  },
  ordersMock: {
    file: 'orders-mock.webp', width: 1800, height: 1080,
    en: 'After the mock returns an empty orders array and total: 0, refreshing the page changes the phone preview to zero orders.',
    'zh-CN': 'Mock 将响应改为空数组和 total: 0，刷新后，手机预览里的订单数量变成了 0。',
  },
  phoneEmulation: {
    file: 'phone-emulation.webp', width: 576, height: 1110,
    en: 'The sample order list in the iPhone 17 Pro preset. The device frame includes the status bar and a mobile viewport.',
    'zh-CN': '在 iPhone 17 Pro 预设下打开示例订单列表，可以同时核对手机外壳、状态栏和移动端布局。',
  },
  wechatCatalog: {
    file: 'wechat-miniprogram-catalog.webp', width: 402, height: 874,
    en: 'ChineseBQB-weapp’s sticker catalog running in Mearl’s iPhone 17 Pro preset.',
    'zh-CN': 'ChineseBQB-weapp 的表情包目录，运行在 Mearl 的 iPhone 17 Pro 预设中。',
  },
  wechatPack: {
    file: 'wechat-miniprogram-pack.webp', width: 402, height: 874,
    en: 'The cat sticker pack rendered after navigating to the mini-program’s pack page.',
    'zh-CN': '跳转到小程序详情页后，猫咪表情包的图片网格正常渲染。',
  },
} as const;

export type Screenshot = keyof typeof screenshots;
