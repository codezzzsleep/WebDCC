# 原生提问的阻塞标记与实际等待状态

`QuestionItem.isBlocking` 保存原生请求的 boolean。旧事件没有该字段时按阻塞问题处理；`false` 表示不能仅凭这张问题卡把会话判定为 waiting，并不证明模型已经继续。网页标注“原生标记为非阻塞”，仍提供回答操作。

实际 Codex `thread/status/changed` 是独立的状态来源：当前原生 thread 的 `activeFlags` 包含 `waitingOnUserInput` 或 `waitingOnApproval` 时，`status.source='native-thread'` 的观察使运行时、TurnTracker 和最后活动 TurnView 保持 waiting，即使问题标记为 false。flags 清空或 idle 更新清除观察到的等待标记；idle 不伪造当前 Web 轮次已结束。`notLoaded` 是观察者本地状态，不被当作执行结束或继续的证明。其他 thread 的通知不改变本会话。

提问仍需原生 `serverRequest/resolved` 才确定回答或取消。不会根据 deprecated `autoResolutionMs` 推算过期、关闭卡片或制造原生结果。问题自身引起的 waiting 只针对当前 Web 轮次或 session-scoped 交互；旧轮请求、迟到更新和旧轮确认保留原身份与可查看卡片，不能改变新轮状态。Watchdog 对尚未确认的旧 blocking 请求保留原有保守保护，nonblocking 请求不单独阻止自动恢复。

Codex 0.167.0 的会话连接现在协商 `initialize.capabilities.experimentalApi=true`，并使用该固定 binary 的独立 `--experimental` 导出合同读取 `collaborationMode/list`。原标准 schema 保留不变。这是 API 协商；不写用户配置，也不打开 `default_mode_request_user_input` 等原生功能开关。该版本的 Plan 可发起原生提问，未开启对应原生功能的 Default 会返回不可用。

输入框提供“沿用原生 / 默认 / 计划”。选择附在当前输入的 `contentParts.collaborationMode` 中，随持久命令、排队输入和草稿保存；模式不改变用户正文。送给原生的 `turn/start.collaborationMode.settings` 保留实际模型/思考强度，`developer_instructions:null` 使用原生内置指令。选择模式前须取得真实目录确认；介入已有轮次不改变模式。刷新加载草稿时等待会话 Agent 身份，避免暂缺元数据把 Codex 选择误当作其他 Harness 草稿清除。原生 `thread/settings/updated` 和 start/resume 返回值提供实际模式观察。

Claude 的 `AskUserQuestion` 按原题文本回填答案，多选为原生逗号分隔字符串。各题先汇总，完整提交后继续等待匹配的 SDK `user.tool_result` 才标记已回答；其他工具结果不能关闭问题。取消也依据真实工具结果，保留原问题文本。原生轮次结束但缺少问题结果时只标记结果未确认，阻止旧按钮再提交。DSH 保留原生问题身份、多选及自由文本，并在原生取消/晚答确认中保留原题和分组。

隔离回归覆盖 Codex 生产 request/notification handlers、原生回答格式、旧字段兼容、当前/旧轮/session 归属、实际等待优先级与清除、TurnTracker/活动归约，以及真实 Chromium 的问题标识、回答、确认和刷新恢复。测试文件包括 `question-blocking.spec.ts`、`handler.spec.ts`、`turn.spec.ts`、`turn-tracker.spec.ts` 与新增浏览器场景；不操作部署或付费服务。

`pnpm exec tsx scripts/verify-native-questions.ts --binary <Codex 0.167.0 可执行文件> --report <证据 JSON>` 使用真正的 Codex / Claude SDK 0.3.322 + CLI 2.1.322 / DSH 0.2.2-rc.1 与 Chromium。免费本机模型只安排原生工具调用，验证多题、原样自由文本、适用的多选、原生确认、继续、停止和刷新；Default 不可用单独断言。证据包含固定版本、源码/协议/配置指纹与预期场景列表，失败和未完成不计通过。此范围不等于 NP-06 的完整 MCP/secret/双原生界面/重启验收，也不证明付费 Provider 的模型行为。

刷新时缓存卡片可以先出现；显示缓存并不证明它仍可回答。问题和审批的提交控件、耐久答复的发件箱重放都等待会话回放及该交互状态完成核对。Hub 的 `snapshot.throughSeq` 记录此次实际回放的事件边界，不允许客户端据此跳过未读取的事件。重连会撤销此前的同步证明；最近事件窗口已经同步，也不能证明更旧的缓存问题在中间缺口内没有结束。

`GET /api/sessions/:id/interactions/:kind?interactionId=...` 是受现有认证保护的只读核对接口。它在同一个 SQLite 读事务中返回原始交互身份的最新真实事件和 `throughSeq`；`kind` 为 `answer` 或 `approve`。查询参数保留较长的身份及特殊字符，不改变身份，也不从交互索引、确认发送或缺失记录中制造回答结果。查不到事件时返回 `event: null`，缓存卡片继续禁止提交。晚到的 GET 不覆盖已经收到的新 WS 事件。“重新核对状态”只查询现有记录，不发送原生回答或恢复操作。

同步回归包括真实第二 SQLite WAL 写入者和真实 WS 回放边界，以及受控 Chromium 场景：缓存旧 MCP 问题、收到实际原生结束通知、追加 225 条事件，使结束记录落在最近 200 条之外；暂缓历史和单交互 HTTP 响应时，表单保持禁用，释放真实查询结果后才恢复为已结束，过程中没有新增原生回答。原有答复失败、双浏览器竞争、敏感值及刷新恢复测试保留真实原生输出断言，刷新后还独立核验收到的 WS 回放边界。
