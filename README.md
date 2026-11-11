# WebDCC

WebDCC 是一个部署在个人服务器上的统一网页端，用同一套界面驱动三个彼此平级的原装 Agent：

- DeepSeek Harness（DSH）
- Codex
- Claude Code

WebDCC 负责启动或连接 Agent、逐字发送用户输入、保存并展示原生事件。它不追加系统提示词，不注入 MCP、工具、hooks 或 skills，也不改写用户配置。完整边界和协议以 [SPEC.md](SPEC.md) 为准。

## 当前状态

当前 `main` 已包含：

- DSH 风格的三栏网页 UI，支持亮暗色、响应式布局和移动端抽屉
- 三个 Agent 的独立会话、流式输出、审批、提问、任务/计划/目标面板
- 会话 URL、右侧并排停靠、文件和 diff 查看、会话接续与原文交接
- Provider 导入、模型选择、附件、离线缓存、WebSocket 续传和发件箱
- DSH attach 模式：自动发现本机运行的 DSH 并复用同一个进程；自动发现失败时保留手动链接入口
- SQLite 事件存储、文件存储和 token → HttpOnly Cookie 认证

M8 的完整 138 项双遍验收仍在继续，当前仓库中的验收报告会明确标出已通过、失败和未实现项目。

## 架构

```text
浏览器 React/Vite/PWA
  ├─ IndexedDB 本地缓存
  └─ WebSocket 同步 / 离线发件箱
        ↓
Node.js + TypeScript 服务端
  ├─ Fastify HTTP/WebSocket
  ├─ SQLite 事件日志
  ├─ File Store
  └─ Agent adapters
       ├─ Codex app-server JSON-RPC
       ├─ Claude Agent SDK
       └─ DSH Web Host API / remote.mux
```

代码按 workspace 拆分：

| 目录 | 内容 |
|---|---|
| `packages/protocol` | 前后端共享事件、命令和 API 类型 |
| `packages/server` | Fastify 服务端、会话管理、SQLite、认证、同步 |
| `packages/adapters/codex` | Codex app-server adapter |
| `packages/adapters/claude` | Claude Agent SDK adapter |
| `packages/adapters/dsh` | DSH Host API adapter |
| `packages/web` | React/Vite 前端 |
| `packages/testing` | FakeAdapter 和假模型服务 |

## 本地开发

要求 Node.js 24+、pnpm 12+。

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

分别启动服务端和前端：

```bash
pnpm dev:server
pnpm dev:web
```

默认服务端端口由 `WDCC_PORT` 决定，默认是 `8787`。启动后使用终端打印的带 token 地址访问。

## 生产部署

生产构建：

```bash
pnpm build
WDCC_HOST=0.0.0.0 WDCC_PORT=80 pnpm start
```

systemd 示例和环境变量说明见 [docs/deploy.md](docs/deploy.md)。生产 attach 模式下，WebDCC 不启动或停止用户的 DSH；它会自动连接已经运行的 DSH 进程。

## 测试

快速测试：

```bash
pnpm test
pnpm e2e
```

M8 真实 Agent 验收：

```bash
pnpm accept:m8
```

验收规则和当前进度见 [docs/specs/SPEC-M8.md](docs/specs/SPEC-M8.md)、[docs/progress.md](docs/progress.md) 和 [docs/acceptance/M8/README.md](docs/acceptance/M8/README.md)。

## 界面说明

当前 UI 设计决定记录在 [docs/ui-harness.md](docs/ui-harness.md)，包括 DSH 风格视觉、三个 Agent 的平级关系、会话接续、停靠区和窄屏行为。

## 安全

- 不要把 API Key、Cookie、访问 token 或服务器地址提交到仓库。
- Provider Key 只保存在服务端数据目录的权限受限 secrets 文件中，不返回原文。
- 测试和验收使用临时 HOME、配置目录、数据目录和动态端口。
