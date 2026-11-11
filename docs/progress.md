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
| 未通过 | AG-codex-04、AG-claude-04（任务面板）：DSH 通过；Codex 的 mock 请求里**没有任何 plan/todo/task 工具**（直接工具模式下 update_plan 不提供）；Claude 的 28 个工具里 TodoWrite 疑似被新的 Task* 工具取代，需要核实并映射 |
| 已修 | 流式链路：adapter 懒发 item.start（Codex/Claude/DSH 都没有可靠的 block-start）、前端 update 帧可新建热条目；AG-{dsh,claude,codex}-02 全部通过 |
| 新增 | 任务面板改成贴在输入框上方的独立组件（SPEC 9.5），不再依赖轮次展开 |
| F1/F2/F3 | 已修（SDK external + 建会话回滚；数据校验 + 错误边界；模型默认值与 400） |
| F5 | 已修（feed 里的 agent 来自 patch） |

### M8 实测发现（需写进 protocol-notes）

- **Codex 0.167 的内置模型全部走 code mode**：`model/list` 返回的 12 个 slug，请求里 `tools` 为空，工具放在 `input[]` 的 `additional_tools` 命名空间里（`functions.exec` 自定义工具）。只有**不在 model/list 里的 slug**（如 `gpt-5`）会退回直接工具。SPEC 6.2 要求 SLUG 取自 model/list，与实测冲突 → 验收 fixture 改用 `gpt-5`/`gpt-5-mini`，证据待补进 protocol-notes。
- DSH 侧车端口必须取 `WDCC_DSH_PORT`（已修），否则并行运行会撞 3091。
- 流式增量：adapter 需要在 block-start 时发 `item.start`，前端 `update` 帧要能**新建**热条目，否则增量无处可落（已修的 DSH/Claude adapter + store）。
