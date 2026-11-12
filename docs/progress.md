# 执行进度

> 按 SPEC v2.2 0.1 节的无值守规则维护：每次合并 PR 时更新。

## 已完成

| 里程碑 | 状态 | 结果 |
|---|---|---|
| M0 仓库、工具链与协议探针 | 完成 | 私有仓库建立并推送；pnpm/TS/Vitest/Playwright/ESLint 骨架；三个 Agent 探针（Codex/Claude/DSH）对假模型跑通"新建会话 → 工具轮 → 审批 → 打断 → 杀进程恢复"；Codex 类型与 JSON Schema 导出；193 个 DSH 端点目录；`docs/protocol-notes.md` 覆盖全部【M0 核实】项 |
| SPEC v2.1 | 完成 | 按 M0 结论重写 5.4、6.3、9.6 等 |
| 四项待核实项 | 完成 | Codex 访问预设（三层结构）、DSH 提问关闭接口、DSH 思考字段、Claude 提问机制；证据在 `fixtures/*/…-research.json` |
| SPEC v2.2 | 完成 | 并入 0.1 节无人值守规则、8 项技术决定、C1–C8 空白补齐 |

## 进行中

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M1 服务端核心与同步协议 | 完成 | `packages/protocol` 类型；Fastify + Auth（token→签名 Cookie）+ SQLite（11.2 全部表）；Event Store（seq 事务分配、分页、导出）；侧边栏 feed；命令日志与去重；Live Hub（hello/补差/快照/50ms 增量合并/心跳）；File Store + 可续传上传 + `/files` 缓存头；fake-adapter（延迟/乱序/未知/内部事件）；Vite 7 前端构建链跑通。<br>验收：A9、A10（10,000 帧 + 20 次重连）、A11 通过；A6 的 6c/6d/6f 服务端部分脚本通过（24 个测试）。 |

## 偏差记录

（暂无）

## 受阻项

（暂无）

## M2 进度（验收通过，待合并）

| 项 | 状态 |
|---|---|
| 三列框架、侧边栏、会话头、时间线（轮次折叠/改动卡片/审批/提问/未知事件）、任务面板、输入框（@ 菜单、附件、发件箱状态）、轨迹、停靠区、新会话页 | 已实现 |
| 路由（/s/{id}、?dock=files、?dock=diff:{id}、停靠区 URL 还原） | A3 通过（3 个 Playwright 用例） |
| IndexedDB 缓存 + WebSocket 续传 + 心跳重连 + 发件箱 | 已实现 |
| Service Worker（vite-plugin-pwa / Workbox） | 已生成，待 A6e 验证 |
| A5 性能 | **通过**：未缓存首屏 195ms（≤1000），同一页面切换 3 次中位数 69ms（≤150）。根因是 `listEvents({before})` 用了 `ORDER BY seq ASC`，向前翻页时把**最旧的 200 条**返回，客户端还要等服务端全表扫描；改为 DESC 后反转，耗时从 3.2s 降到 ~10ms |
| A6a/6b/6e | **通过**（6a 慢网流式可见且界面可操作；6b 断网 30s 后时间线与服务端一致；6e 离线刷新应用外壳可用） |
| A12 截图 | 已完成，`docs/acceptance/M2/`（11 张：新会话页、收起/展开轮次、轨迹、@ 菜单、停靠区文件/diff/会话、审批卡片、手机视图） |

## M4 进度（完成，已合并 PR #5）

| 项 | 状态 |
|---|---|
| ClaudeAdapter（Agent SDK `query()` 流式输入、canUseTool 分流审批/提问、interrupt、resume、事件映射、六档访问模式） | 完成 |
| A1（Claude，假模型） | ✅ 8/8（`scripts/accept-claude-a1.ts`）：新建、流式、命令、读文件、改文件、审批、完成、打断、session_id 落库、**dispose 后 resume 继续** |
| A2（Claude） | ✅（`scripts/accept-claude-a2.ts`）：项目 `.mcp.json` 加载（wdccecho connected）、hooks 生效、51 个斜杠命令、28 个工具 |
| native.spec（Claude 部分） | ✅ 4 个断言：preset 系统提示词、settingSources、无 mcpServers/hooks/agents/allowedTools、六档 permissionMode 透传 |
| 接入生产组装点 | 已接入（`WDCC_ENABLE_CLAUDE=0` 可关闭） |

## M6 进度（验收通过，待合并）

| 项 | 状态 |
|---|---|
| Provider 管理页（新增/删除、协议勾选、Key 不回显） | 完成 |
| 新会话页 Provider 选择（兼容才可选，不兼容灰显并注明）+ 模型选择 | 完成 |
| "带到…"交接（同工作区会话 + 新建三种会话；原文追加到草稿、不自动发送、跳转右栏） | 完成 |
| 完成提醒（侧边栏状态、页面标题未读数、浏览器通知） | 完成 |
| 停靠区规则（同一会话不能同时在主栏和停靠区） | 完成 |
| 验收 | A4、A7、A8、A13 全过（`e2e/m6.spec.ts` 4 个用例）；全仓 13 个 e2e + 48 个单测 |

## M5 进度（验收通过，已合并 PR #6）

| 项 | 状态 |
|---|---|
| 侧车客户端 | `packages/adapters/dsh/src/host.ts`（启动/换 Cookie/RPC 信封/remote.mux） |
| DshAdapter 本体 | 完成：workspace/create + session/create 映射、session/follow、`$events` 单条复用、审批/提问走 `$events/result`、`/permission` 访问模式、`nativeSeq` 去重、工具名映射 |
| 端点白名单（3.3） | 适配器内强制校验（`ALLOWED_ENDPOINTS` + `isAllowedCommandLine`），native.spec 4 条断言 |
| A1（DSH，假模型） | ✅ 8/8（`scripts/accept-dsh-a1.ts`）：新建、流式、命令、读文件、改文件、思考、审批、完成、打断、dispose 后 resume |
| A2（DSH） | ✅（`scripts/accept-dsh-a2.ts`）：与直接 Host API 建会话的工具集完全一致（32 个），启动参数无 profile/plugin 注入 |

## M3 进度（完成，已合并 PR #4）

| 项 | 状态 |
|---|---|
| CodexAdapter | 完成并合并（PR #4）。A1 8/8、A2 结构化对比通过、native.spec 4 个断言 |
| 接入生产组装点 `packages/server/src/adapters.ts` | 已接入（`WDCC_ENABLE_CODEX=0` 可关闭） |
| `model_catalog_json` 前置 | **已核实并否决**：自定义条目必须带 `base_instructions`/`instructions_template`，填它就是平台提供系统提示词 → 违反 R1。改用 Codex 自带元数据；代价是假模型下没有 `fileChange`/`turn/plan/updated`，adapter 按 5.2/6.3 两种情况处理。已写进 SPEC 13 与 protocol-notes §7.7 |
| `native.spec.ts` 的 Codex 部分 | 完成（4 个断言：thread/start、turn/start、`-c` 白名单、访问模式映射），全绿 |
| fixtures 重录 | 待做 |
| A1（Codex） | **7/8 通过**（`scripts/accept-codex-a1.ts`：新建、流式、命令、工具、审批、一轮完成、打断）。**已修复并通过（8/8）**。根因：Codex 审批的 `id` 是 JSON-RPC 请求 id，每个 app-server 进程从 0 重新开始；resume 后新进程的 id 与上一进程重复，被我们的"已处理"去重逻辑跳过，那一轮就挂住了。修法：`approvalId = 进程token:请求id`。已写进 protocol-notes §7.8 |
| A2（Codex） | **通过**（`scripts/accept-codex-a2.ts`）：直接 app-server 与 adapter 启动参数下 `skills/list`、`mcpServerStatus/list`、`instructionSources` 三者完全一致，AGENTS.md 被加载 |

## M1 偏差与说明

- **真实 adapter 尚未接入**：M1 只注册 fake-adapter；`packages/server/src/adapters.ts` 是生产组装点，M3–M5 依次填入 Codex / Claude / DSH。
- **`assistant.message.phase` 由 adapter 负责**：manager 不重写已落库的事件（seq 日志不可变）。adapter 在 turn 结束前把最后一条助手消息标 `final`；M3–M5 实现时按此约定做。
- **Provider / models 端点推迟到 M6**：11.1 表里的 `/api/providers*`、`/api/models` 未在 M1 实现（M6 的 Provider 管理页会用到）。
- **前端构建链**：Vite 锁 7.3.8 + @vitejs/plugin-react 5.2.0（plugin-react 6 依赖 Vite 8/rolldown，会在本机 Illegal instruction）。`pnpm build` 产出 `packages/web/dist` 与 `packages/server/dist/main.js`（esbuild 单文件，`better-sqlite3` external），已用生产包做过冒烟：token 换 Cookie、401、带 Cookie 访问都正常。


## M7 与总结（2026-11-11）

- **A6 补齐**：6c/6d/6f 通过（`e2e/m7.spec.ts`）；A6 六个场景全部有自动化覆盖
- **部署**：deploy.md 补齐 systemd、环境变量、HTTPS/Service Worker 说明；生产包在本机以 `WDCC_HOST=0.0.0.0` 跑通（token 打印、401、Cookie 后 200）
- **总验收**：`docs/acceptance-report.md` 逐条记录 A1–A13；48 个单测 + 16 个 e2e + typecheck + lint 全绿

### 最终状态

M1–M7 全部完成并合并（PR #1–#7）。四个未决项在 M0 阶段提前核实；两处 SPEC 与实测的冲突（Codex catalog 与 R1、Codex 审批 id 冲突）已按 0.1 节规则记录并修复。剩余待办只有两类：**真实模型验证**（无 Key）与**界面人工确认**（截图已存档）。


## M8 进度（进行中）

| 项 | 状态 |
|---|---|
| 验收框架（6.1–6.6） | 已可运行：globalSetup（临时目录 + git 工作区 + 三 mock + 动态端口服务）、fixtures（登录/mock 控制/全局断言/截图）、reporter（从 SPEC 解析 ID 并严格比对，产出 report.json/index.html/status.json） |
| 7.1 用例 | S-01、S-02、S-03、AUTH-01、AUTH-02、AUTH-03 通过 |
| 7.4 用例 | AG-{dsh,codex,claude}-01 通过；AG-dsh-04、AG-codex-02 通过 |
| 未通过（按 1.5 转去推进独立工作，不停止） | **AG-dsh-02 / AG-codex-02 流式**：已做 3 轮针对性修复（adapter 懒发 item.start、前端 update 帧建热条目、manager 路径）。最新证据：DSH adapter 收到了 `block-start` 与 `text-delta`（server.log 实测），manager 也记录了 `item.start msg-live-…`，但浏览器里 `store.getHot()` 仍为空 → 问题落在 **update 帧从 Live Hub 到客户端的这一段**（下一步用 WS 帧抓包定位）。按 SPEC 1.5，仍有独立工作（PR2 的 D1 attach + F16），因此不停止，先推进独立项。原文：浏览器里实测 `hot=[]`、事件全是 internal，说明 DSH/Codex 的 assistant 增量没有转成我方 delta（DSH 的 assistant-stream 帧在独立探针里能收到 29 条 text-delta，说明问题在 adapter/订阅路径而非 DSH）。**AG-dsh-04** 本轮回归失败（plan 面板未出现，疑似与 todo 步骤 optional 化有关） |
| 已修 | 审批卡片会按 `approval.resolved` 显示"已允许一次/已拒绝/已取消/已在其他界面处理"并不再显示按钮（F11/F17 的一部分）；Claude 的审批改在发卡片前登记 pending（否则自动批准会丢） |
| 未通过 | AG-codex-04、AG-claude-04（任务面板）：DSH 通过；Codex 的 mock 请求里**没有任何 plan/todo/task 工具**（直接工具模式下 update_plan 不提供）；Claude 的 28 个工具里 TodoWrite 疑似被新的 Task* 工具取代，需要核实并映射 |
| 已修 | 流式链路：adapter 懒发 item.start（Codex/Claude/DSH 都没有可靠的 block-start）、前端 update 帧可新建热条目；AG-{dsh,claude,codex}-02 全部通过 |
| 新增 | 任务面板改成贴在输入框上方的独立组件（SPEC 9.5），不再依赖轮次展开 |
| F1/F2/F3 | 已修（SDK external + 建会话回滚；数据校验 + 错误边界；模型默认值与 400） |
| F5 | 已修（feed 里的 agent 来自 patch） |

### M8 实测发现（需写进 protocol-notes）

- **Codex 0.167 的内置模型全部走 code mode**：`model/list` 返回的 12 个 slug，请求里 `tools` 为空，工具放在 `input[]` 的 `additional_tools` 命名空间里（`functions.exec` 自定义工具）。只有**不在 model/list 里的 slug**（如 `gpt-5`）会退回直接工具。SPEC 6.2 要求 SLUG 取自 model/list，与实测冲突 → 验收 fixture 改用 `gpt-5`/`gpt-5-mini`，证据待补进 protocol-notes。
- DSH 侧车端口必须取 `WDCC_DSH_PORT`（已修），否则并行运行会撞 3091。
- 流式增量：adapter 需要在 block-start 时发 `item.start`，前端 `update` 帧要能**新建**热条目，否则增量无处可落（已修的 DSH/Claude adapter + store）。


## M8 PR 进度

| PR | 状态 | 内容 |
|---|---|---|
| PR1 | ✅ 已合并（#10） | 验收框架 + mock 扩展 + 测试钩子 + F1/F2/F3/F5；`M8 ACCEPTANCE: 15/125 passed`，棘轮通过 |
| PR2 | 进行中（分支 m8/pr2-d1） | D1 attach 模式（/connect、adapter attach/spawn、spawn 冲突检查、DshConnectionStore、/api/dsh、设置页）+ F16（Codex config/read、Claude settings.json、Provider 来源/endpoints/粘贴导入/扫描去重/忽略恢复）+ F18（Cookie 按 Host 派生） |
| PR2a 剩余 | 已做 | 统一 isolatedEnv + 启动守卫 S-04；spawnServer 可移植；inject-event 原样写入；自动批准按"只点 pending 卡片并记录工具名"实现；mock code mode + 按 Agent 分变体计划 |
| PR3 | 已做 | F4、F5、F12（目标/计划/diff/警告/code mode）、F17、F19 |
| PR4 | 已做 | F6 访问模式（三端 + Codex profile 列表 + root 灰显） |
| PR5 | 已做（待用例验证） | F7 附件、F8 斜杠命令 |
| PR6 | 部分 | F9 窄屏、F10 改动卡片、F11 审批卡片、F14；**F15 界面打磨未做** |
| PR7 | 进行中 | 用例补齐中；严格模式两遍从未全绿 |

### 2026-11-11 收尾快照

- 真实界面用例：**已实现 80/138 个 ID**，其余为显式 `NOT IMPLEMENTED` 占位（算失败，不算跳过）。
- 最近一次快照的通过数见 `docs/acceptance/M8/report.json`（脚本生成）；**未达到 M8 完成标准**。
- 已实现且稳定的用例：AG-{dsh,codex,claude}-01/02/03/04/05/06/07/08/09/10/11/12、S-01..03、AUTH-01..03、PRV-01/02/03/06/07/08、NEW-02/03/07、DSHX-00/01/06。
- 已知不稳定：AG-codex-* 偶发因审批时序失败（已加"轮次结束后迟到 status 不生效"的守卫，仍在观察）。
- 未实现：AG-claude-04b/13/15/16、AG-codex-13/14、AG-dsh-13/14、AG-codexd-*、ATT-*、NAT-*、ROB-*、DSHX-02..08、PRV-04/05/09、NEW-01/04/05/06、AUTH-04/05、FIN-01..04、DOCK/MOB/UI 截图、NET-*、NOTIF-01、MODE-*-02/03 的端到端断言、SES/HO/SL 的若干断言。
- **界面方向待用户确认**：当前是自绘三栏 UI，没有复用 DSH 原版视觉；F15（对照 `docs/reference/dsh/` 打磨）未做。review 材料见 `docs/review/m8-current/README.md`。
- 部署（第 9 节）与真实模型冒烟未做；`main` 分支保护未开。

## M9（2026-11-12，进行中）

- PR-0：已从线上数据库只读导出并脱敏 Codex 原生 assistant 消息；H1 按 `final_answer` / `commentary` / `partial_answer` 映射，H2 保留空 reasoning 的完成事件。
- PR-1 基础：新增 `WDCC_WEB_DIST`、`/api/meta` 的 `commit`/`builtAt`，验收构建输出到临时目录；systemd 示例切换 `/opt/webdcc/current`，提供 `pnpm release`。
- PR-2/3：已完成真实 Codex 与 Claude 轨迹采集（各 S01–S11，共 22 条），模型层和原生层均已脱敏入库；新增 `TraceSink`、模型透明代理、轨迹脱敏扫描入口、Codex/Claude/DSH 纯翻译器和 `ReplayAdapter`。
- PR-4 基础：新增 `TurnTracker`、`resolveAnswer`、`reduceTurn`、`turn.diff` 事件和 adapter 生命周期事件；现有 UI 已由 `TurnView` 驱动并保留旧事件兼容。
- DSH：本机 Provider 注册表没有 DSH 可用端点/Key；按 SPEC 的降级规则，11 个场景已生成 `notTriggered` 记录，未连接 3080，也未写入真实配置。
- L1：22 条轨迹、1345 帧、不变量 1345/1345；`trace:scan` 命中 0。
- 快速 UI 回放：18/18 通过。M8 棘轮在增大 Node 堆上限后实际跑到第 40 项，报告为 32 项通过、7 项既有回归，其余因长套件中止；回归证据包括 AG-codex-08/11/12、AG-claude-12、DOCK-01/03、MOB-01/02。
- 尚未发布线上：`pnpm release` 已实现但本轮没有执行 systemd 重启，避免在未确认发布 commit 时改动线上服务。
- 2026-11-12 后续提交已推送到 `main`：`a077133`（M9 基础设施与验收证据）、`c620743`（迟到轮次收敛与 Codex continuation 回放游标）、`89eb52e`（Responses 历史用户消息计数）。当前 `main` 工作区干净，`pnpm typecheck`、`pnpm lint`、82 个单测通过。
- 已针对性通过：Claude 换模型、DOCK-01、DOCK-03、MOB-01、MOB-02；Codex 刷新/回收场景仍被真实 app-server 的 goal continuation 回放卡住，AG-codex-08/11 尚未宣称通过，证据保留在 `docs/acceptance/M8/shots/`。

### M9 复核补充后的进展（2026-11-12）

- L2 已接入真实服务端和真实 Web UI：`ReplayAdapter` 按首条用户输入选择录像，并支持 S10 的第二轮继续从同一录像游标回放；`playwright.m9.config.ts` 与 `e2e-m9/replay.spec.ts` 覆盖 Codex/Claude 的 22 条已触发轨迹，检查活动指示唯一、最终回答、刷新、第二浏览器上下文，并生成 `docs/acceptance/M9/shots/` 的收起/展开截图。
- 黄金文件已改为默认只读深度比对，时间戳统一忽略；只有 `pnpm l1:update` 允许重写。修正服务端轮次预写模型后，22 条轨迹、1345 帧的不变量和黄金文件均通过。
- `pnpm accept:m9` 已实际跑通 typecheck、lint、trace scan（0 命中）、82 个单测、18 个快速 e2e、22 个 L2 回放；最近一次报告为 `traces 22 · invariants 1345/1345 · replay-ui 22/22`。M8 棘轮按要求实际启动过一遍（148 项，45.7 分钟），真实项 65 项通过；Codex continuation、部分弱网/Provider/模式用例和占位项仍失败，未把这次失败产物混入提交。现有 M8 基线报告仍为 `15/125`，M9 汇总保留该棘轮数并由 `accept:m8 --ratchet` 负责回归判断。
- DSH 真实 Provider 轨迹已完成：3080 attach 只操作本次新建的临时工作区/会话，S01–S11 全部有原生帧、`reference/final.txt`、`reference/page.json` 和黄金视图；S06 真实记录了 `session/cancel` 后的 `turn/end` aborted。预检覆盖 `session/modelCatalog`、`workspace/create`、`session/create`、`session/selectModel`、正确形状的 `session/follow`、`$events`、`session/prompt`、`commands/execute`、`session/page`、`session/cancel`、`session/list`，全部通过。真实默认模型为 `openai-next / deepseek-v4-1-flash-261017`。attach 模式无法透明代理 DSH 内部模型端点，11 条 `meta.json` 明确记录模型层跳过原因；原生帧层已纳入 L1/L2。
- DSH 翻译器按真实轨迹修正了 `tool/result` 嵌套 call id、命令/读取/编辑完成态和稳定条目键；全量现在是 33 条轨迹、3681 帧、不变量 3681/3681，L2 回放 33/33。发布目录切换和线上冒烟仍待执行。
- 轨迹事实：DSH S04/S05 在当前真实权限策略下没有产生 `approval/request`，写文件直接完成；这按真实行为保留在轨迹和黄金文件中，不能用假审批补齐。S08 的 `user-questions/request` 与 `$events/result` 已真实出现并完成。

实时统计：`docs/acceptance/M8/report.json`（每次 `pnpm accept:m8 --ratchet` 覆盖）。
