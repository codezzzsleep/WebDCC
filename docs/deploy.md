# 部署与锁定版本

> M0 建立本文件，记录锁定版本与安装方式；M7 补齐 systemd 示例、服务端配置与上线步骤。

## 锁定版本

锁定含义：本仓库的 adapter、fixtures 与测试以这些基线为准；已审核的运行兼容版本单独记录在 `native-inventory.json` 的 `compatibleVersions` 中。**扩展兼容范围要比较原生 schema，并重跑相关原生交互与恢复验收；版本号不同不自动等于协议不兼容。**

| 组件 | 锁定版本 | 检测命令 | 备注 |
|---|---|---|---|
| Node.js | **v26.13.0** | `node -v` | SPEC 4.1 写 Node 24 LTS；DSH 要求 `^22.19 \|\| >=24`，26.13.0 满足。服务器上实际安装的就是这个版本，与之对齐 |
| pnpm | **12.18.0** | `pnpm -v` | `packageManager` 字段已锁定；`onlyBuiltDependencies: [esbuild]` |
| TypeScript | **5.9.3** | `npx tsc -v` | 未用 7.0.2：`typescript-eslint@8.72.2` 明确拒绝 TS 7（`typescript-eslint does not support TS 7.0`） |
| DeepSeek Harness（DSH） | **0.2.2-rc.1** | `dsh --version` | 与 SPEC 中【已实测】结论对应的版本 |
| Codex CLI | **0.167.0–0.169.0** | `codex --version` | 原始协议/fixtures 基线为 0.167.0；响应兼容 schema 从 0.169.0 原生导出；未知版本及预发布仍受限 |
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
npm install -g @openai/codex@0.169.0 @anthropic-ai/claude-code@2.1.322
dsh --version && codex --version && claude --version

# 4. 仓库依赖
pnpm install
```

> 若 `npm i -g` 的全局 bin 目录不在 `PATH` 上（本机全局前缀是 `/opt/node-v26.13.0-linux-x64`，`PATH` 只含 `/usr/local/bin`），把可执行文件软链到 `/usr/local/bin`：
> `ln -sf /opt/node/bin/{pnpm,codex,claude} /usr/local/bin/`

## 服务端发布形态（M7 定稿）

工作区文件读取使用 Linux 文件描述符核验路径，运行环境需提供可读取的 `/proc/self/fd`。raw 下载、图片资源和文本预览从核验后的同一描述符读取；无法提供该核验的平台返回 501，不退回可能受目录替换影响的路径读取。该限制也适用于保存前后的文本读取。文件内容仍可被原生工具原地修改，描述符核验不提供文件快照。其它平台的等价文件边界仍需实现和验收。

- 构建：`pnpm build`；启动：`node packages/server/dist/main.js`
- 配置项见 SPEC 12.2（端口、`WDCC_HOME`、`WDCC_DSH_PORT`、`WDCC_IDLE_DISPOSE_MIN` 等）
- HTTPS 可选；访问 token 换 HttpOnly Cookie，与 DSH 相同

工作区文本保存使用 Linux 的 `/proc/self/fd` 核验根目录、父目录和文件描述符；其他平台或缺少该挂载时返回 501，不退回字符串路径写入。原子替换后路径、内容或目录同步无法确认时返回 409，错误说明文件已经替换，操作记录保留实际写入 hash/bytes 和 `replaced: true`。核对原目录与当前文件后再重新加载，不自动重试或回滚。外部目录移动仍可能与文件系统操作并发，这些已发生的原目录写入需要保留为失败证据。

工作区目录浏览通过 Linux `/proc/self/fd` 读取已核验目录，返回列表前再次核对根和目录身份。目录变化返回 409；其他平台或无法核验描述符时返回 501，不退回未核验的字符串目录读取。内部目录链接、排序、筛选和相对路径仍按实际规范目录展示。

可续传上传需要 Linux 的 `/proc/self/fd` 核验数据根、上传暂存目录与分片。缺少核验能力时上传操作返回 501，启动保留待恢复上传并跳过不可安全执行的清理；其他文件功能仍可初始化。分片必须为预期长度的普通文件。目录或分片被链接/替换时返回 409，保留未完成上传，不能将外部文件字节计为成功上传。已写入原目录但未确认的分片会明确报错，应核对后续传。

附件 CAS 写入（包括同步 diff 存储和上传最终落盘）需要 Linux `/proc/self/fd` 核验数据根、对象目录和前缀目录。异步 buffer 入口保留异步字节写入；同步 diff 入口保留同步调用。直接写入拒绝链接，已校验的显式上传修复只原子替换链接本身，不写链接目标。路径、字节或目录同步在落盘后无法确认时返回 409，错误标明原目录已写入；不会登记成功文件或盲目重试。平台核验不可用时写入返回 501，完整其他平台和原生 diff 验收仍须单列。

附件 CAS 读取需要 Linux `/proc/self/fd` 核验数据根、files、前缀目录和同一已打开对象；下载与附件校验在读取前后确认路径，大小、hash 和图片格式仍按已存身份校验。路径变化返回 409，缺对象返回 404，描述符核验不可用返回 501。内部 `createReadStream` 现在为异步入口，校验后从已读取的字节提供流；当前源码没有依赖其同步返回值的调用。普通附件路径返回后到原生进程实际打开之间的完整交接竞态仍须独立验收，不能将本地路径核验当作跨进程稳定性证明。


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
- `WDCC_DATA_DIR` 备份只覆盖 WebDCC 持久状态；workspace、原生 home/历史/OAuth 和外部 DSH Host 需要另外保存。加密备份与隔离恢复步骤见 [备份与恢复](backup-and-restore.md)。
