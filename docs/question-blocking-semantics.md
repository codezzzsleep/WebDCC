# 原生提问的阻塞标记与实际等待状态

`QuestionItem.isBlocking` 保存原生请求的 boolean。旧事件没有该字段时按阻塞问题处理；`false` 表示不能仅凭这张问题卡把会话判定为 waiting，并不证明模型已经继续。网页标注“原生标记为非阻塞”，仍提供回答操作。

实际 Codex `thread/status/changed` 是独立的状态来源：当前原生 thread 的 `activeFlags` 包含 `waitingOnUserInput` 或 `waitingOnApproval` 时，`status.source='native-thread'` 的观察使运行时、TurnTracker 和最后活动 TurnView 保持 waiting，即使问题标记为 false。flags 清空或 idle 更新清除观察到的等待标记；idle 不伪造当前 Web 轮次已结束。`notLoaded` 是观察者本地状态，不被当作执行结束或继续的证明。其他 thread 的通知不改变本会话。

同步反向请求需原生 `serverRequest/resolved` 才确定回答或取消。不会根据 deprecated `autoResolutionMs` 推算过期、关闭卡片或制造原生结果。问题自身引起的 waiting 只针对当前 Web 轮次或 session-scoped 交互；旧轮请求、迟到更新和旧轮确认保留原身份与可查看卡片，不能改变新轮状态。Watchdog 对尚未确认的旧 blocking 请求保留原有保守保护，nonblocking 请求不单独阻止自动恢复。

Codex 会话连接协商 `initialize.capabilities.experimentalApi=true`，使用独立 `--experimental` 导出合同读取 `collaborationMode/list`；标准 schema 保留不变。兼容范围见适配器版本合同，异步提问的新增验收固定使用已审查的 0.169.0 与其真实 gpt-6.1-sol 模型目录。API 协商不写用户配置，也不打开 `default_mode_request_user_input` 等功能开关。Plan 可以调用旧同步 `request_user_input`；Default 中该旧工具是否可用依赖原生开关。**这不表示 Default 不能提问**：0.169.0 的 `request_user_input_async` 是独立工具，依赖根线程、user-input 设置和原生模型目录声明，无 Plan 限制。

输入框的 Codex 工作方式用于选择默认执行或先做计划，独立于提问、输入类型、权限和思考强度。选择附在当前输入的 `contentParts.collaborationMode` 中，随持久命令、排队输入和草稿保存；模式不改变用户正文。送给原生的 `turn/start.collaborationMode.settings` 保留实际模型/思考强度，`developer_instructions:null` 使用原生内置指令。选择模式前须取得真实目录确认；介入已有轮次不改变模式。刷新加载草稿时等待会话 Agent 身份，避免暂缺元数据把 Codex 选择误当作其他 Harness 草稿清除。原生 `thread/settings/updated` 和 start/resume 返回值提供实际模式观察；没有观察时显示待确认，配置选择不冒充已生效状态。

`request_user_input_async` 通过原生 `agentMessage.delivery=async` 及 `questions: [{title, options?: string[]}]` 发送问题，同时返回 `accepted=true` 给模型并继续执行。它不产生同步 `item/tool/requestUserInput` 请求。WebDCC 保留每题原生身份 `JSON.stringify(['request_user_input_async', itemId, questionIndex])`，显示单选或自由文本问题卡，并保留实际运行状态。收到问题、原生轮次结束和用户点击按钮都不代表已经收到答案。

异步回答使用原生 `<send_user_message_question_reply>` JSON 封装，包含 `questionItemId / question / answer`，走现有持久输入、排队和介入流程。运行中默认尝试介入，也可选择排队回答；空闲时产生新轮普通输入。完整原生 userMessage 回显与持久命令的原生接收记录匹配后，才标记已收到回答。没有接收证据时保留排队、失败或待核对状态，不能仅凭 RPC 成功关闭卡片，也不能盲目重发。多题各自独立回答；异步题目不套用同步 RPC 的整组聚合。

Claude 的 `AskUserQuestion` 按原题文本回填答案，多选为原生逗号分隔字符串。各题先汇总，完整提交后继续等待匹配的 SDK `user.tool_result` 才标记已回答；其他工具结果不能关闭问题。取消也依据真实工具结果，保留原问题文本。原生轮次结束但缺少问题结果时只标记结果未确认，阻止旧按钮再提交。DSH 保留原生问题身份、多选及自由文本，并在原生取消/晚答确认中保留原题和分组。

隔离回归覆盖 Codex 生产 request/notification handlers、原生回答格式、旧字段兼容、当前/旧轮/session 归属、实际等待优先级与清除、TurnTracker/活动归约，以及真实 Chromium 的问题标识、回答、确认和刷新恢复。测试文件包括 `question-blocking.spec.ts`、`handler.spec.ts`、`turn.spec.ts`、`turn-tracker.spec.ts` 与新增浏览器场景；不操作部署或付费服务。

`pnpm exec tsx scripts/verify-native-questions.ts --binary <Codex 0.169.0 可执行文件> --report <证据 JSON>` 使用真正的 Codex / Claude SDK 0.3.322 + CLI 2.1.322 / DSH 0.2.2-rc.1 与 Chromium。免费本机模型只安排原生工具调用。完整入口独立要求下列场景，任何正向工具未触发、JS 工具调用错误或目录不匹配都失败：

| 场景 | 原生与页面断言 |
| --- | --- |
| Plan + 同步 | 两题原生 RPC、整组原样回答、原生确认、继续及刷新 |
| Default + 旧同步开关关闭 | 旧工具原生不可用，单独作为负向回归，不代表 Default 没有提问能力 |
| Default + 旧同步开关开启 | 默认工作方式中的真实同步请求、回答与确认 |
| Default + async 空闲回答 | 不切 Plan，原生模型目录命名空间工具、两题稳定身份、先继续后新轮接收答案 |
| Default + async 终态收敛窗口 | 原生已结束而 WebDCC 尚在收敛时立即提交第二答案，安全排队并实际接收，不能错误介入已结束轮次 |
| Default + async 运行中介入 | 原生 turn/steer 收到问题答案，模型下一请求含原身份和原样文本 |
| Default + async 运行中排队 | Chromium 排队按钮、刷新期间不假显示已回答、随后原生 turn/start 接收 |
| Default + async 原生直接回答与旧网页排队 | 绕过网页命令的真实 native steer 回显使旧网页 command/input_queue 持久取消，旧答案不再次发送，刷新不复活；此场景不声称独立 OS 客户端 |
| Default + async 恢复 | 实际文件 SQLite、关闭服务和原生连接后重新打开，一题已回答、一题仍可回答 |
| Default + async 停止 | 停止原轮不编造答案接收，之后通过普通输入回答 |
| Claude / DSH 及取消 | 原生多题、多选、回答确认、停止与刷新，独立于 Codex 工作方式 |

`verify-native-codex-async.ts` 可单独执行异步场景。它使用原生 0.169.0 的实际 gpt-6.1-sol 目录，不替换目录、不注入原生事件、不替换 adapter；Responses fixture 按真正的 `functions.request_user_input_async` 调用格式发送直接函数调用。`functions.exec` 的嵌套工具、命名空间直接函数及旧同步工具分开选择；异步工具不生成无效的 `tools.request_user_input_async` 脚本。每个成功或失败场景都保存原生帧、模型请求、Web 事件及浏览器动作，报告含版本、源码/协议/配置指纹和预期清单。

沿用原生工作方式时，app-server 的 `collaborationMode` 观测可能为空，页面仍保留“待确认”。异步验收从原生返回的线程 rollout 路径读取对应 `turnId` 的 `turn_context.collaboration_mode.mode`，要求实际为 `default`，并把该上下文保留在证据中；不会用空的页面观测推断模式，也不会为了通过测试修改产品中的实际状态。

MCP 独立使用 `verify-native-elicitation.ts`；同步工具开关、异步模式和 MCP 不能互相代替。上述场景也不等于 NP-06 的完整 secret、双原生客户端和所有断线/unknown 故障验收，不能关闭未覆盖范围或证明付费 Provider 的模型行为。实现、场景实测和部署分别记录。

刷新时缓存卡片可以先出现；显示缓存并不证明它仍可回答。问题和审批的提交控件、耐久答复的发件箱重放都等待会话回放及该交互状态完成核对。Hub 的 `snapshot.throughSeq` 记录此次实际回放的事件边界，不允许客户端据此跳过未读取的事件。重连会撤销此前的同步证明；最近事件窗口已经同步，也不能证明更旧的缓存问题在中间缺口内没有结束。

`GET /api/sessions/:id/interactions/:kind?interactionId=...` 是受现有认证保护的只读核对接口。它在同一个 SQLite 读事务中返回原始交互身份的最新真实事件和 `throughSeq`；`kind` 为 `answer` 或 `approve`。查询参数保留较长的身份及特殊字符，不改变身份，也不从交互索引、确认发送或缺失记录中制造回答结果。查不到事件时返回 `event: null`，缓存卡片继续禁止提交。晚到的 GET 不覆盖已经收到的新 WS 事件。“重新核对状态”只查询现有记录，不发送原生回答或恢复操作。

同步回归包括真实第二 SQLite WAL 写入者和真实 WS 回放边界，以及受控 Chromium 场景：缓存旧 MCP 问题、收到实际原生结束通知、追加 225 条事件，使结束记录落在最近 200 条之外；暂缓历史和单交互 HTTP 响应时，表单保持禁用，释放真实查询结果后才恢复为已结束，过程中没有新增原生回答。原有答复失败、双浏览器竞争、敏感值及刷新恢复测试保留真实原生输出断言，刷新后还独立核验收到的 WS 回放边界。
