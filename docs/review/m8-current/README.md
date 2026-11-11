# M8 当前进度与界面 review 材料（2026-11-11）

本目录是给人工 review 用的快照：**代码状态 + 界面截图 + 未完成清单**。
这里的结论只代表"当前分支的工作状态"，**不是** M8 验收通过的报告。

## 1. 截图

`docs/review/m8-current/*.jpg` 都是从真实界面验收套件（真 Codex / Claude Code / DSH + 假模型）跑出来的 1440×900 截图：

| 文件 | 内容 |
|---|---|
| `chat-dsh.jpg` / `chat-codex.jpg` / `chat-claude.jpg` | 三个 Agent 的会话页（侧边栏 + 时间线 + 输入框） |
| `changes-card-diff.jpg` | 改动卡片 + 右侧停靠区的 diff |
| `plan-panel.jpg` | DSH 的任务面板（todo_write） |
| `goal-panel.jpg` | Codex 的"目标"面板（thread/goal/updated） |
| `approval-dsh.jpg` / `approval-codex.jpg` / `approval-claude.jpg` | 三个 Agent 的审批卡片（标题=工具名+命令，原始 JSON 折叠在"详情"里） |
| `provider-page.jpg` | Provider 与模型页（本机自动导入 + 来源/Key 后 4 位） |
| `new-session.jpg` | 新会话页（三个 Agent 卡片 + Provider/模型） |
| `mobile-drawer.jpg` / `mobile-chat.jpg` / `narrow-sidebar.jpg` | 窄屏：抽屉、手机会话页、900px 窄栏 |
| `dock-move.jpg` / `dock-diff.jpg` | 停靠区（会话标签 / diff 标签） |
| `handoff.jpg` | "带到…"交接 |
| `trajectory.jpg` | 轨迹标签 |
| `mode-menu.jpg` | 访问模式菜单 |

对应的验收报告（脚本生成，非手写）：`docs/acceptance/M8/report.json`、`status.json`、`index.html`。

## 2. 界面与 DSH 原版的关系（需要你确认）

**现在的 WebDCC 界面是自绘的三栏布局，没有复用 DSH 原版的视觉设计。**
对比 `docs/reference/dsh/dsh-running.png`（DSH 原版）与上面的截图，差别是明确的：

| | DSH 原版 | 当前 WebDCC |
|---|---|---|
| 底色 | 深色、终端质感 | 浅色、卡片式 |
| 步骤行 | 单行紧凑（`运行命令 · …` / `思考 · …`），图标在左 | 卡片行，间距大，深色卡片当前还有文字重叠的排版问题 |
| 任务/目标 | 输入框上方的折叠卡片 | 输入框上方的独立面板（已完成，但样式未对齐） |
| 输入框 | 圆形 `＋`、权限胶囊、模型胶囊、蓝色圆形发送按钮 | 方形图标、`只读` 胶囊、下拉模型、方形按钮 |
| 顶部 | 标题 + 标准模式/子智能体/后台任务芯片 | 标题 + 深度/Codex 标识 + 标签页 |

SPEC-M8 第 4 节 F15 只写了"**对照 `docs/reference/dsh/` 打磨界面（字体、图标、间距）**"，排在 PR 6（最后打磨），
**目前还没做**。所以你现在看到的排版差异是预期内的，但也确实离"和 DSH 一致"很远。

需要你决定的方向（三选一）：

1. **保持自绘，只按 `docs/reference/dsh/` 对齐字体/图标/间距/配色**（SPEC 现在的写法，工作量中等）；
2. **把 DSH 原版 UI 作为前端直接复用**（例如 iframe / 复用它的组件包），WebDCC 只做壳和增强；
3. **先给我一份你认可的目标截图/设计稿**，我按图实现。

## 3. 已完成（本分支）

**验收框架**

- `pnpm accept:m8` / `--ratchet`：typecheck → lint → 单测 → fake e2e → build → 真实套件（严格模式跑 2 遍）；
- 报告器从 SPEC-M8 v2 第 7 节解析出 **138 个用例 ID**，产出 `pass-*.json` / `report.json` / `status.json` / `index.html`（含截图）；
- 138 个 ID 全部落成测试：已实现的写真实断言，未实现的显式 `throw new Error('NOT IMPLEMENTED: <ID>')`；
- 测试隔离：统一的 `isolatedEnv()`（HOME / CODEX_HOME / CLAUDE_CONFIG_DIR / DSH_HOME），服务端在 `WDCC_TEST_HOOKS=1` 时启动前检查四个目录，落在真实家目录就拒绝启动（S-04 单测）；
- `spawnServer` 改为 `process.execPath` + 从 `import.meta.url` 推仓库根，可换机复跑；
- 假模型：`/__requests`、`/__reset`、`/__plan`、模板变量（用户消息数/图片数/模型名）、工具不匹配返回 500、**Codex code mode**（`custom_tool_call` + `exec` 脚本）、按 Agent 分变体的计划文件（`full.dsh/claude/claude-tasks/codex.json` 等）。

**产品修复（SPEC 的 F 项）**

- F1 生产构建里 Claude Code 起不来（SDK external + 建会话失败回滚）；
- F2 DSH todo_write 整页崩溃（kind 映射 + 数据校验 + 错误边界）；
- F3 选的模型没传给 Agent（默认模型、服务端 400、输入框显示实际模型）；
- F4 轮次分组（服务端 turnId 唯一来源、轮次外事件 turnId=null、只有 turn.started 未完成才显示"运行中"、N 轮只算含 user.message 的组）；
- F5 新会话被标成 DSH（feed patch 带 agent/workspaceId/createdAt）；
- F6 访问模式：三端都接上了（DSH `/permission`、Claude `setPermissionMode`、Codex 下次 `turn/start` 带 policy；Codex 选项来自 `permissionProfile/list`；root 下 Claude 的 `bypassPermissions` 灰显并写明原因）；
- F7 附件：图片走三端原生格式（Codex `localImage`、Claude base64、DSH image block）；其他文件复制到 `<工作区>/.webdcc/uploads/<fileId>-<名>` 并把相对路径插进输入框；`.git/info/exclude` 写 `.webdcc/`；100MB 上限；断点续传分片上传；
- F8 斜杠命令：Claude 菜单来自 init、DSH 菜单来自 `commands/list` 且 `/permission` 走 `commands/execute`（不发给模型）、Codex 不弹菜单；
- F9 窄屏：≥768px 收起成 56px 窄栏、<768px 抽屉、停靠区手机全屏 + 返回；
- F10 改动卡片：原生 diff（Codex `turn/diff/updated`）→ old/new 生成 hunk → 整文件写入并注明；diff 存成文件，停靠区可看；
- F11 审批卡片：标题=工具名+命令/路径、原因用 `displayReason.zh`、按钮用原生选项、原始 JSON 折叠、处理后显示"已允许一次/已拒绝/已取消/已在其他界面处理"；
- F12 Codex 事件映射：`thread/goal/updated`→目标面板、`turn/plan/updated`→任务面板、`turn/diff/updated`→改动卡片、`warning/configWarning/deprecationNotice`→提示卡片、`userMessage`/`summaryPartAdded` 不再算未知、usage 从 `tokenUsage` 读；**单测遍历 schema 全部方法断言都有显式归类**；
- F16 Provider 自动导入（Codex `config/read`、Claude settings.json、DSH 读取类端点）、来源/Key 后 4 位、粘贴导入、去重、忽略/恢复；
- F17 别的界面处理的审批同步（DSH `approval/decided` → `approval.resolved by:'other'`）；
- F18 同一主机多实例 Cookie 互相覆盖：Cookie 名按 Host（含端口）派生，旧名过渡期仍接受并换发；
- F19 Claude 的 TaskCreate/TaskUpdate → 任务面板、ExitPlanMode → 带 Markdown 计划的审批卡片、ToolSearch 卡片；
- D1 attach 模式：`/connect` 换 operator Cookie、设置页"DSH 连接"、spawn 冲突检查、只处理自己的会话；
- 打断时取消本会话挂起的审批（`已取消`）、轮次结束后迟到的 status 不再把会话卡在"待批准"。

**测试**

真实界面用例已实现 80/138（含 AG 三端核心流程 01/02/03/04/05/06/07/08/09/10/11/12、PRV/NEW 大部分、MODE 9 个、SES/HO/SL、DOCK/MOB/UI、NET 等）。

## 4. 还没做 / 现在不通过的

**当前一次完整跑的通过率见 `docs/acceptance/M8/report.json`（诚实数字，不是"已通过"）。**
已知不通过或未实现的：

- 6.3 缺口：ATT-03（限速断网续传的完整断言）、ATT-04/05 的部分断言；NAT-{dsh,codex,claude}-01/02 原装对照；ROB-01..04 注入事件类；DSHX-02..08；PRV-04/05/09；NEW-01/04/05/06；AUTH-04/05；FIN-01..04；AG-claude-04b/13/15/16、AG-codex-13/14、AG-dsh-13/14、AG-codexd-01/03/05/09/11；
- 部分已写用例仍失败：MODE-*-02/03（只读/可写模式的端到端断言）、SES-01..04、HO-01..03、SL-01..03、DOCK/MOB/UI 截图、NET-01..08、NOTIF-01；
- **F15 界面打磨（对照 DSH 参考截图）未做**：这就是你看到"界面和想的不一样"的原因；
- 第 9 节部署与真实模型冒烟未做；`main` 分支保护未开；
- 严格模式 `pnpm accept:m8`（两遍）从未全绿。

## 5. 需要你确认的问题

1. 界面方向：见上面第 2 节的三选一（自绘对齐 / 复用 DSH 原版 UI / 你给设计稿）。
2. 是否接受"先按 SPEC 顺序把 138 个用例全部打通，最后再做 F15 打磨"，还是**先停下功能、先把界面做成 DSH 风格**。
3. 审查方要求"验收报告和截图入库并提交到仓库"，是否同意把 `docs/review/m8-current/` 这类 review 截图也长期留在仓库里（会占几 MB）。
