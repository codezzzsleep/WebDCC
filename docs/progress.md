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

## M1 偏差与说明

- **真实 adapter 尚未接入**：M1 只注册 fake-adapter；`packages/server/src/adapters.ts` 是生产组装点，M3–M5 依次填入 Codex / Claude / DSH。
- **`assistant.message.phase` 由 adapter 负责**：manager 不重写已落库的事件（seq 日志不可变）。adapter 在 turn 结束前把最后一条助手消息标 `final`；M3–M5 实现时按此约定做。
- **Provider / models 端点推迟到 M6**：11.1 表里的 `/api/providers*`、`/api/models` 未在 M1 实现（M6 的 Provider 管理页会用到）。
- **前端构建链**：Vite 锁 7.3.8 + @vitejs/plugin-react 5.2.0（plugin-react 6 依赖 Vite 8/rolldown，会在本机 Illegal instruction）。`pnpm build` 产出 `packages/web/dist` 与 `packages/server/dist/main.js`（esbuild 单文件，`better-sqlite3` external），已用生产包做过冒烟：token 换 Cookie、401、带 Cookie 访问都正常。
