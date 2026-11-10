# 协议核实笔记（M0）

> 核实日期：2026-11-11 · 环境：见 [deploy.md](deploy.md) 的锁定版本表
> 方法：静态阅读已安装版本的源码/类型声明 + 探针实跑（`scripts/probe-*.ts`、`scripts/verify-claude-native.ts`），全程用第 13 节的假模型，不花真实 API 费用。
> 规则（SPEC 0.4）：本文与 SPEC 冲突时**以本文为准**，原则与验收标准不变。

## 0. 影响架构的结论（先看这一节）

| # | 结论 | 影响 |
|---|---|---|
| 1 | DSH 一元 RPC 是 `POST /api/<namespace>/<method>`，信封是 `{type:'client-request', rpcId, method, payload:{args}}`；`payload` 必须恰好一个 `args` 键，参数再包一层 `request`/`address` 等**描述符里的顶层参数名** | SPEC 5.4 里 `POST /api/<method>` 与"带 rpcId 的信封"写法要按此实现；`host.describe`、`workspace.list`、`session.models`、`session.history` **不存在** |
| 2 | DSH 事件流只有 `/api/remote.mux`（不存在 `/api/events.mux`），且是"一条流 = 一次方法调用"（`session/follow`、`workspace/follow`、`$events`），不是按 sessionId 的广播订阅 | 同步层要按流建模：每个会话一条 `session/follow` |
| 3 | DSH 的 `text-delta`/`reasoning-delta`/`tool-call-delta` **不是**顶层事件，而是 `session/follow` 里 `assistant-stream` 帧的 `frame.chunk`；工具调用/结果是 `event` 帧里的 `tool/call`、`tool/result` | 事件映射（SPEC 6.3）按"帧类型 + chunk 类型 + 工具名"三级判断 |
| 4 | DSH 审批是 waterfall 事件 `approval/request`，**回复不是 RPC**，而是 `POST /api/$events/result`（`{clientId, eventId, outcome:{kind:'result', value:'allowed-once'}}`）；反问同理（`user-questions/request`），另有 `userQuestions/answer` | Adapter 的 `respond()` 走 `$events/result` |
| 5 | DSH "访问模式"是 permission preset：`read-only` / `workspace-write` / `danger-full-access` / `auto`，切换靠命令 `/permission <preset>`（`commands/execute`），不是 `session.create` 参数 | SPEC 9.6/5.4 的访问模式实现方式改变 |
| 6 | Codex `codex app-server` **接受 `-c`**（含内联表写法），自定义 Provider + `env_key` 即可不登录 ChatGPT；M0 探针全程没写任何用户配置 | SPEC 10.3 主方案成立，不需要备选方案 |
| 7 | Claude Code 经 Agent SDK 启动**确实加载项目 `.mcp.json` 与 hooks**（实测 `mcp_servers:[{name:'wdccecho',status:'connected',source:'project'}]`，hook 标记文件生成） | SPEC 3.2 的做法成立，`native.spec.ts` 可按此断言 |
| 8 | 本容器的 Landlock 是 "partial enforcement (older Landlock ABI)"，DSH 的沙箱读写在 `/tmp` 下实际能越界成功；审批要靠**模型显式传 `sandbox_permissions` + `justification`** 触发 | 探针与 A6 的审批用例要显式请求提权，不能指望沙箱拒绝 |

---

## 1. DeepSeek Harness 0.2.2-rc.1

证据路径以下列目录为根（记作 `$DSH`）：
`/opt/node-v26.13.0-linux-x64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
另外用 `scripts/dump-dsh-host-api.ts` 从各包的 `lib/typert.host.js` 导出了完整端点目录：
[fixtures/dsh/host-api-catalog.json](../fixtures/dsh/host-api-catalog.json)（193 个端点，含每个端点的参数 JSON Schema 与源码位置）。

### 1.1 侧车启动与认证

- 启动：`dsh web --no-open --port <n>`；参数全集 `--host`/`--port`/`--no-open`/`--public-url`/`--trusted-host`/`--tls-cert`/`--tls-key`（`$DSH/dsh-web-app/lib/startup.js:30`）。默认 `127.0.0.1:3080`。
- stdout 精确格式：`dsh web: http://127.0.0.1:<port>/?token=<43 字符 base64url>`（`$DSH/dsh-web-app/lib/index.js:162`）。
- `GET /?token=<t>` → **303** + `Set-Cookie`（`$DSH/dsh-client-connection/lib/index.js:464`）。
  - Cookie 名：`dsh-auth-` + `base64url(sha256(authority))`，authority 形如 `127.0.0.1:3191`
  - 值：`v1.<base64url(JSON)>.<base64url(HMAC-SHA256)>`，`HttpOnly; SameSite=Strict; Path=/`，默认 30 天
  - token 是**进程内**随机值，重启即失效（不能持久化）
- Host/Origin 校验（`$DSH/dsh-client-connection/lib/index.js:247`）：Host 必须是 loopback / 监听 IP / `--trusted-host`；有 Origin 时必须同 authority。服务端以 `Host: 127.0.0.1:<port>` 访问即可。
- 同一 API Peer 只允许一个 WS（第二个 409）；浏览器共享 peer 例外。

### 1.2 一元 RPC 信封（实测）

```http
POST /api/session/prompt
content-type: application/json
cookie: dsh-auth-...

{"type":"client-request","rpcId":"<uuid>","method":"session/prompt","payload":{"args":{"request":{...}}}}
```

响应：

```json
{"type":"server-response","rpcId":"<同一个>","result":{"ok":true,"value":{...}}}
{"type":"server-response","rpcId":"<同一个>","result":{"ok":false,"error":{"code":"gateway/arguments-invalid","message":"...","details":{}}}}
```

要点（均有源码依据）：
- 端点恒为两段 `ns/method`（`$DSH/dsh-api-gateway/lib/index.js:1493`）；单段路径 404。
- `method` 字段必须等于 URL 端点，否则 `gateway/bad-request`（`$DSH/dsh-client-connection/lib/index.js:906`）。
- `payload` 必须**恰好**含一个 `args`（`$DSH/dsh-api-gateway/lib/index.js:1497`）。
- `args` 的键必须与描述符的 wire 参数名**精确匹配**，多一个键即 `gateway/arguments-invalid`（`:1780`）。实测 `workspace/create` 传 `{path}` 报 `missing "request"; unexpected "path"`，正确写法是 `{request:{path}}`。
- 业务错误仍是 HTTP 200，错误在信封里。

### 1.3 事件流 `/api/remote.mux`（实测）

上行（客户端 → Host）：

```json
{"type":"open","streamId":"s1","endpoint":"session/follow","payload":{"args":{"request":{...}}}}
{"type":"cancel","streamId":"s1"}
```

下行：`{"type":"item","streamId":"s1","value":<帧>}` / `{"type":"end",...}` / `{"type":"error",...}`。

`$events`（应用级广播，唯一全局流）的帧：`{type:'ready', clientId, host:{home}}`、`{type:'emit', event, args:[...]}`、`{type:'waterfall', event, eventId, agentId, request}`、`{type:'cancel', eventId}`。
实测 `ready.host.home` 是**操作系统家目录**（`/root`），不是 `DSH_HOME`——别把它当 profile 目录用。

`session/follow` 的帧类型（实测三种）：`snapshot`、`event`、`assistant-stream`。
- `assistant-stream`：`{type:'assistant-stream', frame:{type:'chunk', index, time, chunk}}`，`chunk.type` ∈ `block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage | finish`。
- `event`：`{type:'event', event:{type, seq, time, data}}`，实测出现的事件名：`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`todo/write`、`approval/asked`、`approval/decided`、`job/registered`、`job/settled`、`request/header`、`session/title`、`agent/inbox/spliced`、`session/end-seed`。

### 1.4 会话与工作区生命周期（实测）

| 动作 | 调用 | 参数（顶层键） | 返回 |
|---|---|---|---|
| 建/取工作区 | `workspace/create` | `{request:{path}}` | `{workspace:{workspaceId,path,title,sessionIds,createdAt,updatedAt}, created}` |
| 工作区列表 | `workspace/follow` 首帧 `baseline` | — | 无 `workspace/list` |
| 新建会话 | `session/create` | `{request:{workspaceId? \| cwd?, agentPreset?, sessionId?}}` | `{sessionId, agentPreset?}`（返回的 id 可能与请求的不同） |
| 列表 | `session/list` | `{_request:{cursor?}}` | `{items:[SessionSummary]}`，**不含标题** |
| 发送 | `session/prompt` | `{request:{requestId,sessionId,mode:'queue'\|'steer',content:[{type:'text',text}],clientTimeZone?}}` | `{accepted:true}` |
| 打断 | `session/cancel` | `{request:{sessionId}}` | `{accepted:true}` |
| 历史 | `session/page` | `{request:{address:{kind:'session',sessionId}, ...}}` | `{cursor, records:[{type:'event',event:{...}}], hasMore}` |
| 模型目录 | `session/modelCatalog` | `{}` | `{default, routableProviders, groups, failures}` |
| 选模型 | `session/selectModel` | `{request:{sessionId,provider,model,reasoningEffort?}}` | `{selected}` |
| 反问答案 | `userQuestions/answer` | `{agentId,callId,answer}` | `boolean` |

`session.create` 没有 `model`、没有访问模式参数；模型用 `session/selectModel`，访问模式用 `/permission` 命令。

### 1.5 审批与反问（实测）

- 审批 waterfall：`$events` 上的 `{type:'waterfall', event:'approval/request', eventId, agentId, request:{toolName, callId?, reason?, displayReason?}}`。
- 回复：`POST /api/$events/result`，args = `{clientId, eventId, outcome:{kind:'result', value:'allowed-once'}}`；取值集合 `allowed-once | rejected | cancelled | unavailable`（`$DSH/dsh-user-approval/lib/index.js:30`）。
- `outcome.kind:'next'` 表示"我不处理，交给下一个消费者"。
- 触发条件：`tools/pre-execute` waterfall 返回 `ask`。普通 `bash` 不会自己 ask；实测**模型显式传 `sandbox_permissions:"danger-full-access"` + `justification`** 时才 ask（沙箱提权路径，`$DSH/dsh-sandbox/lib/index.js:40` 起）。

### 1.6 访问模式 = permission preset

| preset id | 中文 label | sandbox / approval |
|---|---|---|
| `read-only` | 仅可查看 | read-only / ask |
| `workspace-write` | 工作区内修改 | workspace-write / ask |
| `danger-full-access` | 完全权限 | danger-full-access / never |
| `auto` | 自动审查（EXP） | danger-full-access / ask + 逐调用模型审查 |

切换：`commands/execute`，args `{agentId, line:'/permission workspace-write', submittedAttachments:[]}`（`agentId` 即 sessionId，实测可用）。

### 1.7 模型与 Provider

- `session/modelCatalog` 实测返回默认 `{provider:'deepseek-official', model:'deepseek-flash'}`，`groups[0].models = ['deepseek-flash','deepseek-v4-pro']`。
- 假模型驱动方式成立：`DEEPSEEK_BASE_URL=<mock>` + `DEEPSEEK_API_KEY=<任意>` 后，DSH 调 `POST {base}/v1/messages` 与 `GET {origin}/models`（`$DSH/dsh-llm-deepseek/lib/index.js:2231`、`:2303`）。M0 探针全程用这条路径跑出思考、命令、读写文件、任务清单。

### 1.8 工具与事件映射

实测默认 preset 下模型拿到的工具里，出现并跑通的有：`bash`、`read`、`write`、`edit`、`todo_write`；`todo_write` 的 schema 是 `additionalProperties:false`，**不接受 `activeForm`**（Claude 的 TodoWrite 才要）。
工具调用在事件流里不区分语义，统一是 `tool/call`（`data.name` + `data.arguments`）与 `tool/result`；所以 SPEC 6.3 的映射要按 **工具名** 判断，而不是按事件类型。
token 用量来自 `assistant-stream` 的 `chunk.type='usage'`（实测 18 次），不是独立事件。

### 1.9 同一 `DSH_HOME` 跑两个 `dsh web` 安全吗

**有条件安全 → 结论：运行 WebDCC 时不要再单独运行 `dsh web`。**

- 有保护的部分：会话日志用 per-session `flock`（`$DSH/dsh-session-persistence-jsonl/lib/index.js:619`），双写会 `SessionAlreadyOwnedError`；凭据文件写入有 `withFileLock`。
- 没有保护的部分：`storages/workspace.json` 这类**单文件整份覆盖**的全局注册表跨进程没有锁（`last-write-wins`，`$DSH/dsh-storage-json/lib/types/atomic.js:13`）→ 工作区顺序/归档/pin/日程会被互相覆盖。
- 端口：默认 3080，第二个进程直接 bind 失败（无单实例锁）。

### 1.10 与 SPEC 5.4 的差异（要改实现，不改原则）

| SPEC 写法 | 实际 |
|---|---|
| `POST /api/<method>`，信封带 `rpcId` | `POST /api/<ns>/<method>`，信封 `{type,rpcId,method,payload:{args}}` |
| `host.describe` | 不存在；启动信息来自 `$events` 的 `ready` 与各域 catalog |
| `workspace.list` | 不存在；用 `workspace/follow` 首帧 `baseline` |
| `session.list` / `session.history` / `session.models` | `session/list` / `session/page` / `session/modelCatalog` |
| `/api/events.mux` 或 `/api/remote.mux` | 只有 `/api/remote.mux` |
| `text-delta`、`reasoning-delta`、`tool-call-delta` 是事件 | 是 `assistant-stream` 帧里的 `chunk` |
| `approval/requested`、`approval/resolved`、`question/requested` | `approval/request`、`user-questions/request`（waterfall），回复走 `$events/result` |
| `session.create` 可带 model/访问模式 | 只有 `workspaceId\|cwd\|agentPreset\|sessionId` |

---

## 2. Codex CLI 0.167.0

类型来自 `codex app-server generate-ts` 与 `generate-json-schema` 的导出：
[packages/adapters/codex/src/schema](../packages/adapters/codex/src/schema)（661 个类型文件）、
[packages/adapters/codex/src/json-schema](../packages/adapters/codex/src/json-schema)（322 个文件）。

### 2.1 启动与 Provider 注入（实测成立）

```bash
codex app-server \
  -c model_provider=wdcc_mock \
  -c model="mock-responses-1" \
  -c 'model_providers.wdcc_mock.name="WDCC mock"' \
  -c 'model_providers.wdcc_mock.base_url="http://127.0.0.1:<port>/v1"' \
  -c 'model_providers.wdcc_mock.wire_api="responses"' \
  -c 'model_providers.wdcc_mock.env_key="WDCC_MOCK_KEY"'
```

- `-c` 在 `codex app-server --help` 里就有，**包含内联表写法**（dotted path + TOML 值），SPEC 10.3 的备选方案不需要了。
- `env_key` 指向环境变量即可，**不需要** `preferred_auth_method`/`forced_login_method`，也不需要 `codex login`（探针用临时 `CODEX_HOME`，全程无 ChatGPT 登录）。
- `OPENAI_API_KEY` 确实不被 app-server 认（SPEC 5.2 的说法成立），必须走自定义 Provider。

### 2.2 会话与轮次（实测）

| 动作 | 方法 | 参数 |
|---|---|---|
| 握手 | `initialize` | `{clientInfo:{name,title,version}, capabilities:null}` → 之后 `notify('initialized')` |
| 新建 | `thread/start` | `{cwd, model?, approvalPolicy?, sandbox?, config?, ...}` → `{thread:{id}, model, modelProvider, ...}` |
| 恢复 | `thread/resume` | `{threadId, model?, approvalPolicy?, sandbox?}`（全新进程可冷恢复，实测通过） |
| 发送 | `turn/start` | `{threadId, input:[UserInput]}` → `{turn:{id}}` |
| 打断 | `turn/interrupt` | `{threadId, turnId}` → 之后 `turn/completed` 的 `turn.status='interrupted'` |
| 模型列表 | `model/list` | — |

`thread/start` 与 `turn/start` 的 schema 里确实有 `baseInstructions`/`developerInstructions`（禁止传），以及 `config` 覆盖字段。

### 2.3 事件全集（`ServerNotification.ts`）

`error`、`thread/started`、`thread/status/changed`、`thread/readState/changed`、`thread/archived`、`thread/deleted`、`thread/unarchived`、`thread/closed`、`thread/reverted`、`skills/changed`、`thread/name/updated`、`thread/section/changed`、`thread/attachment/updated`、`thread/goal/updated`、`thread/prediction/updated`、`thread/goal/cleared`、`thread/queue/changed`、`project/changed`、`thread/project/updated`、`thread/environment/connected`、`thread/environment/disconnected`、`thread/settings/updated`、`thread/tokenUsage/updated`、`turn/started`、`hook/started`、`turn/completed`、`hook/completed`、`turn/diff/updated`、`turn/plan/updated`、`item/started`、`item/autoApprovalReview/started`、`item/autoApprovalReview/completed`、`autoApprovalReview/strictReviewRequired`、`item/completed`、`rawResponseItem/completed`、`rawResponse/completed`、`item/agentMessage/delta`、`item/plan/delta`、`command/exec/outputDelta`、`process/outputDelta`、`process/exited`、`item/commandExecution/outputDelta`、`item/commandExecution/terminalInteraction`、`item/fileChange/outputDelta`、`item/fileChange/patchUpdated`、`serverRequest/resolved`、`item/mcpToolCall/progress`、`mcpServer/oauthLogin/completed`、`mcpServer/startupStatus/updated`、`mcpServer/event/stream/notification`。

探针实测出现：`item/started`(11)、`item/completed`(11)、`item/agentMessage/delta`(7)、`item/reasoning/summaryTextDelta`、`item/reasoning/summaryPartAdded`、`thread/status/changed`、`thread/tokenUsage/updated`、`turn/started`、`turn/completed`、`thread/started`、`account/rateLimits/updated`、`warning`、`configWarning`、`deprecationNotice`、`remoteControl/status/changed`、`thread/goal/cleared`、`serverRequest/resolved`。

### 2.4 审批（实测 4 次/轮）

- `approvalPolicy: 'untrusted'` + `sandbox: 'workspace-write'` → 每个 `exec_command` 都发 `item/commandExecution/requestApproval`。
- 回复（服务端反向请求，直接回响应体）：
  - `item/commandExecution/requestApproval` → `{decision:'accept'}`（枚举 `accept|acceptForSession|acceptWithExecpolicyAmendment|applyNetworkPolicyAmendment|decline|cancel`）
  - `item/fileChange/requestApproval` → `{decision:'accept'}`
  - 旧版 `execCommandApproval`/`applyPatchApproval` → `{decision:'approved'}`（`ReviewDecision`）
  - `item/tool/requestUserInput` → `{answers:{}}`
- `AskForApproval` 枚举：`untrusted | on-request | never | {granular:{sandbox_approval,rules,skill_approval,request_permissions,mcp_elicitations}}`。
- `SandboxMode` 枚举：`read-only | workspace-write | danger-full-access`。

### 2.5 图片 / 多模态字段（`v2/UserInput.ts`）

```ts
{type:'text', text, text_elements: TextElement[]}
| {type:'image', detail?, url} | {type:'image', detail?, fileId}
| {type:'localImage', detail?, path}
| {type:'audio', url|fileId} | {type:'localAudio', path}
| {type:'skill', name, path} | {type:'mention', name, path}
```

即 SPEC 5.2 待核实的图片字段是 `{type:'localImage', path}`（本地文件）或 `{type:'image', url}`。

### 2.6 工具名（实测）

本轮请求里 Codex 下发的工具：`exec_command`（参数 `cmd`）、`write_stdin`、`request_user_input`、`view_image`、`multi_agent_v1`、`get_goal`、`create_goal`、`update_goal`、`web_search`。
**没有** `apply_patch`、没有 `update_plan`（SPEC 6.3 表格里"写文件"对应 `apply_patch`、任务清单对应 `update_plan` 的假设在这个版本/配置下不成立；写文件走 `exec_command` 的 shell 重定向）。

---

## 3. Claude Code 2.1.322 + Agent SDK 0.3.322

类型证据：`packages/adapters/claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`。

### 3.1 SDK 选项（与 SPEC 5.3 一致）

`systemPrompt: {type:'preset', preset:'claude_code'}`、`settingSources:['user','project','local']`、`includePartialMessages:true`、`resume`、`model`、`permissionMode`、`canUseTool`、`env` 全部存在且可用（探针实跑）。

### 3.2 原生配置加载（`scripts/verify-claude-native.ts`，实测通过）

临时项目里放 `.mcp.json`（最小 stdio MCP server）+ `.claude/settings.json`（`UserPromptSubmit` hook 写标记文件），用 `settingSources:['user','project','local']` 跑一轮：

```
mcp_servers（init）：[{"name":"wdccecho","status":"connected","source":"project"}]
工具里出现的 MCP 工具：mcp__wdccecho__echo
hooks 标记文件：已生成（hooks 生效）
```

→ SPEC 3.2 里【M0 核实】的"SDK 启动的会话确实加载了 hooks 和项目 .mcp.json"**成立**，且不需要传 `mcpServers`/`hooks` 选项。

### 3.3 端点（实测）

Claude Code 只请求了我们的假模型两个路径：

- `POST /v1/messages`（11 次，SSE 流式）
- `HEAD /api/hello`（2 次，探测用）

**没有**请求 `/v1/models`（模型名走 options/model 与本机缓存）。未知端点清单落在 [fixtures/claude-code/unknown-endpoints.txt](../fixtures/claude-code/unknown-endpoints.txt)。

### 3.4 访问模式（`PermissionMode`）

`'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`（`sdk.d.ts:2599`）。
实测 `permissionMode:'default'` 下 `Write`/`Edit` 触发 `canUseTool`，而 `Bash` 的只读命令不触发（Claude Code 自带的安全命令放行）。

### 3.5 换模型 / 换访问模式

`Query.setModel(model?)` 与 `Query.setPermissionMode(mode)` 都存在（`sdk.d.ts:3016`、`:2987`），另有 `supportedModels()`、`mcpServerStatus()`。SPEC 5.3 的待核实项成立。

### 3.6 中断语义（实测）

`query.interrupt()` 之后，本轮以 `result` 消息结束，`subtype='error_during_execution'`、`is_error=true`；流式输入模式下 query 本身不关闭，可以继续推下一轮（探针中断后继续跑通了恢复轮）。

---

## 4. 假模型服务（第 13 节实现说明）

代码：[packages/testing/mock-models](../packages/testing/mock-models)。
计划格式 `plans/probe.json`：数组，第 N 项是"收到第 N 个工具结果之后"要回的内容块；`tool.kind` 只写语义（command/read/write/edit/todo/ask/patch），具体工具名按请求里的 `tools` 匹配，`alternatives` 用于跨 Agent 的同义不同名工具，`inputByName` 用于同一工具在不同 Agent 下的不同参数名。

### 4.1 mock-anthropic

实现 `POST /v1/messages` 的 Anthropic Messages 流式格式：`message_start` → `content_block_start/delta/stop`（`thinking` + `signature_delta`、`text`、`tool_use` + `input_json_delta`）→ `message_delta` → `message_stop`；另有 `POST /v1/messages/count_tokens`、`GET /models`、`GET /v1/models`；未知端点 404 并记日志。

### 4.2 mock-responses（Codex 用）

事件序列（Codex 0.167.0 全部接受，实测）：

```
response.created → response.in_progress
→（可选 reasoning）response.output_item.added / response.reasoning_summary_part.added
   / response.reasoning_summary_text.delta / .done / response.reasoning_summary_part.done
   / response.output_item.done
→（文本）response.output_item.added / response.content_part.added
   / response.output_text.delta / .done / response.content_part.done / response.output_item.done
→（工具）response.output_item.added(type:function_call) / response.function_call_arguments.delta
   / .done / response.output_item.done
→ response.completed{response:{...,output:[...],usage}}
```

Codex 侧的工具调用在 `input` 里以 `function_call_output` 项回传；每轮开始时 `input` 末尾有一条 `message(role:'user')`。

---

## 5. 【M0 核实】逐条结论

| # | SPEC 位置 | 待核实项 | 结论 | 证据 |
|---|---|---|---|---|
| 1 | §3.2 Claude | SDK 会话是否加载 hooks 与项目 `.mcp.json` | **是** | `scripts/verify-claude-native.ts` 实测 |
| 2 | §5.2 Codex | `turn/start` 图片字段 | `{type:'localImage',path}` / `{type:'image',url\|fileId}` | `schema/v2/UserInput.ts` |
| 3 | §5.2 Codex | 事件完整列表 | 见 §2.3 | `schema/ServerNotification.ts` |
| 4 | §5.3 Claude | `setModel` / `setPermissionMode` | 都存在 | `sdk.d.ts:3016` / `:2987` |
| 5 | §5.4 DSH | Host API 方法名 / 事件流路径 / 认证 | 全部与 SPEC 不同，见 §1.10 | `host-api-catalog.json` + 探针 |
| 6 | §5.4 DSH | 两个 `dsh web` 共用 `DSH_HOME` 是否安全 | **不建议**：会话有 flock，全局注册表会互相覆盖 | §1.9 |
| 7 | §6.3 | DSH `file.read` 条目类型 | 没有独立条目类型；按 `tool/call` 的 `data.name`（`read`/`read_image`/`glob`/`grep`）映射 | §1.8 |
| 8 | §6.3 | DSH usage | `assistant-stream` 的 `chunk.type='usage'` | §1.8 |
| 9 | §9.6 Codex | `approvalPolicy` + `sandbox` 原生组合 | `untrusted|on-request|never|granular` × `read-only|workspace-write|danger-full-access` | §2.4 |
| 10 | §9.6 Claude | `permissionMode` 原生枚举 | `default|acceptEdits|bypassPermissions|plan|dontAsk|auto` | `sdk.d.ts:2599` |
| 11 | §10.3 Codex | app-server 是否接受 `-c` 及内联表 | **接受**，主方案可用 | §2.1 |
| 12 | §10.3 Codex | 是否需要 `preferred_auth_method`/`forced_login_method` | **不需要**（自定义 Provider + `env_key`） | §2.1 |
| 13 | §13 | Claude Code 还会请求哪些端点 | 只有 `/v1/messages` 与 `HEAD /api/hello` | §3.3 |
| 14 | §13 | mock-responses 需要实现哪些事件类型 | 见 §4.2 | 探针实跑 |

---

## 6. 对后续里程碑的影响

- **M1（同步协议）**：DSH 的"一条流 = 一次方法调用"要在 Live Hub 里体现为 per-session 上游流；`seq` 用 DSH 的 `event.seq`。
- **M5（DshAdapter）**：直接照 [host-api-catalog.json](../fixtures/dsh/host-api-catalog.json) 实现，`respond()` 走 `$events/result`，访问模式走 `commands/execute` 的 `/permission`。
- **M6（Provider）**：Codex 只需 `-c`；Claude 只需 `env`；DSH 的 provider 走它自己的设置（`llm/listProviders`），平台不碰。
- **A6 的审批用例**：DSH 必须让模型显式传 `sandbox_permissions` 才会 ask；本容器 Landlock 只 partial enforcement，靠沙箱拒绝触发审批不可靠。
