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

## M3 进度（进行中）

| 项 | 状态 |
|---|---|
| CodexAdapter（app-server 子进程、JSON-RPC、thread/turn、审批回包、事件映射、resume/dispose/probe/buildLaunchSpec） | 已实现，`npx tsx scripts/test-codex-adapter.ts` 冒烟通过（29 条事件，含 turn.completed/usage/command/reasoning） |
| 接入生产组装点 `packages/server/src/adapters.ts` | 已接入（`WDCC_ENABLE_CODEX=0` 可关闭） |
| `model_catalog_json` 前置 | **已核实并否决**：自定义条目必须带 `base_instructions`/`instructions_template`，填它就是平台提供系统提示词 → 违反 R1。改用 Codex 自带元数据；代价是假模型下没有 `fileChange`/`turn/plan/updated`，adapter 按 5.2/6.3 两种情况处理。已写进 SPEC 13 与 protocol-notes §7.7 |
| `native.spec.ts` 的 Codex 部分 | 完成（4 个断言：thread/start、turn/start、`-c` 白名单、访问模式映射），全绿 |
| fixtures 重录 | 待做 |
| A1（Codex） | **7/8 通过**（`scripts/accept-codex-a1.ts`：新建、流式、命令、工具、审批、一轮完成、打断）。**未通过**：`dispose` 后 `resume` 的新一轮不完成——日志显示 `thread/resume` 成功、`turn/start` 返回了 turnId，但该轮不再产生任何事件，下一次 `turn/start` 还被当成 steer 到同一 turn。已定位到这一步，待修 |
| A2（Codex） | 待做（`skills/list`、`mcpServerStatus/list` 结构化对比） |

## M1 偏差与说明

- **真实 adapter 尚未接入**：M1 只注册 fake-adapter；`packages/server/src/adapters.ts` 是生产组装点，M3–M5 依次填入 Codex / Claude / DSH。
- **`assistant.message.phase` 由 adapter 负责**：manager 不重写已落库的事件（seq 日志不可变）。adapter 在 turn 结束前把最后一条助手消息标 `final`；M3–M5 实现时按此约定做。
- **Provider / models 端点推迟到 M6**：11.1 表里的 `/api/providers*`、`/api/models` 未在 M1 实现（M6 的 Provider 管理页会用到）。
- **前端构建链**：Vite 锁 7.3.8 + @vitejs/plugin-react 5.2.0（plugin-react 6 依赖 Vite 8/rolldown，会在本机 Illegal instruction）。`pnpm build` 产出 `packages/web/dist` 与 `packages/server/dist/main.js`（esbuild 单文件，`better-sqlite3` external），已用生产包做过冒烟：token 换 Cookie、401、带 Cookie 访问都正常。
