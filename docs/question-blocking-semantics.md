# 原生提问的阻塞标记与实际等待状态

`QuestionItem.isBlocking` 保存原生请求的 boolean。旧事件没有该字段时按阻塞问题处理；`false` 表示不能仅凭这张问题卡把会话判定为 waiting，并不证明模型已经继续。网页标注“原生标记为非阻塞”，仍提供回答操作。

实际 Codex `thread/status/changed` 是独立的状态来源：当前原生 thread 的 `activeFlags` 包含 `waitingOnUserInput` 或 `waitingOnApproval` 时，`status.source='native-thread'` 的观察使运行时、TurnTracker 和最后活动 TurnView 保持 waiting，即使问题标记为 false。flags 清空或 idle 更新清除观察到的等待标记；idle 不伪造当前 Web 轮次已结束。`notLoaded` 是观察者本地状态，不被当作执行结束或继续的证明。其他 thread 的通知不改变本会话。

提问仍需原生 `serverRequest/resolved` 才确定回答或取消。不会根据 deprecated `autoResolutionMs` 推算过期、关闭卡片或制造原生结果。问题自身引起的 waiting 只针对当前 Web 轮次或 session-scoped 交互；旧轮请求、迟到更新和旧轮确认保留原身份与可查看卡片，不能改变新轮状态。Watchdog 对尚未确认的旧 blocking 请求保留原有保守保护，nonblocking 请求不单独阻止自动恢复。

本次只处理原生标记和观察到的状态，不在生产启用 experimental/underDevelopment feature，也不补造 Default/Plan mode 能力。Native 是否发出这类请求由其真实模式与功能声明决定。

隔离回归覆盖 Codex 生产 request/notification handlers、原生回答格式、旧字段兼容、当前/旧轮/session 归属、实际等待优先级与清除、TurnTracker/活动归约，以及真实 Chromium 的问题标识、回答、确认和刷新恢复。测试文件包括 `question-blocking.spec.ts`、`handler.spec.ts`、`turn.spec.ts`、`turn-tracker.spec.ts` 与新增浏览器场景；不操作部署或付费服务。
