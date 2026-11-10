# WebDCC v1 SPEC：DeepSeek Harness / Codex / Claude Code 统一网页端

> 版本：v2.2 · 日期：2026-11-11 · 仓库：`WebDCC`
>
> **v2.2 变更**：新增 0.1 节「无人值守执行规则」（PR 自动合并、必须停下的情况、默认方案）；把 Codex 访问模式、DSH 提问与思考字段、Claude 提问四项核实结论落入 5.2/5.3/5.4/6.3/9.6；补齐会话标题、改动 diff、附件、斜杠命令、添加工作区、导出、Agent 未安装等空白（9.2–9.9、11.1、7.7、13）；修正 16 节前后矛盾；M2/M7 门槛与第 15 节按无人值守调整。
>
> **v2.1 变更**（按 M0 核实结果修订，证据见 `docs/protocol-notes.md`）：重写 5.4 DSH 接口；5.2、5.3 写入 Codex、Claude Code 的实测结论；6.1、6.2 增加 `nativeSeq` 与内部事件规则，明确 seq 由我方自己连续编号；6.3 映射表按实测事件名重写；9.6 访问模式按三个 Agent 的原生枚举重写；3.2、3.3、10.3 去掉已证实不需要的备选方案；4.1、12.3 按实际锁定版本和硬件限制更新；13 按已实现的假模型服务更新；M3、M5 增加开工前置步骤；15、16、18 相应更新。

---

## 0. 给执行者的说明

1. **严格按第 14 节的里程碑顺序执行，流程按 0.1 节（无人值守运行）。** 用户不在线，验收通过后自动合并，不等待确认。
2. **第 3 节"原装原则"是硬约束。** 任何需求、实现细节或"优化"与第 3 节冲突时，一律以第 3 节为准。
3. **界面以 DeepSeek Harness（下称 DSH）为蓝本。** 第 9 节写了具体规则，`docs/reference/dsh/` 里有实测截图。DSH 只是界面和交互的参考，底层是我们自己的平台，三个 Agent 平级（第 1 节）。
4. **标注【M0 核实】的接口细节**来自公开文档、社区资料或源码阅读。M0 要对照锁定版本逐条核实；有出入时以真实协议为准，把差异写进 `docs/protocol-notes.md`。原则和验收标准不因此改变。
5. **标注【已实测】的事实**已在锁定版本上实际跑通（写 SPEC 时或 M0 探针），可以直接采用，升级版本后要复核。**标注【M3 核实】【M4 核实】【M5 核实】的项**在对应里程碑开工时先确认，结论补进 `docs/protocol-notes.md`。
6. 拿不准时选更简单的实现。不要添加本文没有要求的功能。

### 0.1 无人值守执行规则

用户不在线：从 M1 起连续执行到 M7，不等待用户确认。只有本节第 3 条列出的情况才停下。

1. **每个里程碑的流程：** 新建分支 → 实现 → 跑该里程碑的验收 → `gh pr create`（描述里列出每条验收的结果和证据）→ `gh pr merge --squash --delete-branch` → 从最新的 main 开下一个分支。不直接向 main 推送其他提交，任何情况下都不 force push main。
2. **依赖顺序：** M1 → M2 → {M3、M4、M5 互相独立} → M6 → M7。M3、M4、M5 中某一个受阻时，其余照常推进；M6、M7 用已完成的 Agent 继续，受阻的 Agent 在最终报告里列出。
3. **必须停下的情况**（停在当前分支，写好 `docs/progress.md` 后结束运行）：
   - 遵守第 3 节原装原则已经做不到（例如某个 Agent 只能靠改提示词、注入工具或改用户配置才能接入）。不得为了推进而放宽原则。
   - 需要用户凭据、需要部署到远程服务器、或需要用户做选择，且下面的「默认方案」没有覆盖。
   - 同一条验收连续 3 轮针对性修复后仍然失败，并且没有可以先推进的独立工作。
4. **SPEC 与实测冲突：** 以实测为准。在同一个 PR 里更新 `docs/protocol-notes.md` 和 SPEC 的对应章节，然后继续。
5. **不需要用户、也不阻塞的验收：**
   - A12（界面对照 DSH 截图）和 M2 门槛里「用户看过截图」一项：在 1440×900 和 390×844 下截好图，放进 `docs/acceptance/<里程碑>/`，在 acceptance-report 里标「待用户确认」，继续推进。
   - 需要真实模型的验收（A1、A7 的真实模型部分）：环境里有对应 Key 或登录时执行；没有时自动跳过，在 acceptance-report 里标「待真实模型验证」。
6. **真实 API 花费控制：** 每个 Agent 在每个里程碑门槛上最多跑一次真实模型；所有自动重试、调试、回归都只用假模型。不在循环里调用真实 API。
7. **进度记录：** 每次合并 PR 时更新 `docs/progress.md`：完成了什么、与 SPEC 的偏差、受阻项及证据。
8. **安全：** 仓库是公开的。不提交任何 Key、token、Cookie、服务器地址；fixtures 一律脱敏。
9. **范围：** 不做第 2 节非目标和第 17 节 Future 里的任何东西，不添加 SPEC 没有要求的功能。
10. **结束：** M7 本地验收完成后，写好 `docs/acceptance-report.md` 与 `docs/progress.md` 的最终总结，停止运行。

**默认方案（不需要停下来问）：**

| 事项 | 默认方案 |
|---|---|
| PR 合并 | 验收通过后自动 squash 合并（第 1 条） |
| 真实模型验收 | 有 Key 或登录才跑，否则标「待真实模型验证」，不阻塞 |
| 远程部署 | M7 只做到「本机按生产方式运行」：`pnpm build`，以 `WDCC_HOST=0.0.0.0` 启动，写好 deploy.md 与 systemd unit 示例，在本机跑完全部验收；部署到用户服务器由用户自己做 |
| 界面确认 | 截图存档并标「待用户确认」 |

---

## 1. 背景与目标

WebDCC 是一个部署在个人公网服务器上的网页端：在同一个页面里使用 DSH、Codex、Claude Code 三个原装 Agent。三者平级、互相独立，平台只负责驱动、展示和让用户手动交接。

**为什么要做。**
- DSH 自带网页端，交互成熟，但它按 127.0.0.1 单机设计：所有会话共用同一个根地址，没有会话 URL，经公网使用时资源链接常失效、切换会话卡顿，弱网下体验差。
- Codex 和 Claude Code 只有各自的 CLI 和客户端，没有统一的网页端。

**使用者。** 只有一个人（服务器主人），通过公网访问自己的 Linux 服务器。

### 1.1 目标（编号供验收引用）

| 编号 | 目标 | 说明 |
|---|---|---|
| G1 | 三个原装 Agent 平级 | DSH、Codex、Claude Code 各自以原装形态运行：系统提示词、内置工具、用户自己的配置（AGENTS.md、CLAUDE.md、skills、MCP、hooks）全部不变。三者之间没有主从、委派关系 |
| G2 | DSH 式界面 | 侧边栏、对话页、轮次折叠、改动卡片、右侧停靠区、输入框的交互和 DSH 一致（第 9 节），三个 Agent 共用同一套界面 |
| G3 | 一切都有 URL | 会话、主栏+停靠区的组合、某条事件、改动 diff、上传文件都有固定地址；刷新、换设备、直接粘贴链接都回到同一个状态 |
| G4 | 弱网可用 | 远程优先设计（第 7 节）：断线不丢不重、离线可读、操作进发件箱自动补发、大资源可缓存、上传可续传 |
| G5 | 切换快 | 已看过的会话从本地缓存秒开，再只补差 |
| G6 | Provider 可切换 | 新建会话时可以选 Provider（例如 Codex 用 ChatGPT 登录或 DeepSeek API），实现上只替换模型接入地址和凭据，不碰提示词 |
| G7 | 手动交接 | 用"带到…"或输入框里的 `@`，把一个会话的回复原文或文件路径放进另一个会话的输入框，由用户决定发不发 |
| G8 | 公网自用 | 访问 token 换 Cookie（与 DSH 相同的方式），不做账号体系，HTTPS 可选 |

### 1.2 典型使用流程（v1 必须顺畅跑通）

1. 在工作区 `agent-web` 下开一个 Codex 会话（GPT），讨论方案，它在工作区里写出 `SPEC.md`。
2. 在 Codex 那一轮的"已编辑 1 个文件"卡片上点"带到…"，选"按 SPEC.md 实现 M1"这个 DSH 会话（或新建一个）。DSH 会话在右侧停靠区打开，`SPEC.md` 出现在它的输入框里，用户补一句要求后发送。
3. 主栏看 Codex，右栏看 DSH 执行。DSH 跑完后，用户在 Codex 的输入框里打 `@`，从"对话"里选 DSH 会话，插入它最后一条回复的原文，让 GPT 审阅。
4. 整个过程中随时刷新、换设备、断网再恢复，状态都不丢；地址栏始终能还原当前布局（例如 `/s/<CodexID>+<DSHID>`）。

---

## 2. 非目标（v1 明确不做）

以下任何一项出现在实现里，都算偏离 SPEC。

- **不做多 Agent 编排。** 没有 leader / worker、委派、自动等待结果。三个 Agent 彼此独立。
- **不写任何提示词。** 平台不追加、不替换、不包裹任何系统提示词或开发者指令，也不替用户生成发给模型的消息。
- **不向模型注入额外工具。** 不给任何会话挂平台自己的 MCP server、工具、hooks、skills。
- **不做自动交接。** 不做"A 完成后自动给 B 发消息"。完成提醒只提醒人（第 9.11 节）。
- **不 fork、不内嵌 DSH 的网页端。** DSH 只作为后端之一被驱动（第 5.4 节）。可以阅读并借用 DSH 仓库里 MIT 协议的展示组件和样式代码，但必须在 `THIRD_PARTY_NOTICES.md` 里保留其版权和许可声明，且不得引入 DSH 的 Cordis 运行时包。
- **不做终端界面。** 不内嵌 xterm/PTY；"新建终端"标签页列入 Future。
- **不做多用户。** 没有账号体系、权限分级、团队共享。
- **不自研协议转换网关。** 跨协议使用模型时，由用户自己把转换代理（LiteLLM、OpenRouter 等）登记成普通 Provider。
- **不导入平台之外创建的历史会话**、不做 VS Code 式代码 review、不做停靠区分栏：都列入 Future。

---

## 3. 原装原则（硬约束）

**定义：** 平台对三个 Agent 只做三件事：启动它，把用户输入原样交给它，把它的输出原样展示出来。

### 3.1 通用规则

- **R1 不碰提示词。** 不传任何系统提示词、开发者指令或提示词追加字段。
- **R2 不注入能力。** 不给会话附加 MCP server、自定义工具、hooks、skills、子 Agent 定义。
- **R3 不改用户配置文件。** 不写 `~/.codex/config.toml`、`~/.claude/settings.json`、`~/.dsh/*` 以及任何项目内配置。Provider 切换只通过进程启动参数和环境变量实现。
- **R4 发给模型的每个字符都来自用户。** 输入框里看到什么就发送什么。"带到…"和 `@` 插入的内容以原文形式出现在输入框里，平台不加前缀、说明或包裹。
- **R5 不丢、不改输出。** 所有原生事件都要展示；无法识别的事件以"原始 JSON 折叠卡片"展示。
- **R6 权限沿用原生。** 审批选项、访问模式都使用各 Agent 自己的枚举和默认值。

### 3.2 各 Agent 的具体约束

| Agent | 陷阱 | 规定做法 |
|---|---|---|
| Claude Code | Agent SDK 默认使用最小系统提示词，不是 Claude Code 自己的提示词 | `systemPrompt` 固定为 `{ type: 'preset', preset: 'claude_code' }`，**禁止** `append` 字段 |
| Claude Code | SDK 默认不加载任何本地设置，CLAUDE.md、skills、斜杠命令都不会生效 | `settingSources` 固定为 `['user', 'project', 'local']` |
| Claude Code | `claude -p --bare` 会跳过 hooks 和项目 MCP，官方说它将来会成为 `-p` 的默认值 | 不直接调用 `claude -p`，统一走 Agent SDK。【已实测】SDK 启动的会话会加载项目 `.mcp.json` 与 hooks（`scripts/verify-claude-native.ts`） |
| Claude Code | SDK 选项 `mcpServers`、`agents`、`hooks`、`allowedTools`、`disallowedTools` 会覆盖或增加能力 | 一律不传 |
| Codex | `thread/start` 可以传 `baseInstructions`、`developerInstructions` | 永不传这两个字段 |
| Codex | `model_provider` / `model_providers` 写在项目级 config 里会被忽略 | Provider 只通过 `codex app-server -c key=value` 覆盖（【已实测】接受点路径写法，见 10.3） |
| DSH | 不同 profile 的工具集不同，`sdk` profile 是精简版 | 用 DSH 默认的 `web` 启动方式，以"Web Host 侧车"驱动（5.4），不给用户的 profile 装插件、不改 DSH 设置；访问模式只通过原生命令 `/permission <preset>` 切换（5.4.6） |

### 3.3 机器检查（必须实现）

- 每个 adapter 暴露纯函数 `buildLaunchSpec(opts)`，返回将使用的命令、参数、环境变量和 SDK 选项。
- `packages/adapters/test/native.spec.ts` 对三个 adapter 断言：
  - Claude：`systemPrompt` 深等于 `{ type: 'preset', preset: 'claude_code' }`；`settingSources` 深等于 `['user', 'project', 'local']`；不存在 `append`、`mcpServers`、`agents`、`hooks`、`allowedTools`、`disallowedTools` 键。
  - Codex：所有发出的 `thread/start`、`thread/resume`、`turn/start` 参数中不出现 `baseInstructions`、`developerInstructions`；`-c` 覆盖只允许白名单键（`model`、`model_provider`、`model_providers.*`、`model_catalog_json`、`show_raw_agent_reasoning`）。
  - DSH：只调用 5.4.8 白名单里的端点；`commands/execute` 的 `line` 只允许两种来源：访问模式界面生成的 `/permission <preset>`，或用户本人输入并发送的命令原文。
- 发送路径单元测试：adapter 收到的文本与输入框文本**逐字节相等**；"带到…"和 `@` 插入后的输入框文本与来源原文逐字节相等。

---

## 4. 总体架构

```
浏览器（React SPA）
  ├─ Service Worker：缓存应用外壳，离线也能打开
  ├─ IndexedDB：会话事件缓存、会话列表、草稿、发件箱
  └─ 同步客户端：WebSocket 续传、心跳、发件箱重放
        │  HTTP(S)：/api/*、/files/*、/uploads/*      WebSocket：/api/ws
        ▼
WebDCC server（Node 24，TypeScript，单进程）
  ├─ Auth            访问 token → 签名 HttpOnly Cookie
  ├─ Workspaces      工作区 = 服务器上的一个目录
  ├─ Session Manager 我方 sessionId ↔ (agent, nativeId)，生命周期与浏览器无关
  ├─ Event Store     SQLite，每个会话一条按 seq 递增的事件日志
  ├─ Sidebar Feed    会话列表变化（状态、标题、时间）的全局递增日志
  ├─ Command Log     发件箱命令去重（clientCommandId）
  ├─ Live Hub        订阅、按 seq 补差、进行中条目快照、增量合并
  ├─ File Store      内容寻址、不可变、可续传上传
  ├─ Provider Registry
  └─ Adapters
       ├─ CodexAdapter   每会话一个 `codex app-server` 子进程（stdio JSON-RPC）
       ├─ ClaudeAdapter  每会话一个 Agent SDK `query()`
       └─ DshAdapter     平台托管一个 `dsh web` 侧车（只监听 127.0.0.1），走它的 Host API，
                         所有流复用一条 /api/remote.mux WebSocket
```

### 4.1 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node.js ≥ 24（当前锁定 26.13.0，见 deploy.md） | DSH 要求 Node ^22.19 或 >=24 |
| 语言 | TypeScript 5.9.x（strict） | typescript-eslint 尚不支持 TS 7；Codex 能直接导出 TS 类型 |
| 包管理 | pnpm workspace | 单仓多包 |
| HTTP/WS | Fastify + @fastify/websocket（开启 permessage-deflate） | 轻量，同端口 |
| 数据库 | SQLite（better-sqlite3），WAL | 单用户、单文件 |
| 前端 | React 19 + Vite + TanStack Router + TanStack Virtual | Vite 选不依赖 rolldown 原生二进制的版本（见下） |
| 本地缓存 | IndexedDB（idb 库） | 事件缓存、发件箱 |
| 离线外壳 | Workbox（vite-plugin-pwa） | Service Worker 预缓存 |
| 渲染 | react-markdown + shiki；diff 用 diff2html | 与 DSH 观感接近 |
| 测试 | Vitest 3.2.x + Playwright | Vitest 5 依赖 rolldown 原生二进制；Playwright 可模拟断网、限速 |

**硬件限制【已实测】：** 开发机 CPU 没有 AVX2，依赖 rolldown 原生二进制的工具（Vitest 5 等）会直接 `Illegal instruction`。所有构建、测试工具都选不依赖它的版本，并在开发机和部署服务器上各跑一次 `pnpm build`、`pnpm test` 确认。

### 4.2 仓库结构

```
WebDCC/
  SPEC.md                       # 本文件
  README.md
  THIRD_PARTY_NOTICES.md        # 借用 DSH 等 MIT 代码时的声明
  docs/
    reference/dsh/*.png         # DSH 实测截图（界面蓝本）
    protocol-notes.md           # M0 核实结果
    deploy.md                   # 锁定版本、部署步骤、systemd 示例
    acceptance-report.md        # M7 验收记录
  packages/
    protocol/                   # 前后端共享类型：事件、命令、API DTO
    server/                     # Fastify、Session Manager、Event Store、同步、Auth、Files
    adapters/
      codex/  claude/  dsh/
      test/                     # native.spec.ts 等跨 adapter 测试
    web/                        # React SPA
    testing/
      mock-models/              # 脚本化的假模型服务（第 13 节）
      fake-adapter/             # 按 fixtures 回放的假 adapter
  fixtures/<agent>/*.jsonl      # M0 录制的原生协议样本（脱敏）
  e2e/                          # Playwright 用例
  scripts/probe-<agent>.ts      # M0 探针脚本
```

---

## 5. Agent Adapter

### 5.1 统一接口

```ts
// packages/protocol/src/adapter.ts
export type AgentId = 'dsh' | 'codex' | 'claude-code';

export interface ProbeResult {
  installed: boolean;
  version?: string;          // 实际检测到的版本
  pinnedVersion: string;     // 本仓库锁定并测试过的版本
  auth: 'ok' | 'missing' | 'unknown';
  notes?: string[];          // 例如 "未登录 ChatGPT，只能用 API Key Provider"
}

export interface ModelOption { id: string; label: string; }

export interface CreateOpts {
  sessionId: string;         // 我方 id
  cwd: string;               // 工作区目录
  providerId: string | null; // null = Agent 原生登录/原生配置
  model?: string;
  accessMode?: string;       // 原生枚举值（9.6）；缺省 = 用户配置的默认值；DSH 在建会话后用 /permission 设置
}

export interface UserInput {
  text: string;              // 输入框原文，逐字节透传
  images?: { fileId: string; path: string; mime: string }[];
}

export type ApprovalDecision = { approvalId: string; optionId: string }; // optionId 取自原生选项

export interface LaunchSpec {
  command?: string;
  args?: string[];
  env: Record<string, string>;           // 叠加在 process.env 之上
  sdkOptions?: Record<string, unknown>;  // Claude：query() options（不含函数）
  startParams?: Record<string, unknown>; // Codex：thread/start 参数；DSH：session.create 参数
}

export type AdapterEvent =
  | { type: 'item.start'; itemKey: string; kind: EventKind; data: unknown; turnId?: string; native?: unknown }
  | { type: 'item.delta'; itemKey: string; field: 'text' | 'output'; append: string }
  | { type: 'item.update'; itemKey: string; data: unknown }
  | { type: 'item.complete'; itemKey: string; kind: EventKind; data: unknown; turnId?: string; native?: unknown; nativeSeq?: number }
  | { type: 'status'; status: 'running' | 'waiting' | 'idle' | 'error' };
// itemKey：原生条目 id（Codex item id、Claude 的 message id + content block 序号、DSH 事件里的条目 id）。
// 没有原生 id 的一次性事件由 adapter 生成 ULID，直接发 item.complete。

export interface AgentAdapter {
  id: AgentId;
  probe(): Promise<ProbeResult>;
  listModels(providerId: string | null): Promise<ModelOption[]>;
  accessModes(): { id: string; label: string }[];      // 原生访问模式枚举
  buildLaunchSpec(opts: CreateOpts): LaunchSpec;       // 纯函数，供 3.3 测试
  create(opts: CreateOpts): Promise<{ nativeId: string }>;
  resume(opts: CreateOpts & { nativeId: string }): Promise<void>;
  send(sessionId: string, input: UserInput): Promise<void>;
  steer?(sessionId: string, input: UserInput): Promise<void>; // 仅原生支持时实现
  interrupt(sessionId: string): Promise<void>;
  respond(sessionId: string, d: ApprovalDecision): Promise<void>;
  answer?(sessionId: string, questionId: string, answer: unknown): Promise<void>;
  setModel?(sessionId: string, model: string): Promise<void>;
  dispose(sessionId: string): Promise<void>;           // 释放进程，不删除原生历史
  onEvent(cb: (sessionId: string, e: AdapterEvent) => void): void;
}
```

**生命周期规则：**
- 会话进程归服务端所有，与浏览器连接无关。浏览器全部断开时，正在进行的 turn 继续跑。
- 会话空闲超过 `WDCC_IDLE_DISPOSE_MIN`（默认 30 分钟）调用 `dispose()`；下次发送前自动 `resume()`。
- 服务重启时，所有会话标记为 `idle`，下次发送前自动 `resume()`。
- **Provider 在会话创建时锁定。** 同一 Provider 内可以换模型（Codex 在 `turn/start` 带 `model`，Claude 用 `setModel`，DSH 用 `session/selectModel`）。要换 Provider 就新建会话，再用"带到…"带内容过去。

### 5.2 CodexAdapter

**驱动方式：** 每会话一个 `codex app-server` 子进程，stdio 上换行分隔的 JSON-RPC（省略 `"jsonrpc":"2.0"`）。这是 Codex 给 VS Code 扩展等富界面用的接口。不使用实验性的 WebSocket 监听模式。

**类型来源：** M0 用 `codex app-server generate-ts --out packages/adapters/codex/src/schema` 从锁定版本导出类型。官方说明 schema 仍不稳定，升级 Codex 必须重新导出并跑 fixtures 测试。

**流程：**
1. 启动：`codex app-server [-c 覆盖项...]`，`cwd` 为工作区目录，环境变量按第 10 节注入。
2. 握手：`initialize`（clientInfo: `webdcc`）→ 收到响应后发 `initialized` 通知。握手前的其他请求会被拒绝。
3. 新建：`thread/start`，参数只含 `cwd`、`model`（可选）、`approvalPolicy` / `sandbox` / `approvalsReviewer`（仅当用户显式选了访问模式）。返回的 threadId 即 nativeId。
   - **字段名不对称（【已实测】）**：`thread/start` 的沙箱字段是 `sandbox`（字符串枚举 `read-only | workspace-write | danger-full-access`）；`turn/start` 的同义字段叫 **`sandboxPolicy`**（结构化对象 `{type:'readOnly'|'workspaceWrite'|'dangerFullAccess', ...}`）。写错字段会被静默忽略。
   - 不传任何访问模式字段时，服务端默认 `approvalPolicy='on-request'`、`approvalsReviewer='user'`、`sandbox={type:'readOnly'}`（【已实测】）。
4. 恢复：用与创建时相同的启动参数拉起进程，再 `thread/resume { threadId }`。社区录制样本显示它在全新进程里也能冷恢复。**【已实测】`thread/resume` 的访问模式覆盖只在冷恢复那一次生效**：线程已被当前 app-server 加载时，resume 会把参数静默丢弃、原样返回线程当前状态。
5. 发送：`turn/start { threadId, input: [...] }`；换过模型时附带 `model`（社区样本显示 `model`、`effort` 可逐轮传入）。图片用 `{ type: 'localImage', path }`（【已实测】，定义见导出的 `v2/UserInput.ts`）。
6. 打断：`turn/interrupt { threadId, turnId }`，以收到 `turn/completed`（status 为 `interrupted`）为准。
7. 中途追加：turn 进行中发送调用 `turn/steer`；在 `turn/started` 之前或空闲时会被拒绝，退化为排队，等当前 turn 结束再 `turn/start`。
8. 审批（【已实测】）：服务端反向请求 → `approval.request` 事件；用户选择后直接回响应体。`item/commandExecution/requestApproval`、`item/fileChange/requestApproval` 回 `{ decision }`，枚举 `accept | acceptForSession | acceptWithExecpolicyAmendment | applyNetworkPolicyAmendment | decline | cancel`；旧版 `execCommandApproval` / `applyPatchApproval` 回 `{ decision }`（`ReviewDecision`，如 `approved`）；`item/tool/requestUserInput` 是提问，回 `{ answers }`。
9. 事件：全集见 protocol-notes §2.3。主要用到 `turn/started`、`turn/completed`、`item/started`、`item/completed`、`item/agentMessage/delta`、`item/reasoning/summaryTextDelta`、`item/commandExecution/outputDelta`、`item/fileChange/patchUpdated`、`turn/diff/updated`、`turn/plan/updated`、`item/plan/delta`、`thread/tokenUsage/updated`、`thread/name/updated`。
10. 模型列表：`model/list`。

**访问模式（【已实测】，详见 9.6）：** 三层结构——权限档位（`permissionProfile/list` 返回 `:read-only` / `:workspace` / `:danger-full-access`，用户 `[permissions.*]` 会多出自定义项，UI 不可硬编码） × `approvalPolicy` × `approvalsReviewer`。**会话中途切换一律用 `turn/start` 的覆盖参数**（`approvalPolicy` / `approvalsReviewer` / `sandboxPolicy`），作用域是"本轮及之后所有轮"；不要用 `thread/resume`。`approvalPolicy='untrusted'` 已被 Codex 配置层删除（写进 `-c` 会直接启动失败），只能作为 `thread/start` / `turn/start` 的参数使用。`granular` 需要 `initialize` 声明 `capabilities:{experimentalApi:true}`，v1 不提供该档。

**认证注意（【已实测】）：** `codex app-server` 忽略 `OPENAI_API_KEY` 环境变量；API Key 模式必须通过自定义 Provider（`env_key`）注入，见 10.3。

**工具与模型元数据【M3 核实】：** M0 用的假模型没有模型元数据，Codex 只下发了 `exec_command`（参数 `cmd`）等工具，没有 `apply_patch` 和 `update_plan`，写文件走 shell 重定向。Codex 按模型元数据决定下发哪些工具；真实模型（以及 DeepSeek 官方 `models.json` 里的 `apply_patch_tool_type: "freeform"`）会用 `apply_patch` 改文件，产生 `fileChange` 条目。所以 M3 开工前先给假模型配 `model_catalog_json` 重录 fixtures（14 节 M3）。adapter 两种情况都要处理：有 `fileChange` 条目时生成 `file.change`；只有 `commandExecution` 时如实显示为命令，不去猜它改了哪些文件。

### 5.3 ClaudeAdapter

**驱动方式：** `@anthropic-ai/claude-agent-sdk` 的 `query()`，streaming input 模式：prompt 传一个由我们控制的 AsyncIterable。

**固定选项（受 3.3 测试约束）：**

```ts
const options = {
  cwd: workspace.path,
  systemPrompt: { type: 'preset', preset: 'claude_code' }, // 禁止 append
  settingSources: ['user', 'project', 'local'],
  includePartialMessages: true,
  resume: nativeId ?? undefined,
  model: opts.model,
  permissionMode: opts.accessMode,     // 可选；缺省走用户设置
  canUseTool,                          // 权限请求 → approval.request 事件
  env: { ...process.env, ...providerEnv }, // 第 10 节；原生登录时 providerEnv 为空对象
};
```

**流程：**
- 新建：首条 `system`（subtype `init`）消息里的 `session_id` 即 nativeId；把 init 里的 tools、MCP servers、slash commands 存进会话元数据（A2 对比用，也用于输入框 `/` 菜单）。
- 发送：向 AsyncIterable 推入 user message，content 为输入框原文；图片为 image content block（base64）。
- 打断：`query.interrupt()`。【已实测】本轮以 `result`（`subtype: 'error_during_execution'`）结束，query 不关闭，可以继续推下一轮。
- 换模型 / 访问模式：`setModel()` / `setPermissionMode()`（【已实测】存在）。
- 审批：`canUseTool` 返回挂起的 Promise，等用户决策后 resolve 为 allow / deny。【已实测】`permissionMode: 'default'` 下 `Write` / `Edit` 触发 `canUseTool`，只读的 `Bash` 命令不触发（Claude Code 自带放行规则）。
- 提问（【已实测】，见 protocol-notes §7.4）：模型发出的 `AskUserQuestion` **不产生 `approval.request`**，而是从 `canUseTool('AskUserQuestion', { questions }, { requestId, toolUseID, requiresUserInteraction, signal })` 到达，一次 1–4 题。我方按题发 `question` 事件（`questionId = ${requestId}:${index}`），不要为这个 tool_use 再发 `tool.call`（与 DSH 的去重规则一致）。用户作答后把全部答案**攒齐一次性** resolve 为 `{ behavior: 'allow', updatedInput: { ...原 input, answers, annotations? } }`：`answers` 的 key 是**题干原文**，多选用 `string[]`；**必须带原 `questions` 且不得改动题干**（否则该题答案被静默丢弃）。跳过某题 → 不进 `answers`，置 `annotations[题干]={unanswered:'skipped'}`。用户关闭卡片 → `{ behavior: 'deny', message }`；要结束本轮用 `deny + interrupt: true`。提问挂起时 `query.interrupt()` 会让 `options.signal` 立即 abort，必须清理未决卡片。**不传 `canUseTool` 时 CLI 会把 `AskUserQuestion` 从工具表摘掉**；`dontAsk` 模式下工具在但直接拒绝。
- 恢复：新建 `query()` 并传 `resume: nativeId`。

### 5.4 DshAdapter

**驱动方式：Web Host 侧车。** 平台托管一个 `dsh web` 进程，只监听 `127.0.0.1:${WDCC_DSH_PORT}`，平台服务端是它唯一的客户端。DSH 的 preset、插件、会话存储与用户平时用的 DSH 完全一致（G1）。DSH 自己的网页端不对外暴露。

**为什么不用其他接口：** 官方 ACP server 只面向自动化，只能收到已提交的回复文本，没有逐 token 流式输出；`--profile sdk` 是精简工具集，与网页端不一致。

本节全部来自 M0 对 DSH 0.2.2-rc.1 的源码阅读和探针实跑（【已实测】，个别标【M5 核实】的除外）。端点的完整参数定义见 `fixtures/dsh/host-api-catalog.json`（193 个端点，含 JSON Schema 和源码位置），证据见 `docs/protocol-notes.md` §1。v2 里依据社区插件写的接口描述（`POST /api/<method>`、`host.describe`、`/api/events.mux` 等）对应的是 DSH 早期接口，已作废。

#### 5.4.1 启动与认证

- 启动：`dsh web --no-open --port ${WDCC_DSH_PORT}`，使用服务器用户自己的 `DSH_HOME`（默认 `~/.dsh`）。
- stdout 打印一行 `dsh web: http://127.0.0.1:<port>/?token=<43 字符 base64url>`，从中解析 token。
- `GET /?token=<token>` 返回 303 和 `Set-Cookie`（名为 `dsh-auth-<base64url(sha256(authority))>`，HttpOnly，30 天）。之后所有请求带这个 Cookie，并以 `Host: 127.0.0.1:<port>` 访问。
- token 只在进程内有效：侧车每次重启都要重新解析 token、重新换 Cookie。
- **同一个 Cookie（API Peer）只允许一条 WebSocket，第二条返回 409。** 所以 adapter 只开一条 `/api/remote.mux`，所有流都复用它（5.4.3）。

#### 5.4.2 一元调用

- `POST /api/<ns>/<method>`（恒为两段，单段 404），请求体：

  ```json
  {"type":"client-request","rpcId":"<uuid>","method":"<ns>/<method>","payload":{"args":{}}}
  ```

- `method` 必须等于 URL 里的端点；`payload` 只能有一个 `args` 键；`args` 的键必须与端点描述符的参数名完全一致，多一个键就报 `gateway/arguments-invalid`。多数端点要再包一层 `request`，例如 `workspace/create` 传 `{ request: { path } }`。
- 响应总是 HTTP 200，结果在信封里：`{"type":"server-response","rpcId":"…","result":{"ok":true,"value":…}}`，或 `"result":{"ok":false,"error":{"code","message","details"}}`。adapter 必须检查 `ok`。

#### 5.4.3 事件流 `/api/remote.mux`

- 一条 WebSocket 上复用多条流。上行 `{"type":"open","streamId","endpoint","payload":{"args":{…}}}`、`{"type":"cancel","streamId"}`；下行 `{"type":"item","streamId","value":<帧>}`、`end`、`error`。
- 一条流对应一次方法调用，不是按会话广播。adapter 维护两类流：
  - **全局 `$events`（一条）**：帧有 `ready`（带 `clientId`）、`emit`、`waterfall`（审批、提问）、`cancel`。回复审批要用 `ready` 给的 `clientId`。
  - **每个会话一条 `session/follow`**：args `{ request: { address: { kind: 'session', sessionId }, activate: true, assistantStream: true } }`。帧有三种：
    - `snapshot`：打开时的完整快照；
    - `event`：`{ event: { type, seq, time, data } }`，持久事件，seq 不跳号；
    - `assistant-stream`：`{ frame: { type: 'chunk', index, time, chunk } }`，不持久的流式帧，`chunk.type` ∈ `block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage | finish`。
- 会话正在运行，或有浏览器在看它，就保持它的 `session/follow`；空闲超过 `WDCC_IDLE_DISPOSE_MIN` 后关闭。再次打开时按 5.4.7 补齐。
- WebSocket 断开时整体重连：重新换 Cookie（如侧车已重启）、重开 `$events` 和所有需要的 `session/follow`。

#### 5.4.4 会话与工作区

| 动作 | 端点 | args 与说明 |
|---|---|---|
| 建 / 取工作区 | `workspace/create` | `{ request: { path } }`；已存在时直接返回（`created: false`），记下 `workspaceId` |
| 工作区列表 | `workspace/follow`（流，首帧 `baseline`） | 没有 `workspace/list` |
| 新建会话 | `session/create` | `{ request: { workspaceId, agentPreset? } }`；返回的 `sessionId` 可能与请求的不同，以返回值为准 |
| 会话列表 | `session/list` | `{ _request: { cursor? } }`；不含标题，标题来自 `session/title` 事件 |
| 发送 | `session/prompt` | `{ request: { requestId, sessionId, mode, content: [{ type: 'text', text }], clientTimeZone? } }`；`mode` 普通发送用 `queue`，运行中追加用 `steer`（对应 `AgentAdapter.steer`） |
| 打断 | `session/cancel` | `{ request: { sessionId } }` |
| 历史分页 | `session/page` | `{ request: { address, throughSeq?, beforeSeq?, maxMessages? } }` |
| 模型目录 | `session/modelCatalog` | `{}` |
| 选模型 | `session/selectModel` | `{ request: { sessionId, provider, model, reasoningEffort? } }` |
| 执行原生命令 | `commands/execute` | `{ agentId: <sessionId>, line: '/permission <preset>', submittedAttachments: [] }` |
| 回复审批 / 提问 | `$events/result` | `{ clientId, eventId, outcome: { kind: 'result', value } }` |
| 回答提问 | `$events/result`（主力） | `{ clientId, eventId, outcome: { kind: 'result', value: { answers: [{ id, selected: [label], custom? }] } } }`。实时提问只能这样关。`userQuestions/answer`（`{ agentId, callId, answer }`）只用于计时模式（请求带 `wait.callId`）的迟到作答【已核实，见 protocol-notes §7.2】 |

`session/create` 没有模型和访问模式参数：模型用 `session/selectModel`，访问模式用 `/permission`（5.4.6）。

#### 5.4.5 审批与提问

- 审批以 `$events` 上的 waterfall 到达：`{ type: 'waterfall', event: 'approval/request', eventId, agentId, request: { toolName, callId?, reason?, displayReason? } }`，`agentId` 即 sessionId。
- 回复用 `$events/result`，`value` ∈ `allowed-once | rejected | cancelled`（另有 `unavailable`，我方不用）。界面按钮：允许一次 → `allowed-once`，拒绝 → `rejected`。
- **每个 waterfall 都必须回复。** 没人回复，DSH 那一轮会一直挂着。会话被打断、侧车断开、adapter 释放会话时，对还没处理的 waterfall 回 `cancelled`。
- 提问以 `user-questions/request` waterfall 到达，回答方式见 5.4.4 表。
- 会话日志里的 `approval/asked`、`approval/decided` 是持久事件，用于刷新后重建审批卡片的历史状态；可操作的审批只来自 waterfall。
- 触发条件（【已实测】）：默认 preset 下普通 `bash` 不会请求审批；只有模型显式传 `sandbox_permissions`（如 `danger-full-access`）和 `justification` 请求提权时才会。测试脚本据此设计（第 13 节）。开发机的 Landlock 只部分生效，沙箱是否拦截的结论要在部署服务器上复核。

#### 5.4.6 访问模式 = permission preset

| preset | 界面文字 | sandbox / 审批 |
|---|---|---|
| `read-only` | 仅可查看 | read-only / ask |
| `workspace-write` | 工作区内修改 | workspace-write / ask |
| `danger-full-access` | 完全权限 | danger-full-access / never |
| `auto` | 自动审查（实验） | danger-full-access / ask，逐调用由模型审查 |

- 切换方式：`commands/execute` 执行原生命令 `/permission <preset>`。DSH 的接口说明写明它"解析并执行已知命令，不发送给模型"，只在日志里追加 `command/run`、`command/done`。这与用户在 DSH 自己的界面里敲这条命令等价，符合原装原则。
- 新建会话时若用户选了非默认模式：`session/create` 之后、第一条消息之前执行一次 `/permission`。会话中途也可以改。

#### 5.4.7 seq 与补齐

- 我方 `seq` 自己连续编号（第 6 节），**不直接使用 DSH 的 `event.seq`**：DSH 日志里有很多不进对话的事件，直接用会让我方日志跳号，而客户端靠 seq 连续来判断是否漏消息。
- DSH 的 `event.seq` 存为 `nativeSeq`（`events.native_seq` 列），用于去重和补齐。
- 服务重启、侧车重启或重新打开会话时：重新打开 `session/follow`，用快照和 `session/page`（`throughSeq` / `beforeSeq`）找出 `nativeSeq` 大于已存最大值的事件补进来，按 `nativeSeq` 去重。
- `assistant-stream` 帧没有 seq，只用于实时显示；完成态以持久事件为准（`assistant/message`、`tool/call`、`tool/result` 等）。

#### 5.4.8 端点白名单（3.3 的检查依据）

`workspace/create`、`workspace/follow`、`session/create`、`session/list`、`session/follow`、`session/page`、`session/prompt`、`session/cancel`、`session/modelCatalog`、`session/selectModel`、`commands/execute`（`line` 只允许访问模式界面生成的 `/permission <preset>` 或用户本人输入的命令原文）、`$events`、`$events/result`、`userQuestions/answer`（仅计时模式的迟到作答）。需要新端点时，先更新本节和 protocol-notes。

#### 5.4.9 运行规则

- 平台启动时拉起侧车；健康检查失败自动重启（指数退避，最多 5 次后标红并停止）；每次重启都重新解析 token。
- 侧车默认端口 3091，避开用户自己 `dsh web` 的默认端口 3080。
- **运行 WebDCC 时不要再单独运行 `dsh web`（【已实测】）。** 会话日志有逐会话文件锁，但 `storages/workspace.json` 这类全局注册表跨进程没有锁，两个进程会互相覆盖工作区顺序、归档、置顶；而且审批 waterfall 会推给所有连着的客户端，两边会抢同一个审批。deploy.md 写明这一点。
- `$events` 的 `ready` 帧里的 `host.home` 是操作系统家目录，不是 `DSH_HOME`，不要拿它定位 DSH 的数据目录。

---

## 6. 统一事件模型

### 6.1 类型

```ts
// packages/protocol/src/events.ts
export interface StoredEvent {
  sessionId: string;
  seq: number;              // 会话内单调递增，从 1 开始，无空洞
  turnId: string;           // 所属轮次；轮次内的事件按 seq 排列
  itemKey: string;          // 对应 AdapterEvent.itemKey；客户端据此用完成态替换进行中条目
  at: string;               // ISO 时间
  kind: EventKind;
  data: EventData[EventKind];
  native?: unknown;         // 原始帧（unknown 卡片和排错用）
  nativeSeq?: number;       // 原生日志序号（如 DSH 的 event.seq），只用于去重和补齐
}

export type EventKind =
  | 'user.message'      // { text, images?: fileId[], clientCommandId }
  | 'assistant.message' // { text, phase?: 'interim' | 'final' }   Markdown
  | 'reasoning'         // { text, summary?: boolean }
  | 'command'           // { command, label?, cwd?, exitCode?, outputTail, outputFileId?, status }
  | 'file.read'         // { path, label? }
  | 'file.change'       // { changes: { path, kind: 'add'|'modify'|'delete', added, removed, diffFileId }[], status }
  | 'tool.call'         // { name, label?, input, output?, status }
  | 'plan'              // { items: { text, status: 'pending'|'in_progress'|'completed' }[] }
  | 'approval.request'  // { approvalId, title, detail, options: { id, label }[] }
  | 'approval.resolved' // { approvalId, optionId, by: 'user' | 'agent' }
  | 'question'          // { questionId, prompt, schema? }
  | 'turn.started'      // {}
  | 'turn.completed'    // { status: 'completed'|'interrupted'|'failed', durationMs, usage? }
  | 'usage'             // { inputTokens?, outputTokens?, cacheHitRatio?, contextRatio?, tokensPerSecond? }
  | 'error'             // { message }
  | 'unknown'           // { nativeType }  不认识的原生事件：对话里显示为原始 JSON 卡片
  | 'internal';         // { nativeType }  已知的原生簿记事件：只在轨迹标签显示
```

`EventData` 是 kind 到 data 的映射类型，字段按上面的注释定义。

**改动 diff 的取法（`file.change`）：** 按优先级取，不用工作区 `git diff` 推算（同一工作区可能有别的会话或用户本人在改文件，推算会混进别人的改动）。
1. 原生提供的补丁或 diff：Codex 的 `fileChange` 条目、`item/fileChange/patchUpdated`、`turn/diff/updated`；Claude Code 工具结果里的结构化补丁（如有）【M4 核实】；DSH `tool/result` 里的 diff 数据（如有）【M5 核实】。
2. `edit` 类调用：用 `old_string` / `new_string` 生成该处 hunk。
3. 整文件写入且拿不到原内容：按"新文件"显示全部内容为新增，卡片注明"整文件写入，未取得原内容"，`+` 计新内容行数，`-` 为 0。

**内部事件：** 每个 Agent 都有一些对用户没有意义的簿记事件（例如 DSH 的 `request/header`、`step/start`、`step/end`、`agent/inbox/spliced`、`session/end-seed`、`job/registered`、`job/settled`、`command/run`、`command/done`）。它们照样存储（满足 R5），kind 记为 `internal`，只在轨迹标签显示，不进对话时间线。每个 Agent 的内部事件清单维护在 protocol-notes 里，不在清单里的一律按 `unknown` 处理。`label` 是步骤行上显示的人话说明，取自原生字段（例如 DSH / Claude `bash` 的 `description`），没有就留空，平台不自己编。

### 6.2 持久化规则

- `seq` 由我方按会话连续分配，与原生序号无关；原生序号存 `nativeSeq`。
- 收到 `item.complete` 才分配 seq 并写库；流式增量只走 WebSocket，不写库。
- 进行中的条目按 `itemKey` 在内存里维护快照。订阅时先补发 `seq > afterSeq` 的已存事件，再发所有进行中条目的快照，之后接续增量。
- 客户端收到 `event` 时，若本地有同 `itemKey` 的进行中条目，用它替换。
- `command` 输出只在事件里保留末尾 200 行（`outputTail`），全文存 File Store，用 `outputFileId` 引用；`file.change` 的 diff 一律存 File Store。
- `assistant.message.phase`：一轮里最后一条助手消息标为 `final`，其余为 `interim`（用于第 9.4 节的折叠显示）。原生协议有阶段信息时照搬（例如 Codex `agentMessage.phase`），没有时在 `turn.completed` 到达后把该轮最后一条标为 `final`。

### 6.3 映射表

按工具名判断的行，以 fixtures 和 protocol-notes 为准持续补全。

| 我方 kind | Codex（app-server） | Claude Code（SDK 消息） | DSH（`session/follow` 与 `$events`） |
|---|---|---|---|
| user.message | 我方发送时生成 | 我方发送时生成 | `user/message` |
| assistant.message | `agentMessage` 条目；增量 `item/agentMessage/delta` | assistant 消息的 text block | 持久 `assistant/message`；增量 `assistant-stream` 的 `text-delta` |
| reasoning | `reasoning` 条目；增量 `item/reasoning/summaryTextDelta` | thinking block | 持久 `assistant/message` 的 `message.content[]` 里 `type='reasoning'` 的 `text`；增量 `assistant-stream` 的 `reasoning-delta` |
| command | `commandExecution` 条目；输出 `item/commandExecution/outputDelta` | `Bash` tool_use + tool_result | `tool/call` + `tool/result`，工具名 `bash` |
| file.read | 有模型元数据时用独立的读文件条目；M0 的假模型没有元数据，表现为 `commandExecution`（M3 用 `model_catalog_json` 复核） | `Read` / `Glob` / `Grep` | 工具名 `read`、`read_image`、`glob`、`grep` |
| file.change | `fileChange` 条目；`item/fileChange/patchUpdated`、`turn/diff/updated` | `Edit` / `Write` / `MultiEdit`（由 input 生成 diff） | 工具名 `write`、`edit` |
| tool.call | `mcpToolCall`、`webSearch` 等其余条目 | 其余 tool_use | 其余工具名 |
| plan | `turn/plan/updated`、`item/plan/delta` | `TodoWrite` | `todo/write` 事件（工具名 `todo_write`，没有 `activeForm` 字段） |
| approval.request | `item/commandExecution/requestApproval`、`item/fileChange/requestApproval` 等反向请求 | `canUseTool` | `$events` waterfall `approval/request` |
| approval.resolved | 我方回复后生成 | 我方回复后生成 | `approval/decided`（历史）；我方回复后生成（实时） |
| question | `item/tool/requestUserInput`，回 `{ answers }` | `AskUserQuestion` tool_use 走 **`canUseTool`**（不是 `onUserDialog`）；问题在 `input.questions`（1–4 题，每题 2–4 个 `{label,description,preview?}` + `multiSelect`），答案写回 `updatedInput.answers`（key = 题干原文，多选用 `string[]`），宿主侧结构化结果在 user 消息的 `tool_use_result` | `$events` waterfall `user-questions/request`，回 `$events/result` |
| usage | `thread/tokenUsage/updated` | `result` 里的 usage | `assistant-stream` 的 `usage` chunk |
| turn.started | `turn/started` | 我方发送时生成 | `turn/start` |
| turn.completed | `turn/completed`（`turn.status`） | `result` 消息 | `turn/end` |
| internal | `thread/status/changed`、`account/rateLimits/updated`、`remoteControl/status/changed` 等 | 非 init 的 `system` 消息等 | `request/header`、`step/start`、`step/end`、`agent/inbox/spliced`、`session/end-seed`、`job/*`、`command/run`、`command/done` |
| unknown | 其他 | 其他 | 其他 |

- 标题类事件不进时间线，只用来更新会话标题（写侧边栏日志）：DSH `session/title`、Codex `thread/name/updated`。
- Codex 的 `warning`、`configWarning`、`deprecationNotice` 显示为会话内提示条。
- DSH 的 `ask_user_question` 工具调用不单独成卡：对应的提问卡片来自 `user-questions/request`，避免同一个提问出现两次。

---

## 7. 同步协议（远程优先）

**原则：服务器保存唯一的真实数据，浏览器是缓存；每个用户操作都是可重放、可去重的命令。** 这一节是 WebDCC 和 DSH 网页端的核心区别，必须完整实现。

### 7.1 两条日志

- **会话事件日志**：每个会话一条，`seq` 从 1 递增，无空洞（第 6 节）。
- **侧边栏日志**：全局一条，`feedSeq` 递增。会话的新建、标题、状态（running/waiting/idle/error）、更新时间每变一次就追加一条 `{ feedSeq, sessionId, patch }`。侧边栏也能按 `feedSeq` 补差。

### 7.2 WebSocket 协议（`/api/ws`）

客户端连接后先发 `hello`：

```json
{ "op": "hello", "clientId": "<浏览器标签页 ULID>", "feedAfter": 812, "subscribe": [ { "sessionId": "01J...", "afterSeq": 1234 } ] }
```

服务端依次返回：侧边栏补差（`feed` 消息）→ 每个订阅会话的补差事件（`event`）→ 进行中快照（`snapshot`）→ 之后的实时消息。

| 方向 | 消息 | 说明 |
|---|---|---|
| 客户端→服务端 | `hello` / `subscribe` / `unsubscribe` | 订阅时带 `afterSeq` |
| 客户端→服务端 | `command` | 见 7.4 |
| 客户端→服务端 | `pong` | 回应心跳 |
| 服务端→客户端 | `feed` `{ feedSeq, sessionId, patch }` | 侧边栏变化 |
| 服务端→客户端 | `event` `{ event: StoredEvent }` | 已存事件 |
| 服务端→客户端 | `snapshot` `{ sessionId, items: [{ itemKey, kind, data }] }` | 进行中条目 |
| 服务端→客户端 | `delta` `{ sessionId, itemKey, field, append }` | 流式增量，服务端按 itemKey 每 50 ms 合并一次 |
| 服务端→客户端 | `update` `{ sessionId, itemKey, data }` | 进行中条目的非文本变化 |
| 服务端→客户端 | `ack` `{ clientCommandId, result, seq? }` | 命令结果 |
| 服务端→客户端 | `ping` | 每 15 秒一次 |

### 7.3 断线检测与重连

- 连续 2 次心跳（约 35 秒）未收到服务端消息即判定断线，主动关闭并重连。
- 浏览器触发 `online`、页面切回可见（`visibilitychange`）、窗口获得焦点时，立即重连，不等退避。
- 退避：0.5 → 1 → 2 → 4 → 8 → 15 秒封顶，带 ±20% 随机抖动。
- 重连后用本地缓存里每个会话的最大 seq 和最大 feedSeq 发 `hello`，只补差，不整段重拉。

### 7.4 命令与发件箱

- 所有会改变状态的用户操作都是命令：`send`（发消息）、`approve`（审批）、`answer`（回答提问）、`interrupt`（打断）、`create-session`、`rename`、`archive`。
- 每条命令生成 `clientCommandId`（ULID），**先写入 IndexedDB 发件箱，再发送**。已连接时走 WebSocket；未连接时留在发件箱，重连后按创建顺序重放。
- 服务端把 `clientCommandId` 记入命令日志（保留 7 天）。重复到达的命令直接返回第一次的结果，不重复执行。
- `approve` 额外检查：对已处理的 approvalId 再次决策，返回 `already-resolved`，界面显示实际结果。
- `interrupt` 带过期时间（60 秒），过期未送达则丢弃，并提示"打断未送达，Agent 可能仍在运行"。
- 界面状态：待发送 → 发送中 → 已送达（收到 ack）→ 失败（可重试）。用户消息气泡下方显示该状态。
- 发件箱同时有 HTTP 兜底：`POST /api/commands`（同样按 clientCommandId 去重），供 WebSocket 长时间连不上但 HTTP 可用时使用。

### 7.5 浏览器缓存（IndexedDB）

| store | 键 | 内容 |
|---|---|---|
| `events` | `[sessionId, seq]` | 已存事件 |
| `sessions` | `sessionId` | 会话元数据（来自侧边栏日志） |
| `meta` | 固定键 | `feedSeq`、每个会话已缓存的最小/最大 seq |
| `drafts` | `sessionId` | 本地草稿（同时同步到服务端，见 11.1） |
| `outbox` | `clientCommandId` | 未确认的命令 |

- 打开会话时**先从 IndexedDB 渲染**，再订阅补差。缓存里没有的更早历史，向上滚动时用 `GET /api/sessions/:id/events?before=` 分页取，并写入缓存。
- 缓存上限 300 MB，按会话最近访问时间淘汰；正在打开的会话和发件箱永不淘汰。
- IndexedDB 不可用（隐私模式等）时退化为内存缓存，功能不受影响，只是不能离线阅读。

### 7.6 资源：永久 URL + 长期缓存

- 图片、上传文件、命令全文输出、diff 都存为内容寻址文件，地址 `/files/{fileId}`。
- 响应头：`Cache-Control: private, max-age=31536000, immutable`，带 `ETag`，支持 `Range`。内容不可变，所以链接永不失效，浏览器可长期缓存。
- 事件只引用 `fileId`，不内联大内容。

### 7.7 可续传上传

- `POST /api/uploads` `{ name, size, sha256, mime }` → `{ uploadId, chunkSize: 1048576, received: [] }`
- `PUT /api/uploads/:uploadId/chunks/:index`（单块失败只重传该块）
- `GET /api/uploads/:uploadId` → 已收到的块序号（断线后据此续传）
- `POST /api/uploads/:uploadId/complete` → 服务端校验 sha256 → `{ fileId, url }`
- 已有相同 sha256 的文件时，`POST /api/uploads` 直接返回现成的 `fileId`（秒传）。

**附件：**

- 图片按各 Agent 的原生图片输入传入：Codex 用 `{ type: 'localImage', path }` 指向 File Store 里的文件；Claude Code 用 base64 image block；DSH 是否支持图片见【M5 核实】，不支持时按"其他文件"处理。
- 其他文件复制到 `<工作区>/.webdcc/uploads/<fileId>-<原文件名>`，把相对路径插入输入框（用户可见、可删改）。
- 工作区是 git 仓库时，把 `.webdcc/` 写进 `.git/info/exclude`（本地 git 内部文件，不进版本库、不是项目配置，不违反 R3）。
- 单个附件上限 100 MB。

### 7.8 离线外壳

- Service Worker 预缓存 `index.html` 和所有带 hash 的静态资源；应用路由（`/s/*`、`/new`、`/settings/*`）的导航请求离线时返回缓存的 `index.html`。
- 永不缓存 `/api/*`；`/files/*` 交给浏览器 HTTP 缓存。
- 新版本发布后，下次打开页面时提示"有新版本，刷新即可使用"，不强制刷新。

### 7.9 连接状态展示

- 已连接：不显示任何东西。
- 重连中：主栏顶部细条"网络断开，正在重连（第 N 次）"。
- 离线：顶部条"离线：可以阅读已缓存的内容，N 条操作等待发送"。
- 恢复：提示"已恢复，补齐了 M 条更新"，3 秒后消失。

---

## 8. URL 与路由

### 8.1 ID

- 所有 ID 为 ULID（26 位）。URL 里只出现我方 id；原生 id 存在 `sessions.native_id`。

### 8.2 前端路由（全部绝对路径）

| 路由 | 含义 |
|---|---|
| `/` | 跳到最近打开的会话；没有则显示新会话页 |
| `/new?w={workspaceId}&agent={dsh\|codex\|claude-code}` | 新会话页 |
| `/s/{sid}` | 主栏显示会话 sid，停靠区关闭 |
| `/s/{sid}+{sid2}` | 主栏 sid，停靠区当前标签是会话 sid2 |
| `/s/{sid}?dock=diff:{fileId}` | 停靠区当前标签是某个 diff |
| `/s/{sid}?dock=files` | 停靠区当前标签是工作区文件 |
| `/s/{sid}#e-{seq}` | 主栏定位并高亮某条事件（可与上面组合） |
| `/settings/providers` | Provider 管理 |
| `/files/{fileId}` | 文件本体（服务端直出，不经 SPA） |

- URL 只编码"主栏 + 停靠区当前标签"。停靠区里其他已打开的标签按主栏会话存进 localStorage，属于单个浏览器的便利功能，丢了不影响正确性。
- 服务端对应用路由返回同一个 `index.html`；静态资源用绝对路径 `/assets/...`，深层链接直接打开或刷新都能加载。
- 切换会话、打开或关闭停靠区都用 `history.pushState` 改 URL，不重载页面；前进、后退能还原布局。
- v1 只支持部署在域名根路径或子域名下，不支持路径前缀。

---

## 9. 界面规格（以 DSH 为蓝本）

参考截图在 `docs/reference/dsh/`（第 18 节有清单）。实现前先逐张看一遍；细节拿不准时，读 DSH 仓库 `packages/client/ui-*` 的源码和 README。中文界面，浅色主题优先，深色跟随系统。

### 9.1 框架（三列）

```
┌ 侧边栏 ┬──────── 主栏 ────────┬──── 停靠区（可关）────┐
│ 280px  │ 会话头 + 对话/轨迹    │ 标签栏 + 当前标签内容  │
│        │ 时间线（居中 760px）  │                        │
│        │ 任务面板 + 输入框     │                        │
└────────┴──────────────────────┴────────────────────────┘
```

尺寸规则照搬 DSH（来自 DSH `ui-layout` README）：
- 侧边栏宽 264–420px，默认 280px；屏宽 ≥768px 时收起后保留 56px 窄栏；<768px 时变成抽屉，不占列；<1024px 时自动收起，这时用户若手动展开了侧边栏，打开停靠区会把它再收起。1440px 宽时侧边栏与停靠区可以同时展开（见 `dsh-diff-dock.png`）。
- 停靠区首次打开占视口 45%，之后记住用户拖拽的宽度，上限 70%。为保证主栏至少 400px：先把停靠区缩到 300px，仍不够就关闭停靠区。
- `Mod+B` 切换侧边栏。

### 9.2 侧边栏

- 顶部：产品名 + 收起按钮；下方整宽描边按钮"新会话"。
- 导航：Provider 与模型、设置。
- "工作区"分组标题，右侧图标：搜索会话、添加工作区（服务器目录选择器）。
- 工作区行：文件夹图标 + 名称；悬停出现"在此工作区新建会话"。
- 会话行（挂在工作区下）：
  - 左：Agent 标记（`DS` / `CX` / `CC`，配色见 9.14）。
  - 中：标题，过长省略。
  - 右：状态优先显示"运行中"（蓝）、"待批准"（橙）；否则若在停靠区打开显示"右栏"；否则显示相对时间（"刚刚""12分钟""昨天"）。
  - 悬停操作：在右栏打开、置顶、归档。
  - 当前主栏会话高亮。
- 底部：更多（账号、退出、版本）。

**会话标题：**

- 有原生标题时用原生标题：DSH 的 `session/title` 事件、Codex 的 `thread/name/updated`、Claude Code 若 SDK 提供【M4 核实】。
- 没有原生标题时：取第一条用户消息的第一行，最多 40 个字符，超出加 `…`。
- 用户手动改名后以用户的标题为准，后续原生标题事件不再覆盖。
- 平台不调用任何模型来生成标题。

**添加工作区：** 标题右侧的添加图标打开目录选择器，逐级浏览服务器目录（默认从服务器用户的家目录开始），也允许直接输入绝对路径；数据来自 `GET /api/fs/browse`（11.1）。

### 9.3 主栏会话头

- 一行：会话标题（点击可改名）、Agent 徽标（标记 + 名称）、`···`（重命名、归档、导出、复制链接）、停靠区开关。"导出"下载该会话全部事件（JSONL，每行一个 `StoredEvent`），接口 `GET /api/sessions/:id/export`。
- 下方标签：对话 / 轨迹，当前标签蓝色下划线。

### 9.4 对话时间线（每一轮）

- **用户消息**：右对齐浅蓝气泡（`#EEF3FF`），下方是时间和复制按钮；自己刚发的消息显示发件箱状态（7.4）。
- **运行中的轮次**：标题行"运行中，用时 3分12秒…"带转圈；所有步骤行都展开，最新的在最下面；用户停在底部时自动跟随滚动。
- **等待审批的轮次**：标题行"等待你的批准 · 已用时 48秒"（橙色）。
- **已完成的轮次**：标题行"已完成，用时 2分14秒 ⌄"，下面一条分隔线。
  - 默认收起：只显示 `phase: final` 的助手回复、改动汇总卡片、页脚。
  - 点开：按 seq 顺序显示所有步骤行和中间回复（`interim`）。
- **步骤行**：图标 + 动词 + " · " + 说明，例如"运行命令 · 列出项目文件""读取文件 · SPEC.md""编辑文件 · package.json""思考 · 已完成分析"。点击展开详情：命令输出末尾（可"查看全文"打开 `outputFileId`）、文件路径、工具输入输出 JSON。
- **改动汇总卡片**（一轮里有 `file.change` 时）：标题"已编辑 N 个文件 +a -d"（运行中为"已改动"），每个文件一行，显示 +/- 行数；悬停显示 diff 预览浮层；点击在停靠区打开 diff 标签；卡片标题栏右侧有"带到…"（带的是文件路径列表）。diff 按 6.1 的优先级取；整文件写入且拿不到原内容时，卡片上注明"整文件写入，未取得原内容"。
- **审批卡片**：出现在时间线里请求发生的位置，标题"{Agent} 请求运行命令"，展示命令或改动，按钮是原生选项（例如"允许一次 / 本会话都允许 / 拒绝"）；处理后变成一行结果说明。
- **提问卡片**：按 schema 渲染简单表单，未知 schema 退化为文本输入。
- **页脚**（已完成且有最终回复的轮次）：复制、"带到…"（带的是最终回复原文）、用量、时间。
- **未知事件**：折叠的原始 JSON。
- **出错**：Agent 启动失败或中途报错时出现 `error` 卡片，写明原因与处理方法（例如"服务器上没有安装 Codex CLI"）；侧边栏状态显示"出错"。
- 虚拟列表渲染；流式增量渲染节流到 50 ms。

### 9.5 任务面板

- 贴在输入框上方，来自最新一条 `plan` 事件。标题行"任务 1 已完成 · 1 进行中 · 1 待处理"，点击展开或收起列表；已完成项删除线，进行中项蓝色。

### 9.6 输入框

- 圆角输入框，占位文字"发消息或创建任务, / 调用指令, @ 文件或对话"；Enter 发送，Shift+Enter 换行；高度随内容增长。
- 底栏左侧：`+`（添加文件、图片；粘贴图片也可）、访问模式（原生枚举，见下表）。附件规则见 7.7：图片走原生图片输入；其他文件复制到 `<工作区>/.webdcc/uploads/` 并把相对路径插入输入框。
- 底栏右侧：模型选择（只列出本会话 Provider 下的模型，菜单标题写"{Provider}（创建会话时选定）"）、发送按钮（运行中变为停止，即打断）。
- 输入 `@`：弹出两组：
  - "文件与文件夹"：工作区内文件搜索，选中后插入相对路径；
  - "对话"：同一工作区的其他会话（带 Agent 标记和时间），选中后插入该会话最后一条 `final` 回复的原文。
- 输入 `/`：按 Agent 的原生能力列出命令，选中后把命令文本原样插入输入框，由用户决定发送。
  - Claude Code：列出 init 消息里的 slash commands，发送时作为普通用户消息交给 SDK【M4 核实 streaming input 模式下能识别斜杠命令】。
  - DSH：列出 DSH 的命令目录（端点从 `host-api-catalog.json` 里找）【M5 核实】。用户发送的消息若第一行是已知的 DSH 命令，就用 `commands/execute` 执行用户输入的原文，不走 `session/prompt`——与 DSH 自己的网页端行为一致。
  - Codex：v1 不提供 `/` 菜单（Codex 的斜杠命令属于 TUI），用户输入原样发送。
- 输入框下方一行统计（只显示 Agent 提供的字段）：轮数、步数、tok/s、总 token、缓存命中、上下文占用。

| Agent | 访问模式（原生） | 切换方式 |
|---|---|---|
| DSH | 仅可查看 `read-only` / 工作区内修改 `workspace-write` / 完全权限 `danger-full-access` / 自动审查（实验）`auto` | `/permission <preset>`（5.4.6），会话中途可改 |
| Codex | 四档：只读 `read-only`（`on-request` + `read-only`）/ 工作区可写 `workspace`（`on-request` + `workspace-write`）/ 工作区可写 + 自动审批（上一行 + `approvalsReviewer:'auto_review'`）/ 完全访问 `danger-full-access`（`never` + `danger-full-access`），档位来自 `permissionProfile/list` | 新建走 `thread/start` 的 `approvalPolicy` / `sandbox` / `approvalsReviewer`；**中途切换走 `turn/start` 的 `approvalPolicy` / `sandboxPolicy` / `approvalsReviewer` 覆盖**（本轮及之后所有轮），不用 `thread/resume` |
| Claude Code | `default` 默认（每次询问）/ `acceptEdits` 自动接受编辑 / `plan` 计划模式 / `dontAsk` 不询问 / `auto` 自动 / `bypassPermissions` 跳过权限 | `setPermissionMode()`，会话中途可改 |

界面显示中文名，旁边小字显示原生 id；默认值沿用各 Agent 用户配置里的设定。

Codex 补充规则：始终显式传 `approvalsReviewer:'user'`（否则用户自配 `auto_review` 时审批请求会被审查子代理吞掉、我们的弹窗收不到）；"完全访问"档固定 `approvalPolicy:'never'`；`granular` 档 v1 不提供（需要 `experimentalApi` 能力）。

### 9.7 停靠区（右侧）

- 顶部标签栏：每个标签有图标和标题，可关闭；`+` 菜单：工作区文件、打开另一个会话（列出所有会话）。右侧按钮：全屏、收起。
- 标签类型：
  - **会话**：子标题行（Agent 标记、标题、状态、"移到主栏"），下面是该会话的时间线和它自己的输入框。"移到主栏"把它和主栏会话对调。
  - **改动 diff**：左右对比或合并视图、自动换行开关，标题"改动 · 文件名"，并注明来自哪个会话。
  - **工作区文件**：目录树 + 只读预览（代码高亮、Markdown、图片）。图片与 PDF 用 `GET /api/workspaces/:id/raw?path=` 原样返回，路径检查与 `/fs` 相同（解析符号链接后必须仍在工作区内）。
- 没有标签时显示"开始"页：工作区文件、打开另一个会话。
- 同一个会话不能同时在主栏和停靠区；在停靠区打开主栏会话时提示"已经在主栏里了"。

### 9.8 轨迹标签

- 平铺所有事件（含 seq、时间、类型、简述），顶部有搜索框和类型筛选；点击一行在对话标签里定位到该事件（`#e-{seq}`）。

### 9.9 新会话页

- 居中标题"新会话"；工作区选择；三张 Agent 卡片（DeepSeek Harness / Codex / Claude Code，各带一句"原装运行 …"）；Provider 选择（只列出与该 Agent 协议兼容的，见 10.2，不兼容的灰显并注明原因）；输入框（含模型选择）。
- 发送第一条消息即创建会话，并跳到 `/s/{新ID}`。
- `probe()` 报告未安装的 Agent，卡片灰显并写明原因（例如"服务器上没有安装 Codex CLI"）；未登录时只灰显"原生登录"这个 Provider，其他 Provider 照常可选。

### 9.10 交接规则

- "带到…"弹出目标列表：同一工作区的其他会话（带 Agent 标记，并注明"主栏 / 右栏"），以及"新建 DSH / Codex / Claude Code 会话"。
- 选中后，内容**追加**到目标会话的草稿：回复原文逐字插入；文件路径每行一个。目标不在主栏时，自动在停靠区打开它。
- 平台不自动发送；提示"已放进「标题」的输入框，还没发送"。

### 9.11 完成提醒

- 非当前查看的会话完成一轮或开始等待审批时：侧边栏状态更新，页面标题显示未读数（例如"(2) WebDCC"），并发浏览器通知（首次需要时请求通知权限）。
- 只提醒人，不触发任何发给 Agent 的动作。

### 9.12 窄屏（手机）

- 侧边栏为抽屉；停靠区以全屏面板打开（左上角返回主栏）；输入框固定在底部。

### 9.13 视觉

- 观感贴近 DSH：系统中文字体、正文 14–14.5px、行高 1.7；侧边栏浅灰背景（约 `#F7F8FA`），主区白色；细边框；强调色蓝（约 `#2F5FD0`）；新增行绿、删除行红。
- 可以借用 DSH 仓库里 MIT 协议的样式和展示组件代码，但要在 `THIRD_PARTY_NOTICES.md` 保留声明。

### 9.14 Agent 标记

| Agent | 标记 | 背景 / 文字 |
|---|---|---|
| DeepSeek Harness | DS | `#E3ECFF` / `#2350C8` |
| Codex | CX | `#E7E8EB` / `#23262B` |
| Claude Code | CC | `#FBE7DD` / `#9E4216` |

---

## 10. Provider 与模型接入

### 10.1 概念

- **Provider** = 一个模型端点：名称、`baseUrl`、协议（可多选）、API Key、模型列表、可选的 Codex 模型元数据文件路径。
- **原生**（`providerId = null`）= 不注入任何东西，Agent 用它自己的登录和配置。

### 10.2 协议兼容矩阵

| Agent | 需要的协议 | 原生选项 | 说明 |
|---|---|---|---|
| Codex | `openai-responses` | 用户自己的 Codex 登录和配置 | Codex 已移除 `wire_api = "chat"`，只接受 Responses API |
| Claude Code | `anthropic-messages` | 用户自己的 Claude 登录 | `ANTHROPIC_BASE_URL` 指向兼容端点 |
| DSH | DSH 自己的 Provider 机制 | DSH 设置里已配置的模型 | v1 只用原生；见 10.4 |

DeepSeek 官方 API 同时原生支持 Responses API 和 Anthropic 格式（`https://api.deepseek.com/anthropic`），所以 Codex + DeepSeek、Claude Code + DeepSeek 都不需要转换代理。

### 10.3 注入方式（只用启动参数和环境变量，满足 R3）

**Codex**（每会话一个进程）：

```bash
WDCC_PROVIDER_KEY=<key> codex app-server \
  -c model_provider=wdcc_<providerId> \
  -c 'model_providers.wdcc_<providerId>.name="<名称>"' \
  -c 'model_providers.wdcc_<providerId>.base_url="<baseUrl>"' \
  -c 'model_providers.wdcc_<providerId>.wire_api="responses"' \
  -c 'model_providers.wdcc_<providerId>.env_key="WDCC_PROVIDER_KEY"' \
  -c 'model_catalog_json="<模型元数据文件路径，非 OpenAI 模型必填>"'
```

- 【已实测】app-server 接受上面的点路径写法；不需要 `preferred_auth_method`、`forced_login_method`，也不需要 `codex login`。
- 非 OpenAI 模型务必提供 `model_catalog_json`，否则 Codex 用兜底元数据，下发的工具不同（5.2）。
- DeepSeek 例：`base_url` 为 `https://api.deepseek.com/`，模型 `deepseek-flash`、`deepseek-v4-pro`；DeepSeek 官方提供的 `models.json` 由用户下载后在 Provider 里填路径，平台不编写其内容。

**Claude Code**（SDK `options.env`）：

```bash
ANTHROPIC_BASE_URL=<baseUrl>            # 不带 /v1
ANTHROPIC_AUTH_TOKEN=<key>
ANTHROPIC_API_KEY=                      # 必须为空字符串，否则它优先于 AUTH_TOKEN
ANTHROPIC_MODEL=<model>                 # 可选
ANTHROPIC_DEFAULT_OPUS_MODEL=<model>    # 可选：档位别名映射
ANTHROPIC_DEFAULT_SONNET_MODEL=<model>
ANTHROPIC_DEFAULT_HAIKU_MODEL=<model>
```

- DeepSeek 例：`https://api.deepseek.com/anthropic`；它把 `claude-opus*` 映射到 `deepseek-v4-pro`，`claude-sonnet*` / `claude-haiku*` 映射到 `deepseek-flash`。

### 10.4 DSH 的 Provider

- v1：DSH 的模型来自它自己（`session/modelCatalog`），切换用 `session/selectModel`；Provider 在 DSH 自己的设置里管理，平台不调用 DSH 的 Provider、凭据相关端点。
- 侧车是所有 DSH 会话共用的一个进程，所以不按会话注入环境变量。`DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY` 只在测试里用来接假模型（第 13 节）。

### 10.5 订阅登录与凭据

- 原生选项依赖各 CLI 已在服务器上登录；`probe()` 报告登录状态，未登录时在新会话页对应 Provider 旁提示。
- API Key 存 `WDCC_DATA_DIR/secrets.json`（权限 0600），数据库只存引用；只在启动子进程时注入，不写入日志、事件或 API 响应。

---

## 11. 服务端 API 与数据模型

### 11.1 REST（除 `GET /?token=` 外全部要求认证 Cookie）

| 方法与路径 | 说明 |
|---|---|
| `GET /?token=...` | 校验 token，设 Cookie，302 到 `/`。无 token 且无有效 Cookie：返回静态页"请用启动时打印的带 token 链接打开" |
| `GET /api/meta` | 版本、各 Agent 的 `probe()` |
| `GET` / `POST /api/workspaces` | 列出 / 新建工作区 `{ name, path }`（path 必须是已存在目录） |
| `GET /api/workspaces/:id/fs?path=&q=` | 只读列目录、搜文件、读文本（限 1 MB）；解析符号链接后必须仍在工作区内，否则 400 |
| `GET /api/feed?after=` | 侧边栏日志补差（WebSocket 不可用时的兜底） |
| `GET /api/sessions/:id` | 会话元数据、状态、`last_seq`、进行中快照 |
| `GET /api/sessions/:id/events?before=&after=&limit=` | 分页取事件（limit ≤ 500） |
| `POST /api/commands` | 命令的 HTTP 兜底（7.4），按 clientCommandId 去重 |
| `GET` / `PUT /api/sessions/:id/draft` | 草稿（防抖 1 秒保存，跨设备可见） |
| `POST /api/uploads` 等 | 可续传上传（7.7） |
| `GET /files/:id` | 文件（7.6） |
| `GET` / `POST` / `PATCH` / `DELETE /api/providers[/:id]` | Provider 管理；不返回 Key 原文 |
| `GET /api/models?agent=&providerId=` | 可选模型 |
| `GET /api/fs/browse?path=` | 列出服务器某目录下的子目录（"添加工作区"用，默认从家目录开始） |
| `GET /api/workspaces/:id/raw?path=` | 原样返回工作区内某个文件（图片、PDF 预览），路径检查同 `/fs` |
| `GET /api/sessions/:id/export` | 导出该会话全部事件（JSONL，每行一个 `StoredEvent`） |

### 11.2 SQLite 表

```sql
CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
  protocols TEXT NOT NULL, secret_ref TEXT NOT NULL, models TEXT NOT NULL,
  codex_catalog_path TEXT, created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent TEXT NOT NULL, native_id TEXT, title TEXT,
  provider_id TEXT REFERENCES providers(id), model TEXT, access_mode TEXT,
  status TEXT NOT NULL DEFAULT 'idle', pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT 0, native_meta TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE events (
  session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL,
  turn_id TEXT NOT NULL, item_key TEXT NOT NULL, kind TEXT NOT NULL, native_seq INTEGER,
  data TEXT NOT NULL, native TEXT, at TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE TABLE feed (feed_seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, patch TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE commands (client_command_id TEXT PRIMARY KEY, op TEXT NOT NULL, result TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE files (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE uploads (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, received TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE drafts (session_id TEXT PRIMARY KEY REFERENCES sessions(id), text TEXT NOT NULL, file_ids TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL);
```

- seq 分配和事件写入在同一事务；feed 追加与会话状态更新在同一事务。

---

## 12. 认证与部署

### 12.1 认证（与 DSH 相同的 token 方式）

- `WDCC_TOKEN` 固定访问 token；未设置时启动随机生成（至少 32 字节）并打印 `http(s)://<host>:<port>/?token=<token>`。
- 校验通过后设 HttpOnly、SameSite=Lax 的签名 Cookie（30 天），跳转并去掉地址栏里的 token。Cookie 签名密钥由 token 派生，更换 token 即让旧 Cookie 失效。
- `/api/*`、`/api/ws`、`/files/*`、`/api/uploads/*` 无有效 Cookie 一律 401。
- 不做登录页和账号体系；HTTPS 可选（可直接 HTTP，或前面放用户自己的反向代理，需支持 WebSocket upgrade）。
- Service Worker 只在 HTTPS 或 localhost 下可用。纯 HTTP 部署时离线外壳（7.8）自动不启用，其余同步能力不受影响；deploy.md 里写明这一点。

### 12.2 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WDCC_HOST` | `0.0.0.0` | 监听地址 |
| `WDCC_PORT` | `8787` | 端口 |
| `WDCC_TOKEN` | 随机 | 访问 token |
| `WDCC_DATA_DIR` | `~/.webdcc` | 数据库、文件、secrets |
| `WDCC_DSH_PORT` | `3091` | DSH 侧车端口（仅 127.0.0.1） |
| `WDCC_IDLE_DISPOSE_MIN` | `30` | 空闲多久释放会话进程 |

### 12.3 部署

- 单台 Linux 服务器，以用户自己的系统账号运行，各 Agent 读取该账号下的 `~/.codex`、`~/.claude`、`~/.dsh`。
- 前置：Node ≥ 24（锁定版本见 deploy.md）；按 deploy.md 锁定的版本全局安装 Codex CLI、`@deepseek-ai/dsh`；Claude Agent SDK 作为 npm 依赖随平台安装；需要原生登录的 CLI 在服务器上登录一次。
- 部署前检查服务器：CPU 是否支持 AVX2（`grep -c avx2 /proc/cpuinfo`）；Landlock 是否完整生效。开发机上关于沙箱和审批触发的结论要在服务器上复核。
- systemd unit 示例：`Restart=on-failure`，环境变量放 `EnvironmentFile`。
- 启动：`pnpm build && node packages/server/dist/main.js`。
- 本次交付只做到「本机按生产方式运行」：`pnpm build`，以 `WDCC_HOST=0.0.0.0` 启动，systemd unit 示例写进 deploy.md，全部验收在本机跑完；部署到用户服务器由用户自己完成。

---

## 13. 测试设施：假模型服务

`packages/testing/mock-models`（M0 已实现）提供两个按脚本回放的假模型服务，不花 API 费用就能端到端驱动三个原装 Agent。

- **mock-anthropic**：`POST /v1/messages`（Anthropic Messages 流式：`message_start`、`content_block_start/delta/stop`（thinking + `signature_delta`、text、tool_use + `input_json_delta`）、`message_delta`、`message_stop`），以及 `POST /v1/messages/count_tokens`、`GET /models`、`GET /v1/models`；未知端点返回 404 并记日志。
  - 驱动 DSH：侧车启动时设 `DEEPSEEK_BASE_URL`、`DEEPSEEK_API_KEY`。【已实测】
  - 驱动 Claude Code：`ANTHROPIC_BASE_URL`。【已实测】Claude Code 只请求 `POST /v1/messages` 和 `HEAD /api/hello`。
- **mock-responses**：OpenAI Responses 流式事件（`response.created` … `response.completed`，序列见 protocol-notes §4.2），供 Codex 自定义 Provider 使用。【已实测】
- **脚本格式**（`plans/*.json`）：数组，第 N 项是收到第 N 个工具结果后要回的内容块；`tool.kind` 只写语义（command / read / write / edit / todo / ask / patch），具体工具名按请求里的 `tools` 匹配；`alternatives` 处理不同 Agent 的同义工具，`inputByName` 处理同一工具在不同 Agent 下的不同参数名。
- **审批用例**：DSH 要让脚本里的命令显式带 `sandbox_permissions` 和 `justification` 才会请求审批（5.4.5）；Codex 用 `approvalPolicy: 'untrusted'`；Claude Code 用 `permissionMode: 'default'` 下的 `Write` / `Edit`。
- **Codex 模型元数据【已实测】**：`model_catalog_json` 的自定义条目必须带 `base_instructions` 或 `model_messages.instructions_template`，否则 Codex 拒绝启动；填它等于平台提供系统提示词，违反 R1。因此 v1 不使用自定义 catalog，Codex 用自带元数据；`fileChange` / `turn/plan/updated` 在假模型下不会出现，相关映射仍按 6.3 实现，等真实模型或未来版本再验。
- **一个坑【已实测】**：Claude Code 的第一个 `POST /v1/messages` 是预热/配额请求（`tools: []`、只有 1 条 message），plan 第 0 步会回给它但被 CLI 丢弃；真正的对话请求是第 2 个。做"第 N 次模型调用"的断言要跳过首包。
- **审批用例**：DSH 要让脚本里的命令显式带 `sandbox_permissions` 和 `justification` 才触发审批；Codex 用 `approvalPolicy:'untrusted'`；Claude Code 用 `permissionMode:'default'` 下的 `Write` / `Edit`。
- 所有 e2e 用例默认跑假模型；带真实 Key 的用例在没有 Key 时自动跳过。

---

## 14. 执行步骤（里程碑）

每个里程碑：新建分支 → 实现 → 跑对应验收 → `gh pr create`（描述里列出验收结果）→ `gh pr merge --squash --delete-branch` 自动合并 → 从最新 main 开下一个分支。详见 0.1 节。

### M0 仓库、工具链与协议探针（已完成）

结果见 `docs/protocol-notes.md`，v2.1 已据此修订本 SPEC。下面保留原步骤作记录。

1. 确认 gh 已登录并创建仓库：

   ```bash
   gh auth status
   gh repo create WebDCC --private --description "Unified web UI for DeepSeek Harness, Codex and Claude Code" --clone
   cd WebDCC
   ```

2. 放入初始文件：本 `SPEC.md`、`docs/reference/dsh/` 截图、`README.md`（一段话介绍 + 指向 SPEC）、`.gitignore`（node_modules、dist、`.webdcc`、`.env*`）、空的 `THIRD_PARTY_NOTICES.md`。提交 `docs: add SPEC v2 and DSH reference screenshots` 并 `git push -u origin main`。后续里程碑都从 main 拉分支。
3. 搭 pnpm workspace 骨架（第 4.2 节目录），配置 TypeScript strict、Vitest、Playwright、ESLint；提交。
4. 在开发机上安装三个 Agent，记录版本号写入 `docs/deploy.md` 作为锁定版本。
5. Codex：`codex app-server generate-ts` 和 `generate-json-schema` 导出到 `packages/adapters/codex/src/schema`。
6. 实现 `mock-anthropic` 和 `mock-responses`（第 13 节）。
7. 每个 Agent 一个探针脚本 `scripts/probe-<agent>.ts`：新建会话 → 一轮含读文件、执行命令、写文件的对话 → 触发一次审批 → 打断一轮 → 杀进程后恢复再发一轮。先对假模型跑通，有真实 Key 时再对真实模型跑一遍。
8. 原始收发帧脱敏后存 `fixtures/<agent>/*.jsonl`。
9. DSH：读 DSH 源码，确认 Host API 方法名、事件流路径、Cookie 交换、workspace 映射、图片输入、访问模式枚举；验证同一 `DSH_HOME` 并发运行两个 `dsh web` 是否安全。
10. Claude：确认 `setModel`、`setPermissionMode`；确认 SDK 会话加载了 hooks 和项目 `.mcp.json`；记录 init 里的 tools、MCP servers、slash commands；记录 Claude Code 对假模型请求的全部端点。
11. Codex：确认 `-c` 在 app-server 上生效（否则验证 10.3 备选方案）；确认 `skills/list`、`mcpServerStatus/list`、访问模式组合。
12. 所有【M0 核实】项写进 `docs/protocol-notes.md`。

**门槛：** 仓库已创建并推送；三个探针脚本对假模型跑完第 7 步全部动作；`protocol-notes.md` 覆盖全部【M0 核实】项。

### M1 服务端核心与同步协议

1. `protocol` 包类型（第 5.1、6、7 节）；Fastify、Auth、SQLite 迁移（11.2）。
2. 工作区、会话 CRUD；Event Store；侧边栏日志；命令日志与去重；Live Hub（hello、补差、快照、50 ms 合并增量、心跳）。
3. File Store、可续传上传、`/files` 缓存头。
4. `fake-adapter`：按 fixtures 回放，可注入延迟、乱序到达的增量、未知事件、内部事件。
5. 确认前端构建链（Vite 等）不依赖 rolldown 原生二进制，在开发机上 `pnpm build` 能跑通（4.1 硬件限制）。

**门槛：** A9、A10、A11 通过；A6 的服务端部分（6c、6d、6f）用脚本客户端通过。

### M2 前端外壳（DSH 式）

1. 路由（第 8 节）、三列框架与尺寸规则（9.1）、侧边栏（9.2）、会话头与标签（9.3）。
2. 时间线全部卡片（9.4）、任务面板（9.5）、输入框（9.6，含 `@` 和发件箱状态）、轨迹（9.8）。
3. 同步客户端：IndexedDB 缓存、WebSocket 续传、心跳与重连、发件箱、连接状态条（7.3–7.5、7.9）；Service Worker（7.8）。
4. 全部基于 fake-adapter 开发和测试。

**门槛：** A3、A5，以及 A6 的 6a、6b、6e 通过；A12 的第一轮截图已存档到 `docs/acceptance/M2/`（标「待用户确认」）。

### M3 CodexAdapter

1. 前置【已实测，结论已修订】：`model_catalog_json` 的自定义模型条目**必须**带 `base_instructions` 或 `model_messages.instructions_template`，否则 Codex 拒绝启动（`model ... is missing both ...`）。填写这两个字段等于由平台提供系统提示词，违反 R1，因此**不使用自定义 catalog**；改用 Codex 自带模型元数据。代价是 Codex 只下发 `exec_command` 等工具，不产生 `fileChange` 与 `turn/plan/updated`，adapter 按 5.2/6.3 的"两种情况"处理（只有 `commandExecution` 时如实显示为命令）。重录 `fixtures/codex` 以确认真实条目集合。访问模式已提前核实（protocol-notes §7.1）：档位来自 `permissionProfile/list`、中途切换用 `turn/start` 的 `sandboxPolicy`（结构化）、`resume` 只在冷恢复生效、`untrusted` 只能作参数、`granular` 需要 `experimentalApi`（v1 不提供）。
2. 实现 5.2，fixtures 单元测试，`native.spec.ts` 的 Codex 部分。

**门槛：** 用 Codex 时 A1、A2 通过。

### M4 ClaudeAdapter

1. 实现 5.3，fixtures 单元测试，`native.spec.ts` 的 Claude 部分。

**门槛：** 用 Claude Code 时 A1、A2 通过。

### M5 DshAdapter

1. 前置已提前核实（protocol-notes §7.2、§7.3）：实时提问只能用 `$events/result` 关闭（`userQuestions/answer` 仅计时模式）；思考内容在 `assistant/message` 的 `message.content[type='reasoning'].text`；`commands/execute` 只能执行 `/permission` 或用户本人输入的命令。
2. 侧车管理（启动、解析 token、换 Cookie、健康检查、重启）；单条 `remote.mux` 复用 `$events` 和各会话的 `session/follow`；`$events/result` 回复审批，未处理的 waterfall 在打断、断开、释放时回 `cancelled`；`/permission` 访问模式；`nativeSeq` 去重与补齐（5.4.7）；`native.spec.ts` 的 DSH 部分。

**门槛：** 用 DSH 时 A1、A2 通过。

### M6 停靠区、交接、Provider、新会话

1. 停靠区全部标签类型与规则（9.7）；"移到主栏"。
2. "带到…"（9.10）；新会话页（9.9）；完成提醒（9.11）。
3. Provider 管理页、兼容矩阵、Codex / Claude 注入（第 10 节）。

**门槛：** A4、A7、A8、A13 通过。

### M7 弱网加固、部署与总验收

1. 用 Playwright 网络模拟把 A6 全部场景跑通，修掉发现的问题。
2. 写 `docs/deploy.md` 与 systemd 示例，并按「本机生产方式」（`pnpm build` + `WDCC_HOST=0.0.0.0`）在本机跑通；部署到用户自己的服务器由用户完成。
3. 逐项跑第 15 节，结果与证据（截图、日志、测试输出）写进 `docs/acceptance-report.md`。

**门槛：** A1–A13 全部通过；其中 A12 可以是「待用户确认」，A1、A7 的真实模型部分可以是「待真实模型验证」，其余各项必须真实通过。

---

## 15. 验收标准

- [ ] **A1 三个 Agent 的基本能力（G1）**：DSH、Codex、Claude Code 各自都能：新建会话；逐字流式输出；看到命令、读文件、改文件、工具调用步骤；在网页上完成一次审批；打断一轮；重启平台后在同一会话继续，且 Agent 记得之前的上下文。先用假模型通过，再用真实模型各跑一遍（没有 Key 或登录时真实模型部分标「待真实模型验证」）。DSH 的审批用例按 5.4.5 由脚本显式请求提权；打断或关闭 DSH 会话时，未处理的审批都被回复 `cancelled`，DSH 不残留挂起的轮次。
- [ ] **A2 原装（G1）**：`native.spec.ts` 全部通过；用结构化数据对比能力清单（Claude：init 里的 MCP servers 和 slash commands 与在同目录运行交互式 `claude` 时 `/mcp`、斜杠菜单一致；Codex：`skills/list`、`mcpServerStatus/list` 与同目录直接运行 `codex app-server` 的结果一致；DSH：平台建的会话所用 preset 与 Host API `agentPresets/read` 读到的一致，且模型拿到的工具列表与在 DSH 自带网页端同一 workspace 新建会话时一致；对比时先停掉 WebDCC 的侧车，避免两个 `dsh web` 同时运行）；工作区放一个写有特殊约定的 AGENTS.md / CLAUDE.md，网页端里对应 Agent 遵守它。
- [ ] **A3 URL（G3）**：`/s/A`、`/s/A+B`、`/s/A?dock=diff:F`、`#e-{seq}` 在另一个已认证浏览器打开得到相同布局和内容；两个标签页同时打开同一会话，流式输出同步；流式中刷新不重复、不缺字；前进、后退能还原布局。
- [ ] **A4 文件（G3）**：上传文件在刷新、服务重启、换设备后通过 `/files/{id}` 都能打开；响应带 `immutable` 缓存头和 ETag；无 Cookie 返回 401。
- [ ] **A5 切换性能（G5）**：会话有 5,000 条事件。已缓存时，从另一个会话切过去到首屏内容出现 ≤ 150 ms；未缓存时首个请求只取 ≤ 200 条事件，首屏 ≤ 1 秒（RTT ≤ 100 ms）。Playwright 计时。
- [ ] **A6 弱网（G4）**，Playwright 网络模拟：
  - 6a 往返 2 秒、带宽 50 KB/s：流式输出持续可见，界面操作无卡死。
  - 6b 流式输出中断网 30 秒再恢复：最终时间线与服务端数据逐条一致，无重复、无缺失；恢复提示显示补齐条数。
  - 6c 离线时发送消息：气泡显示"待发送"；恢复后自动送达，服务端只收到一次。
  - 6d 离线时点审批：恢复后只生效一次；若已被处理，界面显示实际结果。
  - 6e HTTPS 部署下离线刷新页面：应用外壳能打开，已缓存会话可阅读，顶部显示离线状态。
  - 6f 上传 20 MB 文件，中途断网再恢复：从断点续传，最终 sha256 一致。
- [ ] **A7 Provider（G6）**：登记 DeepSeek Provider 后，Codex（`deepseek-v4-pro`）和 Claude Code（Anthropic 兼容端点）都能完成 A1 的对话部分；不兼容组合灰显并写明原因；Key 不出现在日志、事件或 API 响应中。真实模型部分没有 Key 时标「待真实模型验证」。
- [ ] **A8 交接（G7）**：完整跑通 1.2 节流程。"带到…"和 `@` 插入后，目标输入框里的文本与来源原文逐字节一致；平台没有自动发送任何消息。
- [ ] **A9 认证（G8）**：无 Cookie 时所有受保护路径返回 401；错误 token 不设 Cookie；更换 `WDCC_TOKEN` 后旧 Cookie 失效。
- [ ] **A10 事件完整性**：fake-adapter 回放 10,000 帧，期间随机断开重连 WebSocket 20 次；客户端最终事件序列与数据库一致（seq 连续、无重复），侧边栏状态与服务端一致。
- [ ] **A11 未知事件不丢**：注入一个未知类型的原生事件，它以 unknown 卡片出现在时间线里。
- [ ] **A12 界面（G2）**：在 1440×900 和 390×844 下截图，覆盖：侧边栏、运行中轮次、已完成轮次（收起与展开）、改动卡片、审批卡片、任务面板、`@` 弹窗、停靠区（会话标签与 diff 标签）、新会话页。截图存档到 `docs/acceptance/M7/`，与 `docs/reference/dsh/` 的对照结论标「待用户确认」。
- [ ] **A13 提醒**：后台会话完成或等待审批时，侧边栏状态、页面标题未读数、浏览器通知都出现，且没有任何消息被自动发给 Agent。

---

## 16. 风险与对策

| 风险 | 对策 |
|---|---|
| Codex app-server schema 不稳定 | 锁定版本；升级时重新 `generate-ts`，跑 fixtures；`probe()` 发现版本不一致时警告 |
| DSH 处于开发者预览，Host API 是内部接口且变化快（M0 发现早期社区资料已过时） | 以 `host-api-catalog.json` 为准；升级 DSH 时重新导出目录并与上一版 diff；只用 5.4.8 白名单；升级前重跑 M0 探针 |
| DSH 每个 Cookie 只允许一条 WebSocket | adapter 只开一条 `remote.mux` 复用所有流；断开后整体重连并重开各流 |
| 开发机或服务器 CPU 不支持 AVX2 | 构建、测试工具避开 rolldown 原生二进制；部署前检查 |
| Claude Agent SDK 与 CLI 行为差异，`-p` 将来默认 bare 也可能波及 SDK | 3.2 固定选项 + A2 对比；锁定 SDK 版本；升级前重跑 A2 |
| 访问 token 等同服务器 shell 权限 | 文档提示；token ≥ 32 字节；可随时更换 |
| 多个会话同时改同一工作区 | v1 不加锁；每轮的改动卡片标明本会话改了哪些文件，侧边栏显示哪些会话正在运行（v1 没有工作区级的「项目改动」面板） |
| 纯 HTTP 部署时 Service Worker 不可用 | 离线外壳自动关闭，其余同步能力不受影响；文档建议 HTTPS |
| 跨协议用模型效果下降 | 用户自行选择；兼容矩阵只保证协议正确 |

---

## 17. Future（不承诺）

- VS Code 式代码 review：文件树、并排 diff（Monaco）、在代码行上评论，评论汇总进当前会话草稿。
- 停靠区分栏（DSH 已有）、终端标签页、浏览器预览标签页。
- 导入平台之外创建的原生历史会话。
- 跨会话全文搜索与事件级深链搜索结果。
- 通过 ACP 接入更多 Agent。
- DSH 按会话切换 Provider（多侧车）。

---

## 18. 参考资料

**DSH 实测截图（`docs/reference/dsh/`，DSH 0.2.2-rc.1，假模型驱动；`dsh-running.png` 为用户提供的真实使用截图）**

| 文件 | 内容 |
|---|---|
| `dsh-home.png` | 首次打开：侧边栏、空工作区、欢迎弹窗 |
| `dsh-first-reply.png` | 一问一答：会话头、对话/轨迹标签、输入框、统计行 |
| `dsh-turn-collapsed.png` | 已完成轮次收起：最终回复 + "已编辑 2 个文件"卡片 + 任务面板 |
| `dsh-turn-expanded.png` | 同一轮展开：思考、中间回复、工具步骤汇总 |
| `dsh-diff-dock.png` | 点改动文件：停靠区打开 diff 标签，悬停 diff 浮层 |
| `dsh-trajectory.png` | 轨迹标签：时长概览与事件列表 |
| `dsh-at-menu.png` | 输入 `@`：文件与文件夹、对话 |
| `dsh-plus-menu.png` | `+` 菜单：添加文件与指令 |
| `dsh-access-menu.png` | 访问模式菜单 |
| `dsh-dock-start.png` | 停靠区"开始"页 |
| `dsh-running.png` | 运行中的轮次：步骤行、任务面板、目标条、右侧图片预览 |

**接口与文档**
- M0 核实笔记：`docs/protocol-notes.md`；DSH 端点目录：`fixtures/dsh/host-api-catalog.json`（本 SPEC 与它们冲突时以它们为准）
- Codex app-server：https://developers.openai.com/codex/app-server
- Codex app-server README：https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- Codex app-server 协议录制样本（社区）：https://docs.rs/crate/anyagent/latest/source/tests/fixtures/codex/README.md
- Codex 自定义 Provider 与 `wire_api`：https://openrouter.ai/blog/tutorials/codex-cli-openrouter/
- Claude Agent SDK 系统提示词：https://platform.claude.com/docs/en/agent-sdk/modifying-system-prompts
- Claude Agent SDK TypeScript 参考：https://platform.claude.com/docs/en/agent-sdk/typescript
- Claude Code headless（`--bare`）：https://code.claude.com/docs/en/headless
- Claude Code 环境变量：https://code.claude.com/docs/en/env-vars
- DeepSeek 接入 Codex：https://api-docs.deepseek.com/quick_start/agent_integrations/codex
- DeepSeek Anthropic 兼容 API：https://api-docs.deepseek.com/guides/anthropic_api
- DSH 仓库（MIT）：https://github.com/deepseek-ai/deepseek-harness
- DSH 界面框架尺寸规则：`packages/client/ui-layout/README.md`
- DSH 浏览器连接层：`packages/client/connection/README.md`
- DSH 文档基址与路由设计记录：`.agents/notes/implemented/architecture/2026-09-14-web-document-relative-app-routes.md`
- 社区参考：通过 DSH Web Host API 接入 IDE：https://github.com/moshang-ca/deepseek-harness-for-ides（描述的是 DSH 早期接口，已过时，以 host-api-catalog 为准）
