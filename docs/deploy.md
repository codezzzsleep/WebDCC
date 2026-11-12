# 部署与锁定版本

> M0 建立本文件，记录锁定版本与安装方式；M7 补齐 systemd 示例、服务端配置与上线步骤。

## 锁定版本

锁定含义：本仓库的 adapter、fixtures 与测试都以这些版本为准。**升级任何一个都要重新导出 Codex schema、重跑 fixtures 测试和第 15 节验收。**

| 组件 | 锁定版本 | 检测命令 | 备注 |
|---|---|---|---|
| Node.js | **v26.13.0** | `node -v` | SPEC 4.1 写 Node 24 LTS；DSH 要求 `^22.19 \|\| >=24`，26.13.0 满足。服务器上实际安装的就是这个版本，与之对齐 |
| pnpm | **12.18.0** | `pnpm -v` | `packageManager` 字段已锁定；`onlyBuiltDependencies: [esbuild]` |
| TypeScript | **5.9.3** | `npx tsc -v` | 未用 7.0.2：`typescript-eslint@8.72.2` 明确拒绝 TS 7（`typescript-eslint does not support TS 7.0`） |
| DeepSeek Harness（DSH） | **0.2.2-rc.1** | `dsh --version` | 与 SPEC 中【已实测】结论对应的版本 |
| Codex CLI | **0.167.0** | `codex --version` | `codex app-server` 的类型与 schema 从该版本导出 |
| Claude Code | **2.1.322** | `claude --version` | 我们只通过 Agent SDK 驱动，不直接调 `claude -p` |
| Claude Agent SDK | **0.3.322** | `node -p "require('@anthropic-ai/claude-agent-sdk/package.json').version"` | `@webdcc/adapter-claude` 的依赖 |
| Vitest | **3.2.7** | `npx vitest --version` | 不能用 5.x：它依赖 rolldown 原生二进制，本机 Xeon 6266C 无 AVX2，直接 `Illegal instruction (core dumped)` |
| Playwright | 1.65.0 | `npx playwright --version` | 浏览器二进制需 `npx playwright install chromium`（M2 起才会用到） |
| ESLint | 10.14.0 | `npx eslint --version` | flat config + typescript-eslint 8.72.2 + @eslint/js 10.0.1 |
| tsx | 4.23.15 | `npx tsx --version` | 跑探针与假模型 |
| ws | 8.22.2 | — | 探针里连 DSH 的 `/api/remote.mux` |

## 安装步骤（开发机）

```bash
# 1. Node 24+ （本机为 /opt/node-v26.13.0-linux-x64）
node -v

# 2. 包管理器
npm install -g pnpm@12.18.0

# 3. 三个 Agent（DSH 已随镜像安装）
npm install -g @openai/codex@0.167.0 @anthropic-ai/claude-code@2.1.322
dsh --version && codex --version && claude --version

# 4. 仓库依赖
pnpm install
```

> 若 `npm i -g` 的全局 bin 目录不在 `PATH` 上（本机全局前缀是 `/opt/node-v26.13.0-linux-x64`，`PATH` 只含 `/usr/local/bin`），把可执行文件软链到 `/usr/local/bin`：
> `ln -sf /opt/node/bin/{pnpm,codex,claude} /usr/local/bin/`

## 服务端发布形态（M7 定稿）

- 构建：`pnpm build`；启动：`node packages/server/dist/main.js`
- 配置项见 SPEC 12.2（端口、`WDCC_HOME`、`WDCC_DSH_PORT`、`WDCC_IDLE_DISPOSE_MIN` 等）
- HTTPS 可选；访问 token 换 HttpOnly Cookie，与 DSH 相同


## 本机按生产方式运行（M7 已验收）

```bash
pnpm install
pnpm build                     # 生成 packages/web/dist 与 packages/server/dist/main.js
WDCC_TOKEN=<至少 32 字节的随机串> \
WDCC_HOST=0.0.0.0 WDCC_PORT=8787 \
WDCC_DATA_DIR=~/.webdcc \
node packages/server/dist/main.js
# 启动后终端会打印：webdcc: http://<host>:8787/?token=<token>
```

- 首次打开用带 token 的链接，服务端换 HttpOnly Cookie 后跳到 `/`。
- **HTTPS**：Service Worker 只在安全上下文可用。纯 HTTP 时离线外壳自动不生效（其余同步能力不受影响）；需要离线能力就把服务放在 HTTPS 反向代理后面（代理必须支持 WebSocket upgrade），或在本机用 `--tls-cert/--tls-key` 由 DSH 侧车之外的代理终结 TLS。

## systemd unit 示例

```ini
[Unit]
Description=WebDCC
After=network.target

[Service]
Type=simple
User=webdcc
WorkingDirectory=/opt/webdcc/current
EnvironmentFile=/etc/webdcc.env
ExecStart=/usr/bin/node /opt/webdcc/current/packages/server/dist/main.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`/etc/webdcc.env`（权限 0600）：

```
WDCC_TOKEN=换成你自己的随机串
WDCC_HOST=0.0.0.0
WDCC_PORT=8787
WDCC_DATA_DIR=/home/webdcc/.webdcc
WDCC_DSH_PORT=3091
WDCC_IDLE_DISPOSE_MIN=30
```

正式发布使用 `pnpm release`。脚本要求工作区干净且当前 commit 已推送，
在临时检出中安装依赖并构建，写入 `/opt/webdcc/releases/<commit>`，切换
`/opt/webdcc/current` 后只重启 `webdcc.service`，失败会恢复上一个版本。

## 运行注意事项

- **不要同时运行 DSH 自带的 `dsh web`**：两边共享全局注册表会互相覆盖（SPEC 5.4.9）。WebDCC 自己会在 127.0.0.1:${WDCC_DSH_PORT} 拉起侧车。
- `codex`、`claude`、`dsh` 必须已按锁定版本安装在运行用户的 PATH 上，并完成各自的登录（或改用 Provider + API Key）。
- Provider 的 Key 存在 `WDCC_DATA_DIR/secrets.json`（0600），不会出现在日志、事件或 API 响应里。
- 备份 `WDCC_DATA_DIR`（SQLite + 文件 + secrets）即可完整恢复。
