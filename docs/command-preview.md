# 创建会话前的指令预览

在 projects 新建页选择 Harness 后，输入 `/` 可查看、搜索和选择该 Harness 的指令。打开菜单或选择条目不创建 WebDCC 会话，也不发送模型消息。发送时才建立会话，并重新读取实际会话的指令目录；权限、工具和原生执行方式由所选 Harness 保留。

| Harness | 创建前目录来源 | 范围 |
| --- | --- | --- |
| Codex | 已核验版本的原生 CLI 指令目录 | 与会话中的同一份目录一致；网页模型、权限、计划入口沿用现有行为。 |
| DeepSeek Harness | 在兼容的 DSH Web Host 上核验的默认 `commands/list` 描述 | 预览 `/compact`、`/export`、`/feedback`、`/goal`、`/permission`、`/plan`。菜单注明基线预览；项目或会话新增指令以创建后实际目录为准。 |
| Claude Code | Claude Agent SDK 的空输入 `supportedCommands()` 查询 | 加载当前用户与所选项目的指令，包含项目技能和插件指令；查询禁止工具、关闭 hooks、关闭会话持久化，结束后关闭 SDK 查询。实际会话仍使用正常原生配置。 |

DSH 的 `commands/list` 要求实际 `agentId`，因此创建前不能读取完整的动态会话目录。基线预览只在已匹配的 Host 版本上可用。Claude 的目录查询也会检查 SDK 与 CLI 版本；未知或不兼容版本显示读取失败及重试入口。

两种预览都声明可能不完整：预览中缺失的指令可以在显式发送后交给实际会话目录核对。失败时保留输入草稿。Claude `/model` 保持原生 SDK 路由。

回归覆盖创建前读取、选择、发送、实际目录核对和刷新恢复。另有隔离的实际 DSH Web Host、Claude SDK 与 Chromium 验证，模型端使用本地受控流式接口；该验证不代表外部 Provider 或真实模型服务可用。

完整源码检查使用当前检出中的组件、备份 CLI 和 Git 提交记录。原生终端浏览器测试可通过 `WDCC_CODEX_BASELINE_BINARY` 指定隔离安装的 Codex 0.167.0；默认使用当前检出的 `.artifacts/native-baseline/package/vendor/x86_64-unknown-linux-musl/bin/codex`。

全新 Linux x64 检出在 `pnpm install --frozen-lockfile` 后运行 `pnpm setup:native-baseline`，再运行单独的浏览器测试。`pnpm check:source` 会先执行该准备步骤并分别记录结果。它下载固定官方发行包，校验归档完整性、所有文件和链接及执行权限的指纹、原始二进制和实际版本；缓存复用也校验，现有损坏资源保留并拒绝作为基线，不改测试断言或全局 CLI。

离线环境可用 `pnpm setup:native-baseline --archive /path/to/openai-codex-0.167.0-linux-x64.tgz`；显式 `WDCC_CODEX_BASELINE_BINARY` 或 `--binary` 必须指向该完整原始发行包中的二进制，也经过相同校验。准备步骤只执行 `--version`，不发送模型输入。实际原生终端、模型和发布验收仍分别记账；其它平台的固定测试发行包尚未提供。
