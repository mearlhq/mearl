# Mearl 场景：页面排障与视觉验证

需要检查布局、遮挡或 iframe，读取结构化 action 无法取得的状态，或核验视觉效果时读取本文件。常规交互见[网页自动化](./api-page-automation.md)。

## 浏览器扩展页面

调试 Mearl 自身扩展页面时，复用已连接的日常浏览器，用 `tab_open` 打开已知的 `chrome-extension://` 页面入口，持续使用返回的 `tabId` 执行快照、交互和截图，无需另起浏览器。浏览器内部页与扩展页不申请网站域名授权，由 Chrome 检查实际调试权限；读取其他扩展或内部页面失败时，按实际错误处理。将 popup 或侧边栏入口作为普通标签页打开，验证的是页面内容，真实宿主上下文和浏览器外壳交互需要另行验证。

## 布局、遮挡与滚动容器

优先 `page_inspect`，无需先写 page_eval 脚本。CSS、ref 和 DevTools 当前选区 `$0` 都可检查。文本/role 查找先用 page_snapshot.query，取得 matches/ref 后 inspect。

`matches[].state` 返回原生或 ARIA 声明的 checked/selected/pressed/expanded/disabled/readonly，值带 `source`，支持 mixed；缺失字段表示没有可靠语义来源。

- 命中数量与尺寸：读取 count、boundingBox、computedStyle；scanTruncated 时 count 不是完整扫描结果。
- 点不到：hitTest.receivesPointerEvents=false 时检查 occludedBy；不要反复点击或直接合成事件。
- 页面横向溢出：用 horizontal-overflow 找节点，再查看样式与横纵溢出量。
- 页面不滚：用 scrollable 找容器，或检查 scrollContainer 后以 selector/ref 滚动。
- 用户提到 Elements 当前选中节点：用 `$0`，可取得 resolvedSelector、属性、XPath 和框架信息，再进行结构化操作或元素截图。

## iframe 定位

用 `page_frames` 获取 frameId 与 URL/name，不猜 frame ID。扩展/CDP 的 page_eval.frameId 都在指定 frame 的页面默认上下文执行；省略时容器/设备外壳使用当前业务 frame，普通页面使用主 frame。需要读取外层容器时显式传主 frame ID。

扩展后端在目标 frame 内取得的坐标用于点击时，同时传该 frameId 与 coordinateSpace=active-frame，避免误用外层视口或另一个业务 frame 的坐标。CDP 点击尚不支持显式 frameId/active-frame 坐标，不将 page_eval 的 frame 支持推断到其他 action。

跨域 iframe 或快照不足以反映的视觉内容使用截图。容器中的默认业务 frame 与显式 frame 的输入派发范围，以 action help 的后端支持说明为准。

## 最小范围脚本

结构化快照、inspect 或滚动无法表达需求时，使用只读 page_eval 读取必要状态。默认裸执行，只返回 result；需要变更信号或诊断时才显式启用 observe/diagnostics。

获取 selector 后回到结构化 action；直接 DOM 改写或合成点击可能绕过页面真实逻辑，不能仅用表达式执行成功证明业务成功。

## 视觉验证

用 `page_screenshot --output <绝对路径>` 保存后交给图像查看能力；避免将 base64 stdout 放进文本上下文。支持当前视口和指定元素截图，元素截图可能滚动目标到可见区。

Canvas、纯视觉变化、跨域 iframe 或用户明确要求的 UI 核验才需要截图，不作为每个动作后的固定步骤。图片宽高是物理像素，按 CSS 尺寸 × DPR 解释。
