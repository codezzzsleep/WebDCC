# 验收记录（M7）

> 日期：2026-11-11 · 环境：Node v26.13.0 / pnpm 12.18.0 / DSH 0.2.2-rc.1 / Codex 0.167.0 / Claude Code 2.1.322 / Claude Agent SDK 0.3.322
> 自动化：`npx vitest run`（48 个单测）、`npx playwright test e2e/`（16 个 e2e）、`pnpm typecheck`、`pnpm lint` 全绿。
> 说明：**未配置任何真实模型 Key**，A1/A7 的真实模型部分标「待真实模型验证」；界面截图标「待用户确认」。

| 编号 | 结果 | 证据 | 备注 |
|---|---|---|---|
| **A1 三个 Agent 基本能力** | ✅ 假模型通过 | `scripts/accept-codex-a1.ts`（8/8）、`scripts/accept-claude-a1.ts`（8/8）、`scripts/accept-dsh-a1.ts`（8/8）：新建、流式、命令/读/写、审批、打断、dispose+resume 继续 | 真实模型部分 **待真实模型验证**（环境无 Key/登录） |
| **A2 原装** | ✅ | `packages/adapters/test/native.spec.ts`（12 条断言：Claude preset/settingSources/无覆盖字段、Codex 无提示词字段/-c 白名单、DSH 端点白名单/commands 允许范围）+ `accept-codex-a2.ts`、`accept-claude-a2.ts`、`accept-dsh-a2.ts` | DSH 与直接 Host API 建会话的工具集完全一致（32 个）；Claude 的 `.mcp.json`、hooks、51 斜杠命令仍加载 |
| **A3 URL** | ✅ | `e2e/m2-url.spec.ts`（3 个）：深链/刷新/另一浏览器、停靠区 URL 还原、双标签同步 | |
| **A4 文件** | ✅ | `e2e/m6.spec.ts`：上传→`/files/{id}` 200 + `immutable` + ETag；无 Cookie 401 | |
| **A5 切换性能** | ✅ | `e2e/m2-perf.spec.ts`：5,304 事件；未缓存首屏 **195 ms**（限 ≤1s）、同一页面切换 3 次中位数 **69 ms**（限 ≤150ms）、首个请求 `limit=200` | |
| **A6 弱网** | ✅ 6a–6f | `e2e/m2-network.spec.ts`（6a 2s/50KB/s 流式可见；6b 断网 30s 后与 DB 一致；6e 离线刷新）+ `e2e/m7.spec.ts`（6c 离线发送只送一次；6d 离线审批只生效一次；6f 20MB 断点续传 sha256 一致） | |
| **A7 Provider** | ✅（界面与注入） | `e2e/m6.spec.ts`：Provider 注册、Codex 可选/Claude 灰显、响应不含 Key 原文 | 真实 DeepSeek 端点跑通 **待真实模型验证** |
| **A8 交接** | ✅ | `e2e/m6.spec.ts`：带到…后输入框与来源原文逐字节相等；目标会话没有新增 user.message（无自动发送） | |
| **A9 认证** | ✅ | `packages/server/test/auth.spec.ts`：无 Cookie 401、错误 token 不设 Cookie、换 token 旧 Cookie 失效 | |
| **A10 事件完整性** | ✅ | `packages/server/test/sync.spec.ts`：10,000 帧 + 20 次断线重连，seq 连续、无重复、与 DB 逐条一致 | |
| **A11 未知事件** | ✅ | `packages/server/test/events.spec.ts`：unknown 事件保留原始帧 | |
| **A12 界面** | ✅ 已存档 | `docs/acceptance/M2/` 11 张（1440×900 与 390×844：新会话页、收起/展开轮次、轨迹、@ 菜单、停靠区会话/diff/文件、审批卡片、手机视图） | 与 DSH 截图的对照结论 **待用户确认** |
| **A13 提醒** | ✅ | `e2e/m6.spec.ts`：后台会话完成后页面标题出现 `(n)`，侧边栏状态与通知逻辑 | |

## 部署验收

- `pnpm build` 产出 `packages/web/dist` 与 `packages/server/dist/main.js`（esbuild 单文件，`better-sqlite3` external）
- 以 `WDCC_HOST=0.0.0.0 WDCC_PORT=8899 node packages/server/dist/main.js` 运行：打印 token URL；无 Cookie 访问 `/` 与 `/api/workspaces` 均为 401；带 token 换 Cookie 后 200
- systemd unit 与 HTTPS 注意事项写在 [deploy.md](deploy.md)

## 未覆盖 / 已知限制

1. **真实模型**：A1、A7 的真实模型部分未跑（环境无 Key/登录），按 SPEC 标「待真实模型验证」。
2. **A12 人工确认**：截图已存档，交互与 DSH 的一致性由用户确认。
3. **Codex 的 `fileChange`/`turn/plan/updated`**：`model_catalog_json` 与 R1 冲突（见 protocol-notes §7.7），假模型下不出现；真实模型下需复核。
4. **DSH 提问的计时模式**：`userQuestions/answer` 仅用于计时模式的迟到作答，v1 未启用（见 protocol-notes §7.2）。
