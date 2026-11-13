# Mearl 场景：接口与埋点调试

需要跨动作诊断、复现浏览器 HTTP/Protocol、处理域权限或设置 Mock/规则时读取本文件。

## 选择诊断通道与输出范围

- get_requests 默认查询全部请求；source=requests 只查普通 HTTP，source=protocol 只查协议插件采集的请求。大响应先用 includeBody=false、keysOnly 或 fields 控制输出；指定非空 fields 时默认省略正文，同时需要全文才传 includeBody=true。省略正文时不返回 postData / responseBody 字段。
- get_logs 按级别/内容过滤，错误排查优先 error。
- get_events 查询 RUM/aplus/ARMS，默认只保留解析字段；排查原始上报才用 includeRaw。既有页首次查询才开启采集，无历史时按 hint 刷新或重新触发。

流式请求开始后即进入缓冲区；isPending 表示仍未完成。SSE 分片按顺序累积，协议归类由已安装的请求插件提供。不能把尚未结束的流误判为无响应；无法归属当前 Tab 的 Service Worker 请求不在采集范围内。

## 单次动作与跨动作边界

单次动作显式传 diagnostics，由执行器在派发前建立边界、在观察后返回新增内容；不要为每个动作额外 checkpoint。diagnostics=true 默认包含 error logs 与业务 requests，埋点用 events 显式开启。observe=false 仍返回诊断，但不等待 DOM/导航稳定。

跨多个动作时建立一次 tab_checkpoint，再用 after 查询本次操作新增的记录：

```bash
mearl tab_checkpoint --payload '{"tabId":12345}'
# 执行要排查的操作后，使用上一步返回的 cursor
mearl get_logs --payload '{"tabId":12345,"after":"<cursor>","level":"error"}'
mearl get_requests --payload '{"tabId":12345,"after":"<cursor>","source":"all","includeBody":false}'
```

同一 checkpoint cursor 可分别作为 logs/requests/events 的初始边界；查询返回的 nextCursor 带通道作用域，只用于同类续读。hasMore 表示仍有记录，gap 表示缓冲区淘汰，不应把缺口视为没有事件。tab_open 的 capture.cursor 是导航前边界，可直接读取首屏诊断。

日志时间用 timestampMs（epoch 毫秒）；同一次埋点上报保持完整批次分页。缺少历史且 captureStatus=armed 时重新触发；inactive 时按 hint 排查采集链路。

## 选择请求能力与执行宿主

浏览器 HTTP 用 send_request；已安装插件提供的请求使用对应插件命令，其参数、认证和业务结果结构以插件帮助为准。不能只看 HTTP 成功判断业务成功。

需要托管身份的接口使用已安装的专用能力插件，不手工传入其管理的凭据。协议与任务匹配见[相关 Skill 路由](./related-skills.md)。

multipart 文件路径属于 native-host 所在机器；调用方不能引用远端文件时用 base64。`send_request` 还支持 `bodyFile: {filePath, contentType}` 或 `{base64, contentType}` 直接发送原始二进制（不封装 multipart）；与 body、formData、files 互斥，不支持 GET/HEAD。本地文件上限 40 MiB，Base64 解码上限 7 MiB。身份插件的文件路径属于插件执行宿主，两者不能混用。扩展模式 send_request 的 Cookie 不离开扩展；二进制响应按 bodyType=base64 解码保存，不作为大段文本载入。

## 域权限失败

send_request 报 Cookie access not authorized / Permission denied / Host permission missing 时，按错误中给出的纯主机名调用 request_permission。用户在弹窗决定，只有 granted=true 才重试原请求；拒绝/关闭/超时则停止该次重试并说明缺少域授权。独立身份插件遵循自身权限流程。

## 请求规则的作用域

用 set_rule 添加规则，get_rules 回查；删除时使用 enabled=false 和 ruleId。扩展规则持久化，CDP 请求头规则属于当前会话；CDP 只支持 modifyHeaders 的请求头 set。按当前后端和 Provider 能力选择，不假定所有模式支持重定向、屏蔽或响应头改写。

## Mock 场景与回查

完整 mockData 适合替换响应，fields 适合基于真实响应微调。需要同一接口多种情况时用 conditions 子集匹配，按业务入参隔离；无条件规则会覆盖。$index 从 0 起描述同一场景调用顺序，不作为业务请求字段匹配。

用 get_mocks 回查目标 tabId 的配置，然后触发页面业务请求验证效果。设置成功不等于页面已收到 Mock。`session_manage --session <sessionId> --payload '{"operation":"end"}'` 默认保留 Mock；不带 `--session` 的浏览器级释放会清理依赖调试连接的 Mock，保持 Mock 终态时保留环境。禁用目标 Mock 用 enabled=false。

## 大 payload 与文件引用

整包参数用 --payload-file；某个大字段用顶层字符串 "@<绝对路径>"，客户端优先解析文件为 JSON，失败时用原文本。只展开顶层，不递归；读不到文件时保留字符串。文件展开仍走原传输通道，不绕过消息大小限制。
