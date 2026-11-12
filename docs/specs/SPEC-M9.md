# WebDCC M9 SPEC：真实轨迹与"一轮对话"的统一模型

> 版本 1 · 2026-11-12 · 基线 `main@fc800e1`（加上当时工作区里未提交的改动）
> 读者：执行本文的 Agent（当前是 Codex）。用户只会说一句"按 `docs/specs/SPEC-M9.md` 执行"，所以本文必须自成一体。
> 与其他文档的关系：本文优先于 `SPEC.md` 第 5.1、6、9.4 节和 `docs/specs/SPEC-M8.md` 里与之冲突的内容；`SPEC-M8.md` 第 1.2–1.5 节的测试纪律继续有效。M8 剩余用例在 M9 完成之后再继续。

---

## 0. 为什么要做 M9

### 0.1 一句话

现在的问题不是"还有很多小 bug"，而是两件地基没打：**测试从来没见过真实模型的输出**；**系统里没有任何一处定义"一轮对话"到底是什么**。所以每修一个现象就多一个补丁，而且补丁只在假数据上成立。M9 只做这两件事，做完之后同类现象应该成片消失，而不是一个个去堵。

### 0.2 证据（都已在本机核实，不是推测）

| 用户看到的现象 | 真实原因 | 为什么测试没发现 | 之前的修法 |
|---|---|---|---|
| Codex 跑完只剩"执行了 6 条命令"，没有最终回答 | `packages/adapters/codex/src/adapter.ts` 的 `mapItemData` 判断 `item.phase === 'final'`。官方类型 `schema/MessagePhase.ts` 是 `"commentary" \| "partial_answer" \| "final_answer"`，**`final` 这个值不存在**。线上数据库里 4 个真实 Codex 会话的 12 条助手消息，5 条原生是 `final_answer`、7 条是 `commentary`，全部被存成了 `interim` | 假模型不发 `phase` | `Timeline.tsx` 里"找不到最终回答就拿最后一条顶上" |
| 运行中"思考中…"一行行越积越多 | `item/started` 时为 reasoning 建了进行中条目；`item/completed` 时发现文本为空就直接 `return`，没有关闭这个条目。真实 GPT 模型的思考是加密的，文本恒为空，所以每思考一次泄漏一行。线上 188 条事件里 `reasoning` 是 0 条 | 假模型的思考有文本 | `Timeline.tsx` 里"只显示最后一个进行中的思考" |
| 一轮被劈成两块，上面一块永远"运行中…" | 系统里有两套轮次编号：服务端在 `send()` 时发的 ULID，和 Codex 原生的 turn id。工作区里未提交的改动让 Codex 的条目带上原生 id，`manager.ts` 又优先采用它，而用户消息用的是 ULID，前端按编号分组，一轮变两轮（`AG-codex-07` 的失败现场就是这个） | 这是修"晚到的事件归错轮次"时新引入的 | 仍在修 |
| 刷新前后显示的"最终回答"不是同一条（`AG-codex-08`） | "哪条是最终回答"没有存下来，每次由界面现算，流式路径和刷新路径算出来不一样 | — | — |
| 改动卡片漏文件 | Codex 的 `turn/diff/updated` 是"这一轮累计的 diff"，其他来源是"这一次工具调用改了什么"，两种语义共用一个 `snapshot` 布尔，由界面猜怎么合并 | — | 把"后到的覆盖"改成"全部累加"（文件改回去的情况会显示错） |

三个 adapter 对"哪条是最终回答"的处理各不相同：Codex 全标成过程（上面那个 bug），Claude Code 完全不标，DSH 全标成最终。界面只能"取最后一条"。这不是三个 bug，是**没有统一定义**。

另外读代码发现、尚未用真实数据验证的同类问题（M9 里用轨迹核实）：

- Claude adapter 每遇到一个 `content_block_start` 就把序号加 1 并建进行中条目，完成时只用最后一个序号收尾，前面的块（例如思考块、工具块）对应的进行中条目没人关闭。
- `manager.send()` 先写入用户消息和 `turn.started`，再调 `adapter.send()`；后者抛错时这一轮没有任何终止事件，会永远"运行中"。
- 多处 `itemKey` 用 `Date.now()` 生成，同一份输入回放两次结果不同。

### 0.3 第三个问题：开发、验收、线上共用一份构建产物

线上 `webdcc.service` 的工作目录就是开发仓库，直接运行仓库里的 `packages/server/dist/main.js`，前端从 `packages/web/dist` 读取。`scripts/accept-m8.ts` 每次都往同一个 `dist` 里 `pnpm build`。结果：每跑一次验收，线上页面就被换成未提交的代码；线上进程如果崩溃自动重启，加载的也是未提交的代码；验收和构建并行时出现过白屏。第 6 节解决它。

---

## 1. 硬性规则

1. **轨迹优先。** 任何"Agent 的输出怎么显示"的问题，先找到（或采集）一条能复现它的真实轨迹，再动代码。PR 描述必须写明：现象、对应轨迹和帧号、被破坏的是第 4.6 节的哪条不变量、修在哪一层。写不出这四项的修复不许合并。
2. **界面不许猜。** `packages/web/src/components/` 里的组件只渲染第 4.5 节的 `TurnView`，不许根据事件列表推断轮次状态、最终回答、哪些进行中条目该显示、改动怎么合并。第 5.2 节列出了必须删除的猜测代码。
3. **翻译层不许丢、不许判断。** adapter 的翻译器对每一帧要么产生事件，要么属于第 3.5 节登记的纯增量帧；不许 `return` 丢弃。翻译器不判断轮次归属、会话状态和最终回答，这些只在第 4 节的 `TurnTracker` 和 `reduceTurn` 里做。
4. **假模型只能照着真实录像来。** 第 3.7 节完成后，`packages/testing/mock-models/plans/` 里与真实录像不符的手写计划要删除或改为由录像生成。不许再凭想象新增假模型行为。
5. **以轨迹为准。** 本文里标了【轨迹核实】的地方是我没有真实数据佐证的判断。采集后如果与本文不符：以轨迹为准，把帧原文贴进 `docs/protocol-notes.md`，再改本文对应条目，在 PR 的"修改的规则"一节列出。不许反过来为了符合本文去改轨迹或黄金文件。
6. **不碰用户正在运行的服务和真实配置。** 不停止、不重启、不连接 3080 上的 DSH；采集和测试只用临时目录和动态端口；不读写 `~/.dsh`、`~/.codex`、`~/.claude`、`~/.webdcc`，例外只有两处只读访问：第 2 节 H1 导出测试样本、第 3.3 节读取 Key。不按进程名结束进程。第 6 节的发布是唯一允许重启 `webdcc.service` 的地方。
7. **不提交任何真实的 Key、token、Cookie、服务器地址。** 轨迹入库前必须过第 3.4 节的脱敏和扫描。
8. `SPEC-M8.md` 第 1.2 节（测试里不许做的事）、1.3 节（先红后绿）、1.5 节（停止条件）继续有效。
9. **不要"说一句做一句"。** 本文已经给出确定的答案，不需要中途向用户确认。确实缺信息时，把问题和你的默认做法写进 `docs/progress.md` 的"待决"一节，按默认做法继续。

---

## 2. 现场交接（第一个 PR，先做）

写这份文档时工作区里有未提交的改动，按下面处理：

**保留并提交**（验收基础设施和真实缺陷的修复，方向正确）：
- `e2e-real/` 和 `packages/testing/mock-models/src/mock-control.ts` 里的内存和进程清理修复（每个用例开始清空 mock 请求、mock 请求记录设上限、不再读取所有响应正文、teardown 递归清理子进程、验收环境空闲回收时间）。`reporter.ts` 里临时加的内存打点删掉。
- `packages/server/src/hub.ts` 的按客户端命令串行化。
- `packages/adapters/dsh/src/adapter.ts` 的 `selectModel`（从模型目录查 provider）和对应的 `native.spec.ts` 用例。
- `e2e-real/agents2.spec.ts` 里"等轮次完成后再检查上游请求"。

**不许提交，直接丢弃**（M9 用统一模型取代它们）：
- `packages/adapters/codex/src/adapter.ts` 里的 `lastTurnId` 以及给条目带原生 `turnId` 的改动。
- 同一文件里的 `belongsToActiveTurn`：它把不属于当前轮的通知直接 `return` 掉，违反"不丢输出"，而且会把轮次结束后才到的 `turn/diff/updated` 一起丢掉。
- 同一文件里的 `resuming` / `resumeInterrupt`：恢复会话时一收到 `turn/started` 就自动发 `turn/interrupt`，等于替用户打断了一轮；其中的固定 100 毫秒等待也不许留。恢复后原生历史被重放的问题，用 `excludeTurns: true`（保留）和第 4.3 节的归属规则解决，不靠打断。
- 同一文件里删掉 `thread/resume` 的 `model`、`reasoningEffort`、访问模式参数的改动：恢复时这三项必须照旧带上。
- `packages/server/src/manager.ts` 里的 `eventTurnId = event.turnId ?? runtime.turnId`。
- `packages/web/src/components/Timeline.tsx` 里 `collectChanges` 去掉快照清空的改动。

工作区在本文写完之后可能又有新改动。判断原则：凡是在 adapter、`manager.ts` 或界面组件里新增的、用来处理"事件归哪一轮""晚到的事件""该不该丢弃某个通知""哪条是最终回答""进行中条目显示几个"的条件分支，一律不提交，留给第 4 节。

**两个热修**（一两行的真修复，有线上证据，先红后绿，合并后按第 6 节发布到线上）：
- **H1** Codex 最终回答：`mapItemData` 按官方 `MessagePhase` 映射，`final_answer` → `final`，`commentary` → `interim`，`partial_answer` 暂按 `final`（【轨迹核实】）。红测试的输入用线上数据库里真实的 `native`：从 `~/.webdcc/webdcc.db` 只读导出 Codex `assistant.message` 事件的 `native` 字段，脱敏后存成 `fixtures/codex/real-agent-messages.json`（这是本文允许的第二处只读访问）。
- **H2** Codex 空思考：`item/completed` 遇到空文本的 reasoning 不许 `return`，照常发 `item.complete`（数据为 `{ text: '' }`），让进行中条目被关闭。前端对空文本的思考本来就不渲染步骤行。

热修不动 `Timeline.tsx` 里已上线的两处兜底（"取最后一条""只显示最后一个思考"），它们在第 5 节随旧渲染逻辑一起删除。

---

## 3. 第一部分：真实轨迹

### 3.1 什么是轨迹

一条轨迹 = 某个 Agent、某个真实模型、某个固定场景下，一次会话的全部原始数据，分两层：

- **原生帧层**：Agent 和 WebDCC 之间来回的每一帧，原封不动，按到达顺序。用来测"翻译"和"轮次模型"。
- **模型层**：Agent 和模型端点之间的每个 HTTP 请求和响应流，原封不动。用来让假模型原样重放，测真实 Agent 进程的行为。

目录结构：

```text
fixtures/traces/<agent>/<model-slug>/<scenario>/
  meta.json            # 版本、模型、思考强度、访问模式、提示词、采集时间、脱敏规则版本、未触发说明
  native.jsonl         # 每行 { i, t, dir: 'in'|'out', ch, frame }
  model.jsonl          # 每行 { i, t, request, response: { status, headers, chunks: [{ t, data }] } }
  reference/           # 参照物：见 3.6
  expected.turns.json  # 黄金轮次视图：见 4.7
```

`t` 是相对会话开始的毫秒数。`ch`（通道）的取值：

| Agent | `ch` | 内容 |
|---|---|---|
| Codex | `rpc` | app-server 的 JSON-RPC 帧，双向（`rpc.ts` 已有 `onFrame` 钩子） |
| Claude Code | `sdk` | `query()` 迭代出来的每条 `SDKMessage`（入） |
| Claude Code | `input` | 我方喂给 `query()` 的用户消息（出） |
| Claude Code | `canUseTool` | 回调的入参（入）和我方返回值（出） |
| Claude Code | `control` | `interrupt`、`setModel` 等控制调用（出） |
| DSH | `rpc:<endpoint>` | Host API 请求（出）和响应（入） |
| DSH | `mux:<endpoint>` | `remote.mux` 上该次订阅收到的每一帧（入），带 streamId |
| DSH | `events-result` | 我方对 waterfall 事件的回复（出） |

### 3.2 录制入口

- 给三个 adapter 的传输层加统一的 `TraceSink` 接口（`packages/protocol/src/trace.ts`），构造 adapter 时可选传入。不传时零开销。录制是旁路，只读，不改变任何发给 Agent 的内容（满足原装原则）。
- 模型层用一个透明转发代理 `packages/testing/model-proxy`：监听本机动态端口，把请求原样转发到真实端点，同时落盘。它不理解协议，只按字节记录。Agent 通过启动参数或环境变量把模型地址指向它（Codex 用 `-c model_providers.<id>.base_url`，Claude Code 用 `ANTHROPIC_BASE_URL`，DSH 用 `e2e-real/globalSetup.ts` 里现有的 `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY` 方式），这属于 `SPEC.md` 10.3 允许的 Provider 注入方式。

### 3.3 采集脚本

`pnpm trace:record --agent <codex|claude-code|dsh> --scenario <id|all> [--model <slug>]`

- **环境完全隔离**：`HOME`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`DSH_HOME` 都在 `$TMPDIR/wdcc-trace-<runId>/` 下；工作区是示例仓库的全新副本（复用 `e2e-real/globalSetup.ts` 里建 `sample-repo` 的逻辑，其中 `AGENTS.md`、`CLAUDE.md` 标记里的 runId 固定写成 `trace`，保证每次采集的工作区内容相同）；DSH 用临时 `DSH_HOME` 另起一个实例，**不连接 3080**。
- **读取 Key**：真实的端点和 Key 通过服务端现有的 Provider 解析逻辑（`packages/server/src/providers.ts` 的 `runtimeConfig(id)`，以只读方式打开线上数据目录）取得，只存在于脚本内存和子进程环境变量里，不落盘、不打印、不进轨迹。DSH 的 Key 如果只存在 DSH 自己的凭据里，走服务端现有的读取 DSH Provider 的代码路径只读取得；取不到就按下面的"DSH 的降级"处理。脚本开始和结束各记一次真实配置文件的哈希，必须一致。
- **只由人显式运行**：不进 `accept:*`，不进 CI。每个场景默认只采一次；采集失败（网络错误、Agent 崩溃）最多重采一次。模型没有按预期触发某个行为（例如没用提问工具）不算失败，在 `meta.json` 里记 `notTriggered` 和原因，不重采。
- **DSH 的降级**：现有的环境变量方式接的是假模型，换成真实端点时协议是否对得上需要【实现时核实】。如果临时 DSH 实例无法接上真实端点，DSH 只采原生帧层，方式是以 attach 模式连接用户的 DSH、只操作脚本自己新建的会话和临时工作区、绝不处理别的会话的审批。这种情况要在 `docs/progress.md` 写明，DSH 的模型层重放（3.7）相应跳过。
- **采哪些组合**：线上"Agent 与 Provider"页里当前配置的每个 Harness × Provider × 模型组合。主组合（每个 Harness 用户默认使用的那个模型）采全部场景；其余组合只采 S01–S03。Codex 的主组合另外用高一档的思考强度多采一次 S02。

### 3.4 脱敏与扫描

`pnpm trace:redact <dir>` 在入库前处理，`pnpm trace:scan` 作为守卫：

- 删除或替换：`Authorization`、`x-api-key`、`Cookie`、`Set-Cookie`、任何 `token=`；Key（`sk-` 等）；端点主机名和 IP 换成 `provider.example`；运行用户的家目录换成 `~`；邮箱、账号 id。
- 加密的思考内容（例如 Codex 的 `encrypted_content`）替换为 `"<redacted:N bytes>"`，保留长度。
- `trace:scan` 从真实配置里读出 Key 和端点主机名（不打印），在 `fixtures/traces/` 和 git 暂存区里搜索，**只输出命中次数**。命中不为 0 时提交失败（加进 `pnpm lint`）。

### 3.5 回放：三层测试

把每个 adapter 拆成两部分：

- **传输层**（进程、RPC、WebSocket、SDK 调用）：有 IO。
- **翻译器**（`packages/adapters/<agent>/src/translator.ts`）：`feed(frame: TraceFrame): AdapterEvent[]`。纯逻辑：不做 IO，不读时钟（时间取帧的 `t`），不用随机数；`itemKey` 一律由原生 id 派生，原生没有 id 的用"通道 + 帧序号"派生。

**纯增量帧登记表**：每个翻译器导出 `DELTA_FRAMES`（例如 Codex 的 `item/agentMessage/delta`），只有登记在内的帧允许不产生持久事件。

| 层 | 怎么跑 | 测什么 | 速度 |
|---|---|---|---|
| L1 翻译回放 | Vitest：`native.jsonl` → 翻译器 → `reduceTurn`（4.5）→ 每一帧之后检查不变量（4.6），结束后对比 `expected.turns.json` | 翻译和轮次模型 | 毫秒级，全部轨迹都跑 |
| L2 界面回放 | Playwright：`ReplayAdapter` 按轨迹的时间（可加速）把帧喂给真实翻译器，后面接真实的服务端和浏览器 | 流式过程中的界面、刷新一致、截图 | 秒级 |
| L3 真实 Agent | 现有 M8 真实套件，假模型换成 3.7 的录像重放 | 进程、审批、打断、恢复 | 分钟级 |

`ReplayAdapter` 取代 `packages/testing/fake-adapter` 里脚本化的事件；原有的 fake e2e 里与 Agent 输出有关的用例改用它，弱网、认证、上传这类与 Agent 输出无关的用例不动。

### 3.6 参照物：真实情况应该长什么样

采集时顺手保存，放在 `reference/`，作为"最终回答是什么"的独立证据：

- **Codex**：原生 `final_answer` 条目的文本，存 `final.txt`。
- **Claude Code**：`result` 消息里的 `result` 字段，存 `final.txt`。
- **DSH**：轮次结束后调 `session/page` 取完成态，存 `page.json`；并用无头浏览器打开**临时 DSH 实例**的原版界面，对收起和展开两种状态各截一张图（`dsh-collapsed.png`、`dsh-expanded.png`）。DSH 原版界面怎么折叠这一轮，就是 WebDCC 的标准答案。

### 3.7 模型层重放

`packages/testing/mock-models` 新增协议无关的重放服务：按"第 N 个请求返回第 N 段录制的响应"，响应头和 SSE 字节原样回放，节奏按录制的 `t`（可加速）。

- M8 真实套件里 `AG-*` 用例的假模型换成对应场景的录像重放。因录像与手写计划行为不同而需要改断言时，属于"以真实行为为准"，按 `SPEC-M8.md` 1.2 的规则在 PR 里逐条列出，证据就是轨迹。
- 请求与录像对不上（例如请求次数不同）时重放服务返回 500 并在日志里写明第几个请求，不许静默兜底。

### 3.8 场景

每个场景的提示词固定如下，逐字使用，不许改写。工作区是示例仓库副本。除特别说明外用各 Agent 的默认访问模式。

| ID | 提示词 | 采集时的操作 | 主要验证 |
|---|---|---|---|
| S01 | `用一句话解释什么是幂等。不要使用任何工具。` | — | 思考 → 最终回答 |
| S02 | `先列出当前目录的文件，再读 README.md，然后用三句话告诉我这个仓库是做什么的。` | — | 过程说明、工具、最终回答的区分 |
| S03 | `新建 notes.txt，内容两行：第一行 alpha，第二行 beta。然后把 README.md 的标题改成 "Sample Repo (edited)"。做完后告诉我改了什么。` | — | 改动卡片、diff |
| S04 | `在 /tmp 下创建文件 wdcc-trace-probe.txt，内容为 ok。` | 审批出现后选"允许一次" | 审批通过 |
| S05 | `在 /tmp 下创建文件 wdcc-trace-probe-2.txt，内容为 ok。` | 审批出现后选"拒绝" | 审批拒绝后的收尾 |
| S06 | `运行 sleep 60，然后告诉我完成了。` | 命令开始 3 秒后打断 | 打断、未完成条目的收尾 |
| S07 | `这个任务分三步做，先给出计划再执行：1) 新建 a.txt 写入 1；2) 新建 b.txt 写入 2；3) 把两个数相加写入 sum.txt。` | — | 计划、任务、目标面板 |
| S08 | `在动手之前，先用提问工具问我想用哪种语言写 hello world（给出 Python 和 JavaScript 两个选项），等我回答后再写。` | 选第一个选项 | 提问 |
| S09 | `运行命令 false-command-wdcc（它不存在），把报错原样告诉我，不要重试。` | — | 失败的命令 |
| S10 | 第一轮 `读取 README.md 的第一行。`；第二轮 `再读第二行。` | 第一轮的完成事件一到就发第二轮 | 轮次边界、晚到的事件 |
| S11 | `运行 seq 1 3000，然后只告诉我最后一个数字。` | — | 长输出 |

S04、S05 结束后脚本删除 `/tmp/wdcc-trace-probe*.txt`。

---

## 4. 第二部分："一轮对话"的统一模型

### 4.1 概念

- **轮（Turn）**：从"服务端接受了用户的一次发送"到"这一轮终止"。它的身份只有一个：服务端在接受发送时分配的 `turnId`（ULID）。原生的轮次编号只是它的一个属性 `nativeTurnId`，**永远不用来分组**。
- **条目（Item）**：轮里的一个单元（一段思考、一段文字、一条命令、一次审批……）。条目有生命周期：打开 → 关闭。打开着的条目就是界面上"进行中"的那一行。
- **轮次视图（TurnView）**：由一轮的全部持久事件加上当前打开的条目算出来的结构，是界面的唯一输入。

### 4.2 轮的状态机

```text
starting ──► running ◄──► waiting ──► completed | interrupted | failed
   │            │
   └────────────┴──► failed（发送失败 / Agent 进程退出）
```

- `starting`：已写入用户消息和 `turn.started`，Agent 还没确认。
- `waiting`：这一轮里有尚未处理的审批或提问。
- 终止态三种，进入后不再改变。

**会话状态由轮的状态派生**，adapter 不再发 `status` 事件：没有活动轮 → `idle`；活动轮是 `starting`/`running` → `running`；`waiting` → `waiting`；最近一轮 `failed` 且之后没有新轮 → `error`。

每一轮必然有终止事件。下面几种情况由 `TurnTracker` 负责补上终止，不许留下永远"运行中"的轮：

| 情况 | 终止为 |
|---|---|
| `adapter.send()` 抛错 | `failed`，同时写一条 `error` 事件说明原因 |
| Agent 进程退出、连接断开且无法恢复 | `failed` |
| 会话被回收（`dispose`）时仍有活动轮 | `interrupted` |
| 服务启动时发现上次留下的未终止轮 | `interrupted`，`reason: 'server-restart'` |

### 4.3 事件归到哪一轮（只有一处决定）

adapter 发出的事件不带 `turnId`，只带可选的 `nativeTurnId`。`TurnTracker` 按下面的顺序决定归属，命中即止：

1. 事件带 `nativeTurnId`，且它已经绑定到某一轮 → 归那一轮。
2. 事件带 `nativeTurnId` 但还没绑定，且存在 `starting` 的轮 → 绑定到它并归它。
3. 存在活动轮 → 归活动轮。
4. 没有活动轮，事件属于"收尾类"（条目关闭、改动、用量），且上一轮终止不超过 10 秒 → 归上一轮，事件上标 `late: true`。
5. 其余 → 轮外事件，`turnId` 为 `null`，只在轨迹标签显示。

Codex 的 `turn/diff/updated`、`item/completed` 相对 `turn/completed` 的先后顺序【轨迹核实】（S03、S10）；第 4 条的 10 秒窗口按轨迹里实际出现的最大延迟调整。

### 4.4 最终回答（只有一处决定）

运行中没有"最终回答"这个概念：所有文字按时间顺序出现在过程里。轮终止时，`TurnTracker` 调用纯函数 `resolveAnswer(turnEvents)` 一次，把结果写进 `turn.completed` 事件的新字段 `answerItemKeys: string[]`。界面只读这个字段。已存的事件不改写。

`resolveAnswer` 的规则，按顺序，命中即止：

1. **原生有明确标记**：Codex 助手消息 `native.phase === 'final_answer'`（以及 `partial_answer`，【轨迹核实】）。
2. **原生有结构信息**：
   - Claude Code：所在 assistant 消息的 `stop_reason` 不是 `tool_use` 的文字块；并与 `result.result` 的文本核对。
   - DSH：以 `session/page` 完成态和原版界面截图为准找出判定依据（消息上的结束原因字段，或"该消息之后本轮没有工具调用"）【轨迹核实】。
3. **兜底**：这一轮里最后一个"动作类"事件（命令、读、改、工具）之后出现的助手消息。
4. 都没有（例如被打断时还没开始回答）→ 空数组。界面显示全部过程，不显示"带到…"。

`turn.completed` 里没有 `answerItemKeys` 的历史数据，读取时现场调用同一个 `resolveAnswer`，所以不需要数据迁移；规则 1 读的是 `native`，线上那 5 条被错标的 Codex 回答会自动恢复正确显示。

`assistant.message.phase` 字段废弃：翻译器不再填它，改为把原生标记原样放进 `data.nativePhase`（Codex）或保留在 `native` 里。

### 4.5 `reduceTurn` 与 `TurnView`

在 `packages/protocol/src/turn.ts` 实现纯函数，服务端、前端、L1 测试共用同一份：

```ts
export function reduceTurn(events: StoredEvent[], open: OpenItem[]): TurnView;

export interface TurnView {
  turnId: string;
  state: 'starting' | 'running' | 'waiting' | 'completed' | 'interrupted' | 'failed';
  user: { text: string; images?: string[]; at: string };
  startedAt: string;
  durationMs?: number;
  /** 标题行唯一的活动指示；终止态为 null */
  activity: null | { kind: 'thinking' | 'writing' | 'running' | 'waiting'; label?: string };
  /** 过程：按顺序排列的步骤（过程说明、有文本的思考、命令、读、改、工具、审批、提问、提示、错误） */
  steps: Step[];
  /** 进行中的条目，每个都对应一个尚未关闭的原生条目 */
  live: LiveItem[];
  /** 最终回答；非终止态恒为空 */
  answer: { itemKey: string; text: string }[];
  /** 改动汇总，规则见下 */
  changes: { path: string; kind: 'add' | 'modify' | 'delete'; added: number; removed: number; diffFileId?: string; note?: string }[];
  summary: { commands: number; reads: number; edits: number; tools: number };
  plan?: PlanItem[];
  goal?: { objective: string; status: string };
  usage?: UsageData;
}
```

规则：

- **`activity`**：由 `live` 派生，优先级 `waiting` > `running`（有打开的命令或工具）> `writing`（有打开的文字条目）> `thinking`。所以标题行同一时刻只有一个状态，"思考中"最多一行，这是模型保证的，不是过滤出来的。
- **空内容的条目**：文本为空的思考（加密思考）照常打开和关闭，影响 `activity`，但不进 `steps`。
- **改动汇总**：两种语义分开。`file.change` 表示"这一次工具调用改了什么"；新增事件种类 `turn.diff` 表示"这一轮到目前为止累计的 diff"（Codex 的 `turn/diff/updated`）。一轮里有 `turn.diff` 时，`changes` 取**最后一条** `turn.diff`；没有时，按路径合并各条 `file.change`（同一路径后到的覆盖先到的）。`file.change.snapshot` 字段废弃。Codex 是否会发"只含部分文件的" `turn/diff/updated`【轨迹核实】（S03）；如果会，以轨迹为准改这条规则并写明证据。
- **刷新一致**：`reduceTurn` 只依赖持久事件和打开的条目。一轮终止后 `open` 为空，所以流式看到的结果和刷新后看到的结果必然相同。

### 4.6 不变量

L1 对每条轨迹的每一帧之后都检查；任何一条被破坏，测试失败并报出轨迹、帧号和不变量编号。

| 编号 | 不变量 |
|---|---|
| I1 | 每个打开的条目在本轮终止前被关闭或取消；终止后 `live` 为空 |
| I2 | 同一个 `itemKey` 至多打开一次；关闭后不再接受增量 |
| I3 | 一轮的所有事件 `turnId` 相同；`user.message`、`turn.started`、终止事件各恰好一条；`user.message` 的 `seq` 最小 |
| I4 | 终止态的轮 `activity` 为 `null`、`state` 不再变化 |
| I5 | `completed` 的轮：`reference/final.txt` 存在时，`answer` 的文本拼接逐字节等于它 |
| I6 | 流式增量拼接出的文本等于完成态文本（不等时以完成态为准，并产生一条 `notice`） |
| I7 | 逐帧流式得到的最终 `TurnView`，等于只用持久事件重算得到的 `TurnView` |
| I8 | 每个入帧要么产生至少一个事件（含 `internal`、`unknown`），要么登记在 `DELTA_FRAMES` 里 |
| I9 | 同一条轨迹回放两次，`itemKey` 序列和 `TurnView` 完全相同 |
| I10 | 同一时刻至多一个打开的思考条目、至多一个打开的文字条目（如果某个 Agent 的真实轨迹里确实并行，【轨迹核实】后按 Agent 放宽并写明证据） |

### 4.7 黄金文件

`expected.turns.json` 是该轨迹最终的 `TurnView[]`（去掉时间戳）。它由脚本首次生成，但**生成不等于正确**：提交前必须逐条对照 `reference/` 里的参照物核对，并在 PR 描述里为每个场景写一行"最终回答、步骤数、改动文件数与参照物一致"。以后黄金文件的任何变化都要在 PR 里解释原因。不变量是硬约束，黄金文件是防回归的辅助，不能用改黄金文件的办法让不变量通过。

### 4.8 接口变化

`packages/protocol/src/adapter.ts` 的 `AdapterEvent`：

- 删除 `{ type: 'status' }`。
- `item.start`、`item.complete` 上的 `turnId` 改名为 `nativeTurnId`。
- 新增 `{ type: 'item.cancel'; itemKey: string }`（条目没有结果就结束，例如被打断）。
- 新增 `{ type: 'turn.start'; nativeTurnId?: string; native?: unknown }` 和 `{ type: 'turn.end'; nativeTurnId?: string; status: 'completed' | 'interrupted' | 'failed'; usage?: UsageData; native?: unknown }`，取代 adapter 自己发 `turn.started`、`turn.completed` 条目。

`packages/server/src/turn-tracker.ts`（新）：从 `manager.ts` 里拆出轮次的创建、绑定、终止、事件归属、打开条目的登记与强制关闭、会话状态派生、`answerItemKeys` 定稿。`manager.ts` 里下列逻辑随之删除：`runtime.turnStartedStored` 和"重复的 `turn.started` 降级为 `internal`"、`status` 分支里"轮次已结束时忽略迟到状态"的守卫、`approve()` 里"轮次已结束就改回 `idle`"。

`events.ts`：新增 `turn.diff`；`turn.completed` 增加 `answerItemKeys`、可选 `reason`；`assistant.message` 的 `phase` 和 `file.change` 的 `snapshot` 标为废弃（读旧数据时仍要认）。

---

## 5. 界面

### 5.1 渲染

- `packages/web/src/lib/store.ts` 的 `getTurns()` 改为对每一轮调用 `reduceTurn`，返回 `TurnView[]`。
- `Timeline.tsx` 的轮次组件只接收 `TurnView`。展示规则沿用 `docs/ui-harness.md` 第 5 节和 `SPEC.md` 9.4：运行中显示全部步骤和进行中条目，标题行显示 `activity`；终止后默认收起，只显示 `answer`、改动卡片、需要处理的卡片和页脚，点标题展开全部 `steps`。
- 任务条、目标行读 `TurnView.plan`、`TurnView.goal`。

### 5.2 必须删除的猜测代码

| 位置 | 内容 |
|---|---|
| `Timeline.tsx` | `finalMessage` / `anyAssistantMessage` / `displayedFinalMessage` |
| `Timeline.tsx` | `turn.hot.filter(...)` 里对 reasoning 只留最后一个的过滤 |
| `Timeline.tsx` | `running`、`waitingOnUser` 的现场推断 |
| `Timeline.tsx` | `collectChanges`、`summarize` |
| `store.ts` | `delta` 分支里"没收到 update 也要能接住增量"的兜底建条目 |
| `store.ts` | `applyEvent` 里 `turn.completed` 时清空全部进行中条目 |

删除后如果某个现象重新出现，说明翻译器或 `TurnTracker` 违反了不变量，去那一层修。

### 5.3 界面验收

L2 对每个主组合的每个场景：

- 回放过程中，标题行的活动文字在任意时刻只出现一处。
- 回放结束后，页面上的最终回答文本逐字节等于 `reference/final.txt`（DSH 取 `page.json` 里的对应文本）。
- 刷新页面、以及在另一个浏览器上下文打开同一地址，轮次区域的文本与刷新前完全相同。
- 收起和展开各截一张图存入 `docs/acceptance/M9/shots/`。DSH 场景的截图与 `reference/dsh-collapsed.png`、`dsh-expanded.png` 并排生成对照页 `docs/acceptance/M9/dsh-compare.html`，供用户看。

---

## 6. 开发、验收、线上分开

1. **线上从独立目录运行。** 发布目录 `/opt/webdcc/releases/<commit>/`，`/opt/webdcc/current` 是指向当前版本的软链。`webdcc.service` 的 `WorkingDirectory` 和 `ExecStart` 改为指向 `/opt/webdcc/current`。数据目录和 `/etc/webdcc.env` 不变。
2. **发布脚本** `pnpm release`：要求工作区干净且 `HEAD` 已推送 → 在临时目录做干净检出、`pnpm install --frozen-lockfile`、`pnpm build` → 把运行所需的文件拷到新的发布目录 → 备份数据目录 → 切换软链 → `systemctl restart webdcc` → 检查 80 端口未登录返回 401、`/api/meta` 的版本等于该 commit → 失败则切回上一个版本并重启。保留最近 5 个版本。**只重启 WebDCC，不动 DSH。**
3. **验收不再往仓库的 `dist` 里构建。** `accept:*` 和 `e2e-real/globalSetup.ts` 把前后端构建到 `$TMPDIR/wdcc-accept-<runId>/build/`，测试服务从那里启动。服务端的 `webDist` 目前只能由工作目录决定（`packages/server/src/main.ts`），新增环境变量 `WDCC_WEB_DIST` 让它可以显式指定。仓库里的 `packages/*/dist` 只给本地开发用，线上不再读它。
4. `/api/meta` 增加 `commit` 和 `builtAt`，"Agent 与 Provider"页底部显示，方便用户确认线上跑的是哪个版本。
5. `docs/deploy.md` 同步更新。

第一次切换会重启一次 WebDCC（几秒），在 PR-1 合并后立刻做，并在 `docs/progress.md` 记录切换前后的 commit。

---

## 7. 同步修改的文档

- `SPEC.md`：5.1 的 `AdapterEvent`、6.1、6.2（删除 `phase` 那一条，换成本文 4.4）、6.3（Codex 一列补上 `phase` 的真实取值）、9.4（改为引用 `TurnView`）、第 13 节（假模型改为录像重放）、4.2 的仓库结构。
- `SPEC.md` 3.1 的 R3 补一句与现状一致的例外："用户在 Provider 页面显式保存时，可以写入对应 Harness 的 Provider 配置；创建和运行会话的路径不写任何配置文件"，并在 `native.spec.ts` 里加断言守住后半句。
- `docs/protocol-notes.md`：每个【轨迹核实】项的结论和帧原文；三个 Agent 各自的 `DELTA_FRAMES` 和内部事件清单。
- `docs/progress.md`：补上 2026-11-12 以来的提交，新增 M9 一节。
- `README.md` 的"测试"一节。

---

## 8. 执行顺序

每个 PR 先红后绿，合并前 `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e` 全绿，M8 已通过的用例不许变红。

| PR | 内容 | 完成的标志 |
|---|---|---|
| PR-0 | 第 2 节：现场交接、H1、H2 | 两个热修各有一条用真实 `native` 样本写的测试，修复前红、修复后绿 |
| PR-1 | 第 6 节：发布目录、发布脚本、验收构建隔离；切换线上 | 线上运行在 `/opt/webdcc/current`；在仓库里执行 `pnpm build` 前后，线上首页的资源文件哈希不变 |
| PR-2 | 3.1–3.4：`TraceSink`、模型代理、采集脚本、脱敏、扫描；采集全部组合 | `fixtures/traces/` 入库；`trace:scan` 命中 0；每个主组合 11 个场景齐全（未触发的有说明） |
| PR-3 | 3.5 的翻译器拆分、L1 测试框架、4.6 的不变量检查 | L1 能跑；**此时不变量大面积失败是预期的**，把失败清单（轨迹、帧号、编号）贴进 PR，作为"红" |
| PR-4 | 第 4 节：`reduceTurn`、`resolveAnswer`、`TurnTracker`、接口变化；三个翻译器改到不变量全绿；生成并核对黄金文件 | L1 全绿：全部轨迹 × 全部不变量；每个【轨迹核实】项有结论 |
| PR-5 | 第 5 节：界面改为渲染 `TurnView`，删除 5.2 的代码；`ReplayAdapter`；L2 | L2 全绿；截图和 DSH 对照页入库 |
| PR-6 | 3.7：模型层重放接入 M8 真实套件的 `AG-*` | `AG-*` 在录像重放下全绿；改过的断言逐条列出 |
| PR-7 | 第 7 节文档；`pnpm release`；真实模型冒烟 | 见第 9 节 |

M3–M5 那样互不依赖的并行在这里不成立：PR-2 到 PR-5 有先后依赖，按顺序做。某个 PR 按 `SPEC-M8.md` 1.5 的停止条件卡住时，停在当前分支并写 `docs/progress.md`。

---

## 9. 完成标准

1. `pnpm accept:m9` 在干净检出上退出码为 0。它依次执行：typecheck、lint、`trace:scan`、单测（含 L1）、L2、M8 棘轮（M8 已通过的用例数不减少）。
2. 报告由脚本生成并提交：`docs/acceptance/M9/report.json`、截图、`dsh-compare.html`。汇总行格式：
   `M9 ACCEPTANCE: traces <n> · invariants <通过>/<总数> · replay-ui <通过>/<总数> · m8-ratchet <通过数> @ <commit>`
3. 已按第 6 节发布到线上。
4. 线上真实模型冒烟：通过线上界面，对三个 Agent 各发一次 S02 的提示词，各保存一张完成后的截图到 `docs/acceptance/M9/smoke/`，并确认页面上的最终回答与该 Agent 原生给出的最终回答一致。某个 Agent 当前没有可用的 Provider 时，截图证明并写进报告。
5. 最终汇报只写：汇总行原文、每个【轨迹核实】项的结论（一行一条）、改过的断言清单、未完成或未触发的项。不写成功总结。

审查方会独立对 `fixtures/traces/` 重跑不变量，并在线上抽查。

---

## 10. 不在本文范围

下面这些已知要做，但不在 M9 里做，另出文档：

- Provider 的统一模型（Harness → Provider → 模型 → 思考强度）和新会话页的选择方式。
- 斜杠命令和输入的解释方式（哪些交给 Agent、哪些在本地处理）。
- M8 里尚未实现的用例。
- "在另一个 Agent 中继续"入口的可发现性。

M9 期间这些地方出了问题，只做不改变设计的最小修复，并记进 `docs/progress.md`。
