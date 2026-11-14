# WebDCC 深度代码审查与原生功能差距评估

**审查基线：** codezzzsleep/WebDCC，提交 9b1ae9096c19162206361e3910b7ef2592c5f30b。本文中的仓库链接全部固定到这个提交；结论不自动适用于未来版本。

**审查日期：** 2026-11-14（Asia/Shanghai；UTC为2026-11-13）。实施要求见配套 WebDCC_NATIVE_PARITY_SPEC.md，逐项行数、文件数和约束见 WebDCC_IMPLEMENTATION_CONSTRAINTS.md。

**结论：WebDCC 已有值得保留的真实 Agent 接入和产品基础，但尚不能作为“三个 Agent 全部原生功能的可靠 Web 替代”。应先修复原生语义、持久化和验收可信度，再逐层扩展能力；目前没有充分理由整仓重写。**

这次审查没有修改项目业务代码，没有调用真实模型，也没有把历史验收报告视为当前提交已经完成的验收。以下“已复现”主要指执行真实源代码、以受控输入或替身传输复现机制；真实 Agent、真实账号和浏览器全链路仍有单独的验收门槛。

## 一、项目到底要做什么，现在处于什么阶段

项目的核心目标是：在个人 Linux 服务器上运行三个彼此独立的原装 Agent，让用户用一个网页管理会话、发送消息、观察工具和文件变化、处理审批、跨会话手动交接，并在公网弱网环境下继续工作。Codex 使用 app-server JSON-RPC，Claude 使用 Agent SDK，DSH 使用原生 Web Host API / remote.mux；WebDCC 自己承担浏览器界面、会话组织、事件存储、认证、同步和文件服务。[README:3–38][readme] [SPEC:53–81][goals]

因此，它并非简单的“多模型聊天页面”。模型提供文字生成，Agent 负责工具、权限、工作区、任务和运行状态；WebDCC 必须忠实连接这两层。底层确实在运行原装 Agent，是项目的重要价值。但“Agent 能调用用户原有工具”与“浏览器能发现、配置、观察、操作这些能力”是不同的完成标准。

当前有真实实现的功能包括三栏响应式界面、会话 URL、流式消息、简单审批和问答、计划/任务/目标展示、文件和 diff、Provider、附件、离线缓存、发件箱、DSH attach 等。与此同时，关键可靠性路径存在确定缺陷，模型和权限目录有硬编码，原生专有能力大量没有完整入口，历史验收证据也不足以证明全部完成。[README:13–22][readme-state]

更关键的是：**用户现在要求的“Web 体验全部原生功能”，比旧 SPEC 的目标大得多。** 旧文档明确排除了原版 DSH Web、PTY 终端、平台外原生会话导入。这些遗漏有一部分是原设计范围，不应全部归咎于实现质量。新 SPEC 应明确替代这些非目标，同时保留“不静默注入提示词、工具、插件和配置”的原则。用户主动在原生设置页修改配置，则应成为有作用域、有预览和结果反馈的正式能力。[SPEC:85–112][non-goals]

### 对“做得怎么样”的判断

| 维度 | 判断 | 依据与含义 |
|---|---|---|
| 产品方向 | 有明确价值 | 三种真实运行时统一进入浏览器，远程会话与文件工作流有实际需求 |
| 基础架构 | 可保留、需要收紧边界 | workspace、独立 adapter、事件库和纯 reducer 方向正确 |
| 当前功能可靠性 | 尚不足以作为完整替代 | 已发现消息重复、接受后队列丢失、答案吞掉、权限显示与原生不一致 |
| 原生功能覆盖 | 部分接入，差距显著 | 简单统一 UI 无法表达全部原生交互、任务、插件和配置 |
| 工程验证 | 有投入，但证明力被高估 | 快速测试可通过；若干测试未真正执行其标题声明的动作 |
| 是否应推倒重写 | 不建议 | 问题集中在协议、状态与生命周期边界，可逐步替换；重写会丢失已有集成资产 |

上述判断的具体证据见后文 F01–F24，不用一个主观评分代替实现事实。

## 二、审查范围、证据等级与本次验证

阅读范围包括共享协议、三家 adapter 及锁定协议资料、服务端 manager/dispatcher/hub/store/rest/auth/files、Web store/Composer/Timeline/Trajectory/任务与停靠区，以及单元测试、快速 E2E、真实 Agent 验收脚本、M8/M9 报告和 33 份轨迹。仓库 AGENTS.md 引用的私有 Project Memory 不在本环境，本次没有使用或修改该私有内容。

本次统计的手写生产代码约 **87 个文件、17,863 物理行**，测试约 **63 个文件、5,779 行**；另有大量生成的 Codex schema、脚本、夹具和截图。物理行包括空行与注释，不等于复杂度或投入量。1701 个受 Git 跟踪文件也不能直接当成业务规模。统计快照曾记录安装工具临时修改的 pnpm-workspace.yaml；该行随后已恢复，不能据此认定交付时仍有该改动。证据见本次 metrics.json。

| 证据等级 | 本文用法 | 能证明什么 |
|---|---|---|
| A：源码机制或本地受控复现 | 明确标为“静态确定”“已复现” | 输入输出、状态转移、协议形状、响应头等具体事实 |
| B：锁定原生协议与现有轨迹 | 标明 schema/catalog/fixture | 当前适配器是否符合仓库锁定合同；不能替代当前真实运行 |
| C：代码推导的风险 | 明确写“推断”“尚未实测” | 某故障窗口为何可能出问题，不宣称实际发生过 |
| D：未验证 | 明确列为后续验收 | 真实模型、真实账号、完整浏览器、跨设备及长期运行效果 |

本次执行结果如下，原始记录收录于交付证据目录：

| 检查 | 结果 | 解释边界 |
|---|---|---|
| 直接 Node 调用现有测试 | 30 个测试文件、152 项通过 | 证明这些断言通过，不证明全部原生能力 |
| TypeScript | 10 个 tsconfig 通过 | 无法发现经宽泛对象或类型断言绕过的原生协议错误 |
| ESLint、Web 构建、Server 构建 | 通过 | 证明静态检查和构建完成 |
| L1 轨迹回放 | 33 traces、3681/3681 帧检查通过 | 存在 F23 的检查盲区 |
| 轨迹敏感信息扫描 | 0 命中 | 仅指现有扫描规则，不能证明任意秘密均被清除 |
| 浏览器快速 E2E | 26 项均阻塞在 Chromium 启动 | socket EPERM 属于环境限制；不是 26 项业务功能失败，也没有获得通过证据 |
| 标准 pnpm 开发入口 | 未完整证明 | 环境 pnpm 11.25 与声明 12.18 不同，安装曾提示忽略 better-sqlite3 构建；后续采用直接入口验证 |
| 真实 Agent / 真实模型 | 未执行 | 没有验证原生账号、收费调用、真实权限效果和终端 UI |

本次重要复现包括并发相同命令执行两次、已确认的内存队列在 dispose 后丢失、上传 HTML 的响应头、自由文本答案为空、Claude 多内容块重复、历史加载失败却推进游标、空快照保留陈旧状态。分别见 core-repro.log、adapter_gap_reproduction.jsonlog、audit_web_repro_results.json。

## 三、应该保留的资产

第一，三家独立 adapter 是合理边界，不应合并为到处判断 agent 名称的巨型控制器。真实运行时和原生配置继承已经打下基础，后续应加强类型合同与生命周期，而非另造一套 Agent。

第二，SQLite 追加事件、原始数据保留方向、IndexedDB 缓存、统一轮次 reducer、轨迹回放和文件版本检查都值得保留。它们提供恢复、诊断、跨设备和测试的支点。当前缺口主要是“何时确认”“如何合并”“谁是权威状态”，不是必须更换数据库或 React 框架。[服务端存储][server-store] [轮次归约][turn-reducer] [文件编辑][file-editor]

第三，已有 UI 和测试投入不是无效劳动。会话布局、Markdown、diff、文件编辑、Provider 页面和浏览器缓存可以继续使用；33 份轨迹也有回归价值。需要修正的是测试宣称与真实触发之间的关系，以及测试与生产采用不同逻辑的问题。

## 四、24 项优先缺陷

**优先级定义：** P0 表示在承诺可靠远程使用前必须处理的发布阻断项，包括数据丢失、危险的权限误报或主动内容隔离；它不是 CVSS 评分，也不意味着每项都是远程漏洞。P1 是核心原生语义或恢复能力缺陷；P2 是覆盖、可诊断性、规模或体验缺口。

### F01 · P0 · Codex 权限切换使用错误字段，页面成功不等于原生生效

**静态确定并复现参数。** adapter 的 accessParams 返回 sandbox，turn/start 直接复用；锁定的 TurnStartParams 要求结构化 sandboxPolicy。setAccessMode 只缓存后返回，服务端随后持久化并广播。只读参数复现中没有 sandboxPolicy。另一个问题是 manager 在未指定权限时取第一档，覆盖了“沿用原生默认”的语义。影响可能是原生忽略或拒绝字段，尚未实跑原生进程证明实际越权。应拆分 thread/turn 参数构造，区分 inherit、requested、effective，并验证原生实际策略。[codex/adapter.ts:71–89][codex-access] [396–406][codex-turn-params] [schema:43–50][turn-start-schema] [manager.ts:145–158][default-access] [494–504][effective-access]

### F02 · P0 · DSH Provider 的异常降级会改错配置目标并损坏模型列表

**静态确定，字符串变换已复现。** REST 捕获特定错误文本后直接改 WebDCC 本机 DSH_HOME 下 YAML，未确认这是当前 attach Host 的配置。重写依据是旧默认模型而非正在编辑的模型，还可能把未传 reasoningEfforts 当成清空。受控输入出现 model-a 消失、model-b 重复、原思考档位被删除。应移除异常 catch 内隐式写文件，优先使用原生 settings；必须编辑文件时采用 AST、目标身份、版本比较、原子写入与回滚。[rest.ts:622–654][dsh-settings-route] [dsh-settings.ts:53–158][dsh-settings-file]

### F03 · P0 · 上传的主动 HTML 与应用共源返回，缺少执行隔离

**响应头已复现。** 上传文件 MIME 进入 /files 响应；HTML 返回 text/html，未设置 Content-Disposition、CSP 或 nosniff。受认证用户打开不可信 HTML 时，浏览器可能在应用源下执行脚本并使用现有会话。前提是用户已登录且打开该内容；本次没有证明未认证远程执行或完整浏览器攻击链。应按内容分类，主动文档使用独立源或强制下载，受控预览采用 CSP sandbox，并明确允许的 MIME。[rest.ts:808–828][files-route] [app.ts:58–67][auth-hook]

### F04 · P0 · 相同 clientCommandId 的并发请求仍会执行两次

**已复现。** dispatcher 先读完成结果，再 await execute，最后记录；两个连接同时进入可都看到“不存在”。复现同 ID 得到两个不同 turnId，一个开始、一个入队。单条 WebSocket 的串行处理无法提供跨连接幂等。应在副作用前持久认领命令，校验 ID 与 payload 一致，维护执行状态，并在原生支持时使用原生请求身份对账；不能把外部执行的绝对 exactly-once 作为无条件保证。[dispatcher.ts:25–34][dispatcher] [hub.ts:123–135][hub-command]

### F05 · P0 · 服务端确认接受后，队列消息仍可能丢失

**dispose 模型已复现；完整进程 kill 未执行。** 忙碌会话将消息放入 runtime.queued 并返回成功；尚未落为 user.message。浏览器收到成功便删 outbox。清除 runtime 后队列消失，但命令结果还在，再发同 ID 只取回旧成功。应把 payload、队列顺序和状态先可靠落盘，再 ACK accepted；恢复时重建队列，无法判断原生是否接收时显示待对账，避免盲重发。[manager.ts:303–341][manager-queue] [web/store.ts:253–268][web-ack] [server/store.ts:541–551][command-store]

### F06 · P1 · 网页填写的自由文本问题答案被吞掉

**真实源代码受控复现。** QuestionCard 发送 selected 和 custom；Codex、Claude 读取 value/selected/text，不读 custom，空 selected 数组还优先遮住文本。输入“Actual free text”后 Codex 实际产生空 answers 数组、Claude 空字符串。现有 adapter 测试使用另一种 value 形状，避开了此错配。应共享类型化答案结构，并从浏览器表单到原生响应做字段级验收。[Timeline.tsx:632–680][questions-ui] [codex/adapter.ts:678–681][codex-answer] [claude/adapter.ts:508–515][claude-answer]

### F07 · P1 · 不同原生反向请求被压成“允许”，返回协议不正确

**MCP 表单错配已复现。** Codex 未识别的反向请求默认进入 userInput，再被包装成 exec_command 批准卡；点击允许返回空 answers，无法满足 MCP elicitation 的 action/content 合同。权限变更、动态工具、认证等请求也不能共享这个兜底。当前公共交互模型还丢失部分权限范围、建议规则和 secret 标记。应以原生 method 建判别联合，保留请求与响应 schema；不支持的请求必须明确说明并符合原生拒绝协议。[codex/adapter.ts:994–1029][codex-requests] [ServerRequest.ts][server-request-schema] [events.ts:54–68][interaction-schema]

### F08 · P1 · 审批和问答没有一个可靠的权威生命周期

**问答投影已复现，其余为确定路径。** answered 作为新 item 写入，旧 pending 仍在轮次步骤中；刷新可能同时看到待答与已答。卡片先本地禁用，失败 ACK 没有恢复闭环；会话级允许还显示成“允许一次”。DSH 在原生答复成功前删除 pending，发送失败后无法重试；外部解决事件的 id/outcome 和取消分支也未完整归并。应以原生 requestId、session、epoch 建单一投影，处理 resolved/expired/cancelled/error，所有页面收敛到同一状态。[manager.ts:403–413][question-resolve] [Timeline.tsx:571–620][approval-ui] [dsh/adapter.ts:607–621][dsh-answer] [672–691][dsh-events] [873–891][dsh-resolution]

### F09 · P1 · 浏览器重连不能修复 DSH 原生连接，路径前缀也被丢弃

**静态确定；已关闭 socket 的关闭等待已受控复现。** DshHostClient 没有断线后的重连、重新认证与订阅恢复；adapter 只要 client 非空便返回。重新 attach 也没有为原会话全部恢复 follow。endpoint 被取 origin，部署于 /dsh/ 等前缀时路径消失。应独立管理原生连接状态机、退避、凭证过期、订阅游标和关闭幂等，保留 basePath；不能拿 WebDCC 自身的 WS 重连测试替代它。[host.ts:110–228][dsh-host] [adapter.ts:326–350][dsh-connect] [625–637][dsh-attach]

### F10 · P1 · DSH opening snapshot 和原生用户消息被忽略

**锁定合同与实现不一致。** session/follow 合同包含 opening snapshot，但 adapter 遇到 snapshot 直接返回，也忽略原生 user/message；resume 没有相应分页补齐。因此在原版 DSH 页面发生的输入、平台离线期间的历史和状态不能可靠进入 WebDCC。这不表示已存本地历史全部丢失。应以原生 session/seq/source identity 导入快照和分页，处理增量接缝并去重。[adapter.ts:481–519][dsh-resume] [690][dsh-snapshot] [899–900][dsh-user] [Host catalog:2514 起][dsh-follow-schema]

### F11 · P1 · DSH 子 Agent 按钮存在，但请求不符合已提交合同

**静态确定，未连接真实 Host 验证版本差异。** sendSubagent 将字段放在顶层，catalog 要求 request 包装、parentSessionId 和 mode；interrupt 调用 interruptByUser，而 catalog 声明 interruptByParent。UI 有按钮不等于动作可执行。应按锁定合同校验请求，保留父子身份和 continuable 模式，并从真实子会话完成 queue/steer/interrupt 验收。[adapter.ts:393–407][dsh-subagent] [catalog:19993–20135][dsh-subagent-schema] [Timeline.tsx:439–474][subagent-ui]

### F12 · P1 · Codex 原生自行继续的新轮次可能无法停止

**控制路径已复现。** turn/started 通知只发事件，没有更新 adapter 的 active turn；turnId 主要由主动 send 的响应赋值。注入原生 continuation 的 started 后调用 interrupt，没有发出任何 RPC。应由原生生命周期驱动 active turn 身份，结合运行实例 epoch，避免迟到完成覆盖新轮次；用户停止要能命中当前实际执行对象。[adapter.ts:644–659][codex-send-stop] [743–759][codex-native-turn]

### F13 · P1 · Codex 计划和 reasoning 的完成态可能覆盖成空

**已复现。** 锁定 schema 中 reasoning.summary 是字符串数组、plan 是 text；转换器却读取对象的 text 和 plan.items。有效 summary 转为空字符串，计划转为空 items；流式内容还可能在完成态被清空。应使用生成类型约束转换器，区分原生 Markdown 计划与结构化任务步骤，验证增量与完成态一致。[adapter.ts:319–370][codex-map] [ThreadItem.ts:45][codex-item-schema] [adapter.ts:927–933][codex-plan-delta]

### F14 · P1 · Claude 生产丢弃部分消息，回放却补造事件

**已复现生产与 replay 差异。** 非 init 的 system 消息以及未识别类型直接 return；compact_boundary 和 future 消息在生产 onEvent 中为空，replay 却额外制造 internal。于是“回放每帧都有输出”不能证明生产无丢失。独立 trace 可能保留原字节，不能扩大成所有数据不可恢复。应让生产与回放使用同一个纯转换器，每帧明确 visible/state-only/raw-only/unsupported，并给重要系统状态提供显示入口。[claude/adapter.ts:245–255][claude-replay] [654–666][claude-system] [839–848][claude-default]

### F15 · P1 · Claude 换模型可能恢复旧权限，旧实例消息缺少隔离

**旧配置复用已复现；跨实例混流是时序风险。** setAccessMode 改 SDK 却不更新 launchOpts；setModel 使用旧 launchOpts 重建同 native session。旧 pump 仍按 sessionId 查询当前 runtime，缺少逐消息 epoch 校验。应建立单一有效配置状态，明确切换是下一轮生效还是停止后切换；原子替换运行实例，排空旧流并拒绝旧 epoch 消息。[claude/adapter.ts:385–407][claude-pump] [444–469][claude-settings]

### F16 · P1 · Claude 多内容块重复，子 Agent 和任务身份不充分

**双文本块重复已复现。** 完成消息先拼接所有 textParts，再把整段写给每个 live item，两块 A/B 最终各显示 A+B。parent_tool_use_id 未成为独立 actor 路由；任务创建还在工具成功前猜 ID。子 Agent 交错污染需要进一步真实验证。应使用原生 session/actor/message/block 复合身份，任务以原生成功结果和实体 ID 归约；执行错误也应与用户中断区分。[claude/adapter.ts:719–773][claude-blocks-tasks] [839][claude-default]

### F17 · P2 · 模型、思考等级和权限能力不是统一的真实目录

**静态确定。** Codex/Claude listModels 基本返回硬编码项；Web effort 是静态集合；部分动态权限 profile 丢失 allowed/description，服务端仍用静态模式校验，导致显示出的选项可能不能提交。DSH 同名模型的 Provider 身份、preset 和命令结果也被压缩。应按 agent/version/provider/cwd/config 指纹发现并缓存 capability，明确 native default、可用原因及实际生效值。[codex/adapter.ts:481–530][codex-models] [claude/adapter.ts:282–304][claude-models] [Composer.tsx:42–43][composer-effort] [manager.ts:145–158][default-access] [dsh/adapter.ts:179–195][dsh-model-identity] [526–540][dsh-command-result]

### F18 · P1 · 历史请求失败仍推进同步游标，空快照保留旧状态

**执行真实 AppStore 已复现。** ensureSession 吞掉历史请求错误后仍订阅 serverLastSeq；第二次调用因会话已存在不重新加载。复现两次打开仅请求一遍历史，本地仍空，却都从 seq=100 订阅。snapshot 还把旧 hot 与新 hot 合并，空快照不能清除陈旧运行项。应分开“已知尾部”与“连续覆盖区间”，失败不越过缺口，权威快照按 generation 替换。[web/store.ts:368–378][web-history] [211–217][web-snapshot]

### F19 · P1 · 附件草稿、会话切换和上传提交缺少完整生命周期

**静态确定，尚未完成浏览器复现。** Composer 切换/恢复只加载文字，images 初始为空且没有对应恢复和切换清理，持久化又会写回这个数组。用户消息渲染也不显示其图片字段。Enter 直接调用 submit，而 submit 没有 uploading 守卫；上传重试耗尽和 complete 的 HTTP 错误缺少完整处理。应拆分草稿与上传控制器，异步结果绑定 session/generation，统一提交校验，刷新恢复附件身份与状态。[Composer.tsx:55–78][composer-draft] [176–206][composer-submit] [255–277][composer-upload] [399–402][composer-enter] [Timeline.tsx:133–143][user-message-ui]

### F20 · P2 · 同一内容在待发送、最终回答、交接和诊断视图中含义不同

**待发送空白已复现，其他为确定选择路径。** getTurns 把空 reduceTurn 结果覆盖到 pending turn，用户正文变空、日期变 1970；恢复 outbox 只恢复 Map。交接和 @ 另取最后 assistant 消息，没有统一使用最终回答投影；诊断轨迹只改 hash，未保证虚拟列表目标存在，部分无 turnId/internal 内容没有完整查看路径。应统一 selectors，保留 pending 正文和附件，提供按 seq 加载与展开的 Event Inspector。[store.ts:475–519][pending-projection] [App.tsx:199–203][handoff-selector] [Composer.tsx:793–797][mention-selector] [Trajectory.tsx][trajectory] [App.tsx:303–308][trajectory-navigation]

### F21 · P2 · 会话列表可能触发大量历史订阅，增量渲染存在放大

**机制确定，性能影响未做新基准测试。** 启动会订阅缓存中的所有会话；历史 created 通知也可能以 afterSeq=0 订阅，服务端再回放全部历史。全局 version 让各会话 getTurns 缓存失效，Trajectory 还全量遍历。现有首屏测试只限制 REST 页长，未约束 WS 总流量。应区分列表摘要、可见会话与活跃后台订阅，设回放和缓存预算，按会话增量更新投影。[web/store.ts:143–157][web-subscribe] [203][web-created] [437–496][web-turn-cache] [hub.ts:160–175][hub-history]

### F22 · P2 · 原生传输的 ID 合同与长驻资源管理需要收紧

**静态确定。** Codex RequestId 允许 string 或 number，RPC 只识别 number，adapter 还 Number(id)；字符串请求可能被误当通知或转成 NaN。Codex 与 DSH 将原始帧持续累积到数组，没有上限。长会话内存影响未实测，但常驻服务不应继承探针式无限录制。应保持 ID 原类型，使用有界诊断缓冲，分离 trace sink，补齐 spawn/handshake 失败后的关闭和超时。[rpc.ts:86–124][codex-rpc] [RequestId.ts][request-id] [dsh/host.ts:126–228][dsh-host]

### F23 · P1 · “33 条轨迹通过”没有证明目标审批和问答被触发

**当前夹具统计确定。** 三家 S04/S05 黄金轮次都没有 approval.request；Codex/Claude 的 S08 没有 question。trace-real 仍固定写 notTriggered=[]，参考最终文本又来自本身 adapter 输出。L1 把“转换没有输出”当成 deltaFrame，导致本该发现丢事件的检查得到豁免。应逐场景声明必须触发的原生行为，未触发单独报告，保留独立原生结果对照。[trace-real.ts:211–222][trace-recording] [l1-replay.ts:127–133][l1-exemption] [M9 场景定义][m9-spec]

### F24 · P1 · 旧报告和未真正执行目标动作的测试削弱了发布门禁

**静态确定。** accept-m9 读取旧 M8，只要求总数非零，没有绑定当前 commit 或执行 ratchet；accept-m8 在测试非零时提前退出，无法完成后面的合并比较，现有 boolean baseline 又不匹配 passed 字符串。NET-06 没重启正在使用的实例；上传续传测试只是暂停循环再继续。应验证报告的提交、版本与用例集合，真实执行目标故障；占位、未触发、环境阻塞都不能计通过。[accept-m9.ts:79–100][accept-m9] [accept-m8.ts:34–40][accept-m8-exit] [172–228][accept-m8-ratchet] [net.spec.ts:158–180][net-test] [m7.spec.ts:49–100][upload-test]

### 另外两个需要写入约束的边界

默认录制开启；当前字段/字符串脱敏不能保证识别模型输出中的任意秘密，也没有看到完整保留期限和配额策略。应明确开关、留存、导出、磁盘预算与敏感表单处理。安全检查还确认带合法 cookie 的外域 Origin 请求可被服务端接受，但没有建立浏览器跨站利用链，不能仅凭这一点宣称 CSRF 已实证。[config.ts:23–34][config] [interaction-recorder.ts:13–87][recorder] [app.ts:58–67][auth-hook]

Watchdog 默认关闭，但开启后会发送“继续”和平台构造的交接内容。它属于用户显式选择的自动化模式，应与原装透传模式分开标示，并修订旧文档中“不生成任何输入”的绝对表述；不能说它默认偷偷接管会话。[watchdog.ts:7–9][watchdog-default] [55–60][watchdog-prompt] [229–248][watchdog-send]

## 五、三种 Agent 的原生功能差距

下表的“部分”表示已有真实路径，但控制、语义、呈现或恢复未形成完整闭环；“继承”仅表示原生配置可能生效，不等于可从 Web 管理。表格基于上述代码审计及锁定 Codex schema、Claude SDK 声明、DSH Host catalog，不能将 API 数量换算为完成百分比。

| 能力族 | Codex 当前 | Claude 当前 | DSH 当前 | 要补齐的用户结果 |
|---|---|---|---|---|
| 对话、流式、停止、resume | 部分，continuation 停止有洞 | 部分，重启与归约有洞 | 部分，原生重连有洞 | 三层断线、取消、恢复语义一致 |
| 原生历史、搜索、fork/回退 | 主要限平台已有 nativeId | 未完整接原生历史接口 | snapshot/page 未闭环 | 可发现、导入、去重、分页；区分分叉与文本交接 |
| send/queue/steer | 主要本地排队 | 主要本地排队 | 固定 queue，控制不全 | 原生执行模式、队列编辑撤销、持久恢复 |
| 权限、审批、提问、elicitation | 简单路径，其他请求错配 | 简化 allow/deny、问答 | 基础路径，跨端/失败有洞 | 请求类型、范围、有效权限、过期和错误完整 |
| 模型、effort、服务档位、preset | 硬编码/元数据不全 | 硬编码/元数据不全 | 目录部分接入，preset 不全 | 使用当前运行时和账号的真实能力目录 |
| 计划、目标、任务 | plan 映射错，goal 主要只读 | 任务 ID 与状态不可靠 | 部分显示，控制不完整 | 原生实体 ID、编辑和控制、刷新后状态 |
| 子 Agent / 团队 | 工具摘要为主 | actor 隔离不足 | 有按钮但 wire 错 | 层次、独立轨迹、父权限、成员动作 |
| 长任务、后台 job、终端 | 缺完整进程控制 | task 消息和控制不全 | 缺 job/terminal 面板 | 完整日志、指定任务停止、原生交互输入 |
| 图片、文件、产物、富内容 | 部分通用卡片 | 非文本块覆盖不足 | 原生 file receipt/资源不足 | 附件身份、字节、完整输出和安全预览 |
| review、compact、上下文、slash | 多专有控制未接 | 部分命令可用，反馈丢失 | 命令执行结果被压缩 | 原生命令结果和进度；终端专属命令有入口 |
| skills/MCP/hooks/plugins | 配置继承，管理不足 | 配置继承，管理不足 | 原生插件生态管理缺 | 查看来源、生效状态、诊断、显式配置修改 |
| 文件 checkpoint/撤销 | 未完整接入 | 未完整接 SDK checkpoint | 按实际原生能力接 | 文件回滚与对话回退分开；不承诺任意命令通用撤销 |
| DSH 扩展业务 | 不强行套用 | 不强行套用 | 日程、Forge、账号、分享、语音、动态卡片等缺 | 按 Host 已安装插件发现，优先提供原版入口 |

Codex 仓库生成声明包含 109 个客户端方法、10 类反向请求、88 类通知；DSH catalog 包含 193 个 endpoint、34 个来源包。这说明“通用发送/停止/审批”之外有很大的协议空间，不能据此认定每个接口都是用户功能、每个插件都已安装，或简单计算“支持百分之几”。[Codex ClientRequest][client-request-schema] [ServerRequest][server-request-schema] [ServerNotification][notification-schema] [DSH catalog][dsh-catalog]

## 六、测试真实性：哪些证据有价值，哪些结论不能推出

### 历史报告不能代表当前 HEAD

| 仓库证据 | 报告自身提交 | 实际记载 |
|---|---|---|
| M8/report.json | 01a48ab29a88 | expected 125、executed 15、passed 15 |
| M8/pass-1.json | fc800e1295b3 | expected 138、executed 40、passed 32 |
| M9/report.json | 4080e264c74e… | 33 traces、3681 帧、33/33 replay UI，同时引用 M8 的 15/125 |
| 当前 e2e-real/stubs.spec.ts | 本次 HEAD | 58 条显式 NOT IMPLEMENTED 占位 |

这些数字来自文件本身，不是本次重新完成的真实 Agent 验收。M9 原版 DSH 收起/展开截图仍是待补占位；现有截图不能直接证明所有最新原生功能对等。[M8 报告][m8-report] [M8 pass-1][m8-pass] [M9 报告][m9-report] [占位测试][m8-stubs] [DSH 对照页][dsh-comparison]

### 当前轨迹覆盖的是“录到的行为”，不一定是“场景想测的行为”

对 33 份 expected.turns.json 统计，各家 11 份、12 轮：Codex 11 完成/1 中断，Claude 7 完成/5 中断，DSH 11 完成/1 中断。审批请求三家均为 0；question 只有 DSH S08 的 1 个。Claude 一些目标场景最终 interrupted，现有回放仍可因为“终止态合法”而通过。[轨迹目录][traces] [回放 UI 测试][replay-ui]

正确的验收记录应区分：能力在该版本可用、是否真实触发、是否执行用户动作、原生是否接受、网页是否正确呈现、刷新/断线后是否恢复。FakeAdapter 能验证 UI 和同步机制，真实帧能验证转换器；两者都不能替代真实 Agent 的权限、认证、任务和文件副作用验证。生产与 replay 必须共用转换逻辑，不能靠测试分支补造证据。

本次没有获得：真实三家模型工作流、浏览器视觉和无障碍完整验证、跨账号/Provider 兼容性、实际 kill 后重启恢复、长时内存和万级会话负载、真实 PTY handoff、原版 DSH 反向代理和原生插件全功能。新 SPEC 应把这些作为独立可执行门槛。

## 七、重构判断与建议边界

**需要重构，但应按责任边界渐进替换。** DSH/Codex/Claude adapter 分别约 1073/1064/853 行，Composer 840 行、Timeline 688 行、store 645 行。大文件本身不证明代码“烂”；真正的问题是协议转换、运行状态、网络、持久化和 UI 乐观状态彼此缠绕，导致一处成功不代表另一处成功，以及多处重复猜测原生状态。

建议保留现有框架和模块入口，按以下顺序抽出可独立验证的组件：

| 边界 | 负责什么 | 为什么需要 |
|---|---|---|
| Native transport lifecycle | 启停、握手、超时、重连、epoch、请求关联、有界缓冲 | 原生进程/Host 故障必须独立于浏览器同步恢复 |
| Capability registry | 锁定版本、原生类型、动态能力、可用原因、设置来源 | 一个真实目录同时驱动 UI 和服务端校验 |
| Session identity / owner lease | 平台 ID、native ID、turn、actor、当前写入者 | 防止结构化界面与原生终端并发破坏同会话 |
| Command ledger / queue | payload、认领、顺序、ACK 阶段、恢复与对账 | 解决重复执行和已接受消息丢失 |
| Event translator / projection | 生产与回放同一归约；交互、任务和回答单一状态 | 防止内容丢失、状态分叉与测试专属补偿 |
| Session sync store | 覆盖区间、权威快照、分页、订阅预算、按会话缓存 | 把“知道尾部”与“真正拥有历史”分开 |
| Native feature panels / input controllers | 按能力表单、附件上传、草稿、专有面板、诊断定位 | 常用 UI 共享，原生特性有明确独立入口 |

迁移应保持旧事件可读，给事件/投影增加版本，先旁路对比新旧结果，再切换写入；有回滚路径后再删除旧逻辑。不要先更换数据库、CSS 框架或完整前端，也不要先拆文件再把原有状态错误原样搬过去。

## 八、怎样实现“浏览器能体验全部原生功能”

### 1. 先定义可验收的“全部”

建议基线是：**特定 Agent 版本、服务器操作系统、已安装插件、账号权限、Provider 和工作区配置下，原生用户界面可用的能力，用户可以在浏览器中发现、理解并实际操作，结果与原生一致。**

每项能力分开记录两种覆盖：一是“浏览器可操作”，包括原版 Web 或原生终端入口；二是“结构化 WebDCC UI 完整支持”。通过终端完成插件管理只能算第一种，不能包装成已有漂亮结构化管理页。未安装、无认证、平台不支持、协议未暴露分别展示原因；动态插件生态不能靠一次固定清单承诺永久 100%。

### 2. 采用三个互补入口

**常用能力采用结构化统一 UI。** 会话、消息、审批、问答、文件、任务、模型和权限等高频流程优先做好，保留各家特有语义，不用最低共同字段抹平差异。

**DSH 提供可靠的原版 Web 入口。** 项目已有“打开 DSH 原版界面”链接，但直接地址可能仍是服务器 loopback，不能保证远程浏览器可达。应设计受认证的入口，处理 Host/Origin、cookie、WS、basePath 和深链，优先考虑独立源隔离。是否能嵌入取决于原版能力和安全头；不能假设加一个 iframe 就完成全部工作。这个通路可迅速覆盖插件、Forge、日程、语音和动态界面，而不把整个 DSH 运行时重新实现一遍。[Providers.tsx:217–221][dsh-native-link] [host.ts:110–137][dsh-host]

**Codex/Claude 提供受控的原生 CLI PTY 后备入口。** 终端必须运行实际锁定的原生二进制和用户配置，支持键盘、尺寸、重连和有界输出。它解决 SDK/协议未暴露的终端专有操作，不意味着所有底层能力已结构化实现。不要以平台生成提示词模拟原生命令，也不要把任意字符串 RPC 透传暴露成无边界接口。

### 3. 接管必须有可验证的原生控制权

结构化 adapter 与原生 CLI 不能同时随意修改同一个会话。建议加入 **session owner lease**：lease 记录 owner、native session、epoch 和有效状态；WebDCC托管的adapter、WS和PTY只允许当前控制owner写入。切换流程应是用户请求接管、停止或排空当前动作、持久化状态、验证旧owner释放、提升epoch、启动原生resume、退出后对账导入，再归还结构化入口。

平台lease和fencing不能约束用户在外部直接启动的CLI或直连DSH的页面；这些连接的排他性依赖原生锁、实时状态或可验证的协作释放。不能只改WebDCC数据库就宣称取得了全系统独占权。DSH允许的合法多客户端输入继续遵循Host的原生身份与交互仲裁。

旧进程的迟到事件不能越过 epoch；失联时先判断原生是否仍运行，再恢复 lease，不能仅超时就双开写入。如果某个锁定后端不支持安全的同会话接管，就明确提供独立原生会话或只读入口，不承诺无缝双向切换。这项设计同时约束队列、审批、终端和历史导入，是“全功能”路线的基础工作。

## 九、实施顺序与完成判据

M0修复权限、数据、输入语义、原生生命周期和证据门禁。M1补齐历史导入与高频工作流，并前置Codex/Claude独立原生CLI及登录入口；M2完成DSH原版远程入口和可验证的同会话接管，扩展专属控制；M3收口长尾、性能、备份恢复和全能力证据。具体依赖以SPEC为准，不能因为已有后备入口就省略高频结构化能力。

每项需求都应写明：原生合同与版本、现有入口、用户动作、实际副作用、持久化状态、失败与撤销、刷新/重连表现、验收证据，以及实现行数、测试行数、触及文件数。代码估算应排除生成 schema、lockfile、录制数据和纯搬迁；文件数有重叠，不能简单相加。具体拆分和预算以配套 SPEC 与约束文件为准。

完成一项能力至少要满足“能找到、能读取、能操作、原生结果正确、刷新可恢复、断线可收敛、错误可理解”。仅有按钮、JSON 卡片、mock 成功或回放终止态不构成功能完成。以这个标准推进，WebDCC 可以在保留现有资产的同时逐步达到可靠的浏览器原生入口，而不是长期停留在看起来统一、实际能力被压缩的状态。

## 附：本次证据索引

- 范围与规模：metrics.json；三份详细子审计 audit_codex_claude.md、audit_dsh.md、audit_web.md。
- 本次静态与构建：unit-direct.log、typecheck-direct.json、lint-direct.log、build-web-direct.log、build-server-direct.log。
- 回放与扫描：l1-direct.json、trace-scan.log。
- 环境受阻：e2e-result.json、e2e-stderr.log。
- 具体机制复现：core-repro.log、adapter_gap_reproduction.jsonlog、audit_web_repro_results.json；对应脚本 reproduce_core_gaps.mts、reproduce_adapter_gaps.mts、audit_web_repro.mjs。
- 所有下列 GitHub 引用均固定在审查 SHA；新生成的本地验证记录不是上游仓库历史报告。

[readme]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/README.md#L3-L38
[goals]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/SPEC.md#L53-L81
[readme-state]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/README.md#L13-L22
[non-goals]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/SPEC.md#L85-L112
[server-store]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/server/src/store.ts
[turn-reducer]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/protocol/src/turn.ts
[file-editor]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/components/FileEditor.tsx
[codex-access]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/codex/src/adapter.ts#L71-L89
[codex-turn-params]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/codex/src/adapter.ts#L396-L406
[turn-start-schema]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/codex/src/schema/v2/TurnStartParams.ts#L43-L50
[default-access]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/server/src/manager.ts#L145-L158
[dsh-settings-route]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/server/src/rest.ts#L622-L654
[dsh-settings-file]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/server/src/dsh-settings.ts#L53-L158
[files-route]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/server/src/rest.ts#L808-L828
[auth-hook]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/server/src/app.ts#L58-L67
[dispatcher]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/server/src/dispatcher.ts#L25-L34
[hub-command]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/server/src/hub.ts#L123-L135
[manager-queue]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/server/src/manager.ts#L303-L341
[web-ack]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/lib/store.ts#L253-L268
[command-store]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/server/src/store.ts#L541-L551
[questions-ui]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/components/Timeline.tsx#L632-L680
[codex-answer]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/codex/src/adapter.ts#L678-L681
[claude-answer]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/claude/src/adapter.ts#L508-L515
[codex-requests]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/codex/src/adapter.ts#L994-L1029
[server-request-schema]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/codex/src/schema/ServerRequest.ts
[interaction-schema]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/protocol/src/events.ts#L54-L68
[question-resolve]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/server/src/manager.ts#L403-L413
[approval-ui]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/components/Timeline.tsx#L571-L620
[dsh-answer]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/dsh/src/adapter.ts#L607-L621
[dsh-events]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/dsh/src/adapter.ts#L672-L691
[dsh-resolution]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/dsh/src/adapter.ts#L873-L891
[dsh-host]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/dsh/src/host.ts#L110-L228
[dsh-connect]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/dsh/src/adapter.ts#L326-L350
[dsh-attach]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/dsh/src/adapter.ts#L625-L637
[dsh-resume]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/dsh/src/adapter.ts#L481-L519
[dsh-snapshot]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/dsh/src/adapter.ts#L690
[dsh-user]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/dsh/src/adapter.ts#L899-L900
[dsh-follow-schema]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/fixtures/dsh/host-api-catalog.json#L2514-L2568
[dsh-subagent]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/dsh/src/adapter.ts#L393-L407
[dsh-subagent-schema]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/fixtures/dsh/host-api-catalog.json#L19993-L20135
[subagent-ui]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/components/Timeline.tsx#L439-L474
[codex-send-stop]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/codex/src/adapter.ts#L644-L659
[codex-native-turn]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/codex/src/adapter.ts#L743-L759
[codex-map]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/codex/src/adapter.ts#L319-L370
[codex-item-schema]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/codex/src/schema/v2/ThreadItem.ts#L45
[codex-plan-delta]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/codex/src/adapter.ts#L927-L933
[claude-replay]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/claude/src/adapter.ts#L245-L255
[claude-system]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/claude/src/adapter.ts#L654-L666
[claude-default]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/claude/src/adapter.ts#L839-L848
[claude-pump]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/claude/src/adapter.ts#L385-L407
[claude-settings]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/claude/src/adapter.ts#L444-L469
[claude-blocks-tasks]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/claude/src/adapter.ts#L719-L773
[codex-models]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/codex/src/adapter.ts#L481-L530
[claude-models]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/claude/src/adapter.ts#L282-L304
[composer-effort]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/components/Composer.tsx#L42-L43
[web-history]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/lib/store.ts#L368-L378
[web-snapshot]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/lib/store.ts#L211-L217
[composer-draft]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/components/Composer.tsx#L55-L78
[composer-submit]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/components/Composer.tsx#L176-L206
[composer-upload]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/components/Composer.tsx#L255-L277
[composer-enter]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/components/Composer.tsx#L399-L402
[user-message-ui]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/components/Timeline.tsx#L133-L143
[pending-projection]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/lib/store.ts#L475-L519
[handoff-selector]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/App.tsx#L199-L203
[mention-selector]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/components/Composer.tsx#L793-L797
[trajectory]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/components/Trajectory.tsx
[web-subscribe]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/lib/store.ts#L143-L157
[web-created]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/lib/store.ts#L193-L204
[web-turn-cache]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/lib/store.ts#L437-L496
[hub-history]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/server/src/hub.ts#L160-L175
[codex-rpc]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/codex/src/rpc.ts#L86-L124
[request-id]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/codex/src/schema/RequestId.ts
[trace-recording]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/server/src/trace-real.ts#L211-L222
[l1-exemption]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/scripts/l1-replay.ts#L127-L133
[m9-spec]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/docs/specs/SPEC-M9.md
[accept-m9]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/scripts/accept-m9.ts#L79-L100
[accept-m8-exit]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/scripts/accept-m8.ts#L34-L40
[accept-m8-ratchet]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/scripts/accept-m8.ts#L172-L228
[net-test]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/e2e-real/net.spec.ts#L158-L180
[upload-test]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/e2e/m7.spec.ts#L49-L100
[config]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/server/src/config.ts#L23-L34
[recorder]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/server/src/interaction-recorder.ts#L13-L87
[watchdog-default]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/server/src/watchdog.ts#L7-L9
[watchdog-prompt]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/server/src/watchdog.ts#L55-L60
[watchdog-send]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/server/src/watchdog.ts#L229-L248
[client-request-schema]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/codex/src/schema/ClientRequest.ts
[notification-schema]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/codex/src/schema/ServerNotification.ts
[dsh-catalog]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/fixtures/dsh/host-api-catalog.json
[m8-report]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/docs/acceptance/M8/report.json
[m8-pass]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/docs/acceptance/M8/pass-1.json
[m9-report]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/docs/acceptance/M9/report.json
[m8-stubs]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/e2e-real/stubs.spec.ts
[dsh-comparison]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/docs/acceptance/M9/dsh-compare.html
[traces]: https://github.com/codezzzsleep/WebDCC/tree/9b1ae9096c19162206361e3910b7ef2592c5f30b/fixtures/traces
[replay-ui]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/e2e-m9/replay.spec.ts
[dsh-native-link]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/pages/Providers.tsx#L217-L221


[effective-access]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/server/src/manager.ts#L494-L504
[dsh-model-identity]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/dsh/src/adapter.ts#L179-L195
[dsh-command-result]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/adapters/dsh/src/adapter.ts#L526-L540
[trajectory-navigation]: https://github.com/codezzzsleep/WebDCC/blob/9b1ae9096c19162206361e3910b7ef2592c5f30b/packages/web/src/App.tsx#L303-L308
