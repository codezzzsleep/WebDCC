# DSH 子会话输入与接收恢复

关联 #53/#16/#52/#66（仅 DSH）/#42。前置 #225/#236/#245，由既有窗口完成合并；本专项继续独立 PR。

DSH 仍锁定 `0.2.2-rc.1`。实际编译 Host fcc0ad4 的 `subagents/prompt` 请求为 `{request:{requestId,childSessionId,delivery,content,clientTimeZone?}}`，返回 `{messageId}`。停止的 child-only wire 已在 #245 显式复核。此 PR 仅更新 prompt 单 descriptor 与库存，保留其他冻结合同；实际 descriptor、载体/Host/hash和原生拒绝回执见 [原生合同证据](../fixtures/dsh/subagent-prompt-contract.json)。旧父地址字段在这个 decoder 上被忽略，不能写成原生 HTTP400 或当作权限依据。

原生 `requestId` 会归属到实际用户消息，但每次调用都创建新 `messageId`。因此 WebDCC 在任何原生副作用前保存命令和服务器选择的父/子身份、正文哈希及 native cursor；同命令重试不重新发送，换正文/目标/delivery不能复用身份。接收 ACK 只证明 inbox 已接受消息，子执行的运行/等待/结果由实际子状态和历史独立显示。

原生 ACK 丢失后，WebDCC 从同父子地址的 queue，或固定当前 cut 的分页 `user/message`，核对原生 requestId、原样正文哈希及发送前水位。只有匹配的原生 MessageId 才完成接收回执；未知结果保留，重试不会盲目重发已受理输入。冷父输入和查询不激活父 Agent 或建立其 writer。原生 live tree root 不可用时，实际 Host 返回 `subagent/delivery-unavailable`，保留原生拒绝和正文；恢复 root 的可用性仍需正常原生连接，不能补造父 prompt 或修改工具/权限使其通过。

子会话拥有独立文本草稿和待确认命令；刷新先查回执，接收确认后清除已发送正文，保留后来编辑的草稿。queue 按原生顺序处理，steer 保留 nearest-step 与 best-effort fallback。界面明确区分未提交、正在提交、原生已接收、未确认和原生拒绝；已接收不意味着子执行已完成。一次性/外部/未知模式保留独立控制限制。

源码 HTTP/WS producer 与 Chromium 回归是受控证据。实际无模型冷 root 拒绝、兼容真实轨迹复用、新 live provider 与目标平台验证分别记载；原始两项重复/steer失败以及后续错误分页计数保留，不计成通过。本窗口只开发、验证并提交 PR；合并、Issue关闭和生产部署由既有Owner完成。
