# 原生提问的阻塞标记与实际等待状态

`QuestionItem.isBlocking` 保存原生请求的 boolean。旧事件没有该字段时按阻塞问题处理；`false` 表示不能仅凭这张问题卡把会话判定为 waiting，并不证明模型已经继续。网页标注“原生标记为非阻塞”，仍提供回答操作。

实际 Codex `thread/status/changed` 是独立的状态来源：当前原生 thread 的 `activeFlags` 包含 `waitingOnUserInput` 或 `waitingOnApproval` 时，`status.source='native-thread'` 的观察使运行时、TurnTracker 和最后活动 TurnView 保持 waiting，即使问题标记为 false。flags 清空或 idle 更新清除观察到的等待标记；idle 不伪造当前 Web 轮次已结束。`notLoaded` 是观察者本地状态，不被当作执行结束或继续的证明。其他 thread 的通知不改变本会话。

提问仍需原生 `serverRequest/resolved` 才确定回答或取消。不会根据 deprecated `autoResolutionMs` 推算过期、关闭卡片或制造原生结果。问题自身引起的 waiting 只针对当前 Web 轮次或 session-scoped 交互；旧轮请求、迟到更新和旧轮确认保留原身份与可查看卡片，不能改变新轮状态。Watchdog 对尚未确认的旧 blocking 请求保留原有保守保护，nonblocking 请求不单独阻止自动恢复。

本次只处理原生标记和观察到的状态，不在生产启用 experimental/underDevelopment feature，也不补造 Default/Plan mode 能力。Native 是否发出这类请求由其真实模式与功能声明决定。

隔离回归覆盖 Codex 生产 request/notification handlers、原生回答格式、旧字段兼容、当前/旧轮/session 归属、实际等待优先级与清除、TurnTracker/活动归约，以及真实 Chromium 的问题标识、回答、确认和刷新恢复。测试文件包括 `question-blocking.spec.ts`、`handler.spec.ts`、`turn.spec.ts`、`turn-tracker.spec.ts` 与新增浏览器场景；不操作部署或付费服务。

刷新时缓存卡片可以先出现；显示缓存并不证明它仍可回答。问题和审批的提交控件、耐久答复的发件箱重放都等待会话回放及该交互状态完成核对。Hub 的 `snapshot.throughSeq` 记录此次实际回放的事件边界，不允许客户端据此跳过未读取的事件。重连会撤销此前的同步证明；最近事件窗口已经同步，也不能证明更旧的缓存问题在中间缺口内没有结束。

`GET /api/sessions/:id/interactions/:kind?interactionId=...` 是受现有认证保护的只读核对接口。它在同一个 SQLite 读事务中返回原始交互身份的最新真实事件和 `throughSeq`；`kind` 为 `answer` 或 `approve`。查询参数保留较长的身份及特殊字符，不改变身份，也不从交互索引、确认发送或缺失记录中制造回答结果。查不到事件时返回 `event: null`，缓存卡片继续禁止提交。晚到的 GET 不覆盖已经收到的新 WS 事件。“重新核对状态”只查询现有记录，不发送原生回答或恢复操作。

同步回归包括真实第二 SQLite WAL 写入者和真实 WS 回放边界，以及受控 Chromium 场景：缓存旧 MCP 问题、收到实际原生结束通知、追加 225 条事件，使结束记录落在最近 200 条之外；暂缓历史和单交互 HTTP 响应时，表单保持禁用，释放真实查询结果后才恢复为已结束，过程中没有新增原生回答。原有答复失败、双浏览器竞争、敏感值及刷新恢复测试保留真实原生输出断言，刷新后还独立核验收到的 WS 回放边界。
