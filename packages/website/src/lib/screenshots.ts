export const screenshots = {
  appBrowser: {
    url: 'https://img.alicdn.com/imgextra/i1/O1CN01nnWgmesZVnH1dDJk_!!6000000000994-49-tps-804-1520.webp',
    width: 804,
    height: 1520,
    en: 'Regular browser: the page shows both Add to cart and Buy now.',
    'zh-CN': '普通浏览器：页面底部显示「加入购物车」和「立即购买」。',
  },
  appWebView: {
    url: 'https://img.alicdn.com/imgextra/i2/O1CN01ZhW5i9Q0OsH1JhWW_!!6000000005725-49-tps-649-1227.webp',
    width: 649,
    height: 1227,
    en: 'WeChat mini-program WebView: only Buy now appears.',
    'zh-CN': '微信小程序内网页：底部只显示「立即购买」。',
  },
  formatter: {
    url: 'https://img.alicdn.com/imgextra/i2/O1CN01SsRLkIKv2HE2lCRA_!!6000000005825-49-tps-1360-540.webp',
    width: 1360,
    height: 540,
    en: 'Paste a URL into Data Formatter to inspect and edit its query parameters or copy a QR code for your phone.',
    'zh-CN': '把网址粘贴到数据格式化工具，可以检查和编辑查询参数，也可以复制二维码在手机上打开。',
  },
  json: {
    url: 'https://img.alicdn.com/imgextra/i3/O1CN01sBhB0M4sp0E2lCTE_!!6000000004107-49-tps-1360-668.webp',
    width: 1360,
    height: 668,
    en: 'Data Formatter expands the nested JSON for a sample order, including its line items and delivery fields.',
    'zh-CN': '数据格式化工具把示例订单的 JSON 展开成树，可以逐层查看商品和配送字段。',
  },
  toolOrder: {
    url: 'https://img.alicdn.com/imgextra/i4/O1CN01yZgBEvG0g8C1mmCO_!!6000000003371-49-tps-880-480.webp',
    width: 880,
    height: 480,
    en: 'In the tool order dialog, the divider places Data Formatter, Agent Chat, and Request Rules in the Popup toolbar.',
    'zh-CN':
      '在「调整工具顺序」中，分隔线上方的数据格式化、Agent 对话和请求规则显示在 Popup 顶部。',
  },
  requestRule: {
    url: 'https://img.alicdn.com/imgextra/i2/O1CN01TZVhiUmeFdD2lCY6_!!6000000007460-49-tps-1360-970.webp',
    width: 1360,
    height: 970,
    en: 'An enabled request rule adds X-Demo-Mode: staging to requests for the sample orders endpoint.',
    'zh-CN': '这条已启用的规则为示例订单接口的请求添加 X-Demo-Mode: staging 请求头。',
  },
  agentChart: {
    url: 'https://img.alicdn.com/imgextra/i2/O1CN01W4sZF1srJtF3KRnA_!!6000000006097-49-tps-1640-764.webp',
    width: 1640,
    height: 764,
    en: 'Codex grouped the visible Hacker News headlines and returned a topic chart in the Popup conversation.',
    'zh-CN': 'Codex 汇总了 Hacker News 当前页面的标题，并在 Popup 对话里展示话题分布。',
  },
  ordersResponse: {
    url: 'https://img.alicdn.com/imgextra/i1/O1CN01J7Bl80WB7RC3eacC_!!6000000005663-49-tps-1800-1080.webp',
    width: 1800,
    height: 1080,
    en: 'In the Mearl panel, the Response tab shows the three orders returned by GET /api/orders. The phone preview shows the same orders.',
    'zh-CN':
      'Mearl 调试面板的 Response 标签页显示 GET /api/orders 返回的 3 条订单，左侧手机预览也显示了这 3 条。',
  },
  ordersMock: {
    url: 'https://img.alicdn.com/imgextra/i2/O1CN011V7jfyamdJG3eacC_!!6000000003764-49-tps-1800-1080.webp',
    width: 1800,
    height: 1080,
    en: 'After the mock returns an empty orders array and total: 0, refreshing the page changes the phone preview to zero orders.',
    'zh-CN': 'Mock 将响应改为空数组和 total: 0，刷新后，手机预览里的订单数量变成了 0。',
  },
  phoneEmulation: {
    url: 'https://img.alicdn.com/imgextra/i3/O1CN01cxjj3akx9OC1AVks_!!6000000002338-49-tps-576-1110.webp',
    width: 576,
    height: 1110,
    en: 'The sample order list in the iPhone 17 Pro preset. The device frame includes the status bar and a mobile viewport.',
    'zh-CN': '在 iPhone 17 Pro 预设下打开示例订单列表，可以同时核对手机外壳、状态栏和移动端布局。',
  },
  wechatCatalog: {
    url: 'https://img.alicdn.com/imgextra/i3/O1CN01q19OkulgCqL0obgi_!!6000000002491-49-tps-402-874.webp',
    width: 402,
    height: 874,
    en: 'ChineseBQB-weapp’s sticker catalog running in Mearl’s iPhone 17 Pro preset.',
    'zh-CN': 'ChineseBQB-weapp 的表情包目录，运行在 Mearl 的 iPhone 17 Pro 预设中。',
  },
  wechatPack: {
    url: 'https://img.alicdn.com/imgextra/i1/O1CN01l1ncizxWD5H0obgi_!!6000000000311-49-tps-402-874.webp',
    width: 402,
    height: 874,
    en: 'The cat sticker pack rendered after navigating to the mini-program’s pack page.',
    'zh-CN': '跳转到小程序详情页后，猫咪表情包的图片网格正常渲染。',
  },
} as const;

export type Screenshot = keyof typeof screenshots;
