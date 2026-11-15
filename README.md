# WebDCC

WebDCC 是一个部署在个人服务器上的统一网页端，用同一套界面驱动三个彼此平级的原装 Agent：

- DeepSeek Harness（DSH）
- Codex
- Claude Code

WebDCC 负责启动或连接 Agent、逐字发送用户输入、保存并展示原生事件。它不追加系统提示词或工具声明，也不改写用户配置；原始交互和模型传输采用旁路记录，保留原生权限流程。完整边界和协议以 [SPEC.md](SPEC.md) 为准。

## 当前状态

当前 `main` 已包含：

- DSH 风格的三栏网页 UI，支持亮暗色、响应式布局和移动端抽屉
- 三个 Agent 的独立会话、流式输出、审批、提问、任务/计划/目标面板
- 会话 URL、右侧并排停靠、文件和 diff 查看、会话接续与原文交接
- Provider 导入、模型选择、附件、离线缓存、WebSocket 续传和发件箱
- DSH attach 模式：自动发现本机运行的 DSH 并复用同一个进程；自动发现失败时保留手动链接入口
- SQLite 事件存储、文件存储和 token → HttpOnly Cookie 认证
- Web 文本文件编辑、版本冲突保护、工作区图片预览和原始交互轨迹下载

M8 的完整 138 项双遍验收仍在继续，当前仓库中的验收报告会明确标出已通过、失败和未实现项目。

## 原生 Android 客户端

[Android 3.1.0 源码](android/README.md) · [APK Release](https://github.com/codezzzsleep/WebDCC/releases/tag/android-v3.1.0)

**安卓端有意滞后于网页版，按独立计划迭代。源码晚于网页端更新是正常且预期的，不要求同步最新网页功能。** Android 3.1.0 保留原交付版本，对接 WebDCC `97b3c07` 协议基线；网页端继续独立更新。

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

要求 Node.js 24+、pnpm **12.18.0**（由 `packageManager` 锁定）。原生依赖的构建策略在 `pnpm-workspace.yaml` 中声明。

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

原生协议库存可用 `pnpm native:inventory` 核对。浏览器安全验收单独运行：先执行 `pnpm exec playwright install --with-deps chromium`，再执行 `pnpm test:browser`。单元测试和构建通过不代表真实原生能力验收完成。

本轮修复合同和 48 项进度见 [实施 SPEC](web_review/WebDCC_NATIVE_PARITY_SPEC.md) 和 [修复进度](web_review/IMPLEMENTATION_PROGRESS.md)。该合同替代旧 SPEC 中与原生历史、PTY 和 DSH 原生入口冲突的范围条款。

使用域名或 HTTPS 代理时，设置 `WDCC_PUBLIC_ORIGINS=https://你的域名`，并用 `WDCC_TRUST_PROXY` 指定实际代理地址/CIDR；代理保留外部 Host 头。默认不信任 forwarded headers，非法 Host/Origin 被拒绝。HTTPS 响应使用 Secure Cookie。上传的 HTML/SVG 作为下载返回。

服务端产物包含 `build-manifest.json`，绑定提交、源码和原生 schema 指纹及数据库兼容范围。M8/M9 失败仍生成本轮报告，跳过 E2E 或原生场景未触发会阻止相应验收通过。

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

M9 轨迹与统一轮次验收：

```bash
pnpm trace:record --agent codex --scenario S01
pnpm trace:redact <trace-dir>
pnpm trace:scan
pnpm l1:update                 # 只有确认轨迹变化时才重写黄金文件
pnpm accept:m9                 # 含快速 e2e、L1 黄金比对和 L2 Playwright 回放
```

轨迹录制只由人显式运行；`TurnView`、`TraceSink` 和翻译器回放说明见 [docs/specs/SPEC-M9.md](docs/specs/SPEC-M9.md)。验收构建输出到临时目录，不覆盖仓库的 `dist`。

验收规则和当前进度见 [docs/specs/SPEC-M8.md](docs/specs/SPEC-M8.md)、[docs/progress.md](docs/progress.md) 和 [docs/acceptance/M8/README.md](docs/acceptance/M8/README.md)。

## 界面说明

当前 UI 设计决定记录在 [docs/ui-harness.md](docs/ui-harness.md)，包括 DSH 风格视觉、三个 Agent 的平级关系、会话接续、停靠区和窄屏行为。

## 安全

- 不要把 API Key、Cookie、访问 token 或服务器地址提交到仓库。
- Provider Key 只保存在服务端数据目录的权限受限 secrets 文件中，不返回原文。
- 测试和验收使用临时 HOME、配置目录、数据目录和动态端口。
