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
| M1 服务端核心与同步协议 | 进行中 | 分支 `m1/server-core` |

## 偏差记录

（暂无）

## 受阻项

（暂无）
