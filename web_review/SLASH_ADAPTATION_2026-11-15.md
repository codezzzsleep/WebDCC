# 斜杠命令适配与路由表 · 2026-11-15

当前代码在 `fix/native-parity-repair`，通过草稿 PR #39 供审查。主工作区和现有部署没有切换。

## 适配前必须具备的基础

1. 固定原生版本，保留真实命令、别名、参数和来源；不能用网页自定义目录替代原生命令。
2. 每条命令有明确路由：原生 API、SDK 输入、CLI 终端或网页入口。未知名称保留草稿并报错。
3. 参数正文、多行输入、合法附件与原生返回值完整传递；目录故障显示实际原因并可重读。
4. 控制命令先持久认领身份，防止重复提交；结果与表单能在刷新后恢复，uncertain 状态不盲目重发。
5. goal 的设置/暂停/恢复/清除遵守各 Harness 原生语义；可即时控制的操作不进入普通消息队列。

不需要等待全部 NP-01–NP-48 完成才能实施上述链路；完整的配置、附件、技能与原生接管需求继续由各自 Issue 验收。

## 当前覆盖

| Harness | 固定版本 | 目录条数 | 路由 |
| --- | --- | --- | --- |
| Codex | CLI 0.167.0 | 65 | 5 个 API、4 个网页入口、56 个原生终端入口 |
| Claude Code | CLI 2.1.322 / SDK 0.3.322 | 51 | 47 个 SDK 输入、4 个终端入口 |
| DSH | 0.2.2-rc.1 | 6 | 原生 commands/execute |

目录条数来自锁定版本和隔离 profile；Claude 项目/用户/插件目录、DSH Host 目录随实际配置刷新。Codex `/app` 在当前 Linux 不可用；目录中会标明。终端入口的路由覆盖不等于每条命令的业务效果都已验收。

## 实现行为

- Codex `/goal` 查看、设置、编辑、替换确认、暂停、恢复、清除走类型化 thread/goal API；`/compact`、`/rename`、`/status`、`/pwd` 有独立 API 路由。
- Codex `/model`、`/permissions`、`/skills`、`/plan` 提供明确的网页入口；带参数时转到原生终端，保留原命令。
- Claude `/model` 等 SDK 指令原样发送给原生 SDK，展示 local_command_output；终端专用指令转 CLI。
- DSH 命令使用 commands/list 的参数与附件声明并由 commands/execute 执行，完整保留结果；goal 的 pause/clear 等控制绕过普通队列。
- 终端跳转保留正文，用户选择原生会话后点“填入原生指令”，再在终端按 Enter 执行。
- `/api/sessions/:id/slash-commands` 返回目录状态、原因和 revision；POST 控制必须匹配当前目录，不能任意透传 RPC。
- 高频原生目标续跑时，所有事件即时投影，React 通知按浏览器绘制帧合并，确保暂停等指令仍可输入；修复前无延迟验证失败，修复后的同类验证通过。
- schema v14 增加 slash_results，保存脱敏的指令结果；原生交互的密钥回复仍只保存回执。浏览器保存结果身份指针，刷新读取已有结果，不重做原生操作。

## 验证范围与限制

实际锁定 Harness + Chromium + 隔离的回环模型：Codex/DSH 目标设置、暂停、恢复、清除、查看和刷新通过；Claude `/goal` 查看和刷新通过。设置目标会触发原生自主执行，模型回复来自免费 scripted mock，不构成真实付费 Provider 或自主任务完成验收。

定向回归覆盖并发幂等、目录错误与重读、完整多行输入、未知命令保留、Claude /model 路由、编辑表单刷新与新正文、v13→v14 迁移及磁盘结果恢复。最终源码门禁：573 项单元测试、29 项 Chromium 测试、类型/Lint/库存/build 全通过。原生浏览器 13 次命令操作在无延迟 scripted mock 下通过，指纹与源码门禁一致：`f1f289f8ead1c80b791ec2d47be87bf6cb532896d5c3f909662ab1be4b583e36`。

仍需独立验收：

- Codex goal 的图片/超长目标 materialization 尚未接入结构化控制，本路由明确拒绝附件并保留草稿。
- 原生终端的同会话接管仍受 writer 释放/原生身份/设置与历史核对约束；独立原生会话可以使用。
- Claude 终端的账号认证后命令效果、各项目/插件技能和 hooks 的完整管理、真实 Provider 场景仍未全部验收。
- NP-26、NP-32、NP-43、NP-44 的完整范围和现有 L1 差异继续开放，不按路由表条数宣称 48 项完成。

## 逐条指令路由

复现命令：`pnpm check:source`；`pnpm exec tsx scripts/probe-native-slash.ts --browser --sequence --fast --report <私有报告路径>`；目录导出检查见 `scripts/export-codex-slash-catalog.ts`。原始轨迹、截图和失败尝试留在私有证据目录。

同目录另附 UTF-8 CSV：`SLASH_COMMAND_ROUTES_2026-11-15.csv`。

| Harness | 指令 | 别名 | 路由 | 参数提示 | 当前平台可用 |
| --- | --- | --- | --- | --- | --- |
| codex | /model |  | 网页入口 | 原生参数 | 是 |
| codex | /presets |  | 原生 CLI 终端 |  | 是 |
| codex | /daybreak |  | 原生 CLI 终端 |  | 是 |
| codex | /ide |  | 原生 CLI 终端 | 原生参数 | 是 |
| codex | /permissions |  | 网页入口 | 原生参数 | 是 |
| codex | /keymap |  | 原生 CLI 终端 | 原生参数 | 是 |
| codex | /vim |  | 原生 CLI 终端 |  | 是 |
| codex | /setup-default-sandbox |  | 原生 CLI 终端 |  | 是 |
| codex | /experimental |  | 原生 CLI 终端 |  | 是 |
| codex | /approve |  | 原生 CLI 终端 |  | 是 |
| codex | /memories |  | 原生 CLI 终端 |  | 是 |
| codex | /skills |  | 网页入口 |  | 是 |
| codex | /import |  | 原生 CLI 终端 |  | 是 |
| codex | /hooks |  | 原生 CLI 终端 |  | 是 |
| codex | /review |  | 原生 CLI 终端 | 原生参数 | 是 |
| codex | /rename |  | 原生 API | 原生参数 | 是 |
| codex | /new |  | 原生 CLI 终端 | 原生参数 | 是 |
| codex | /archive |  | 原生 CLI 终端 |  | 是 |
| codex | /delete |  | 原生 CLI 终端 |  | 是 |
| codex | /resume |  | 原生 CLI 终端 | 原生参数 | 是 |
| codex | /fork |  | 原生 CLI 终端 | 原生参数 | 是 |
| codex | /worktree |  | 原生 CLI 终端 |  | 是 |
| codex | /app |  | 原生 CLI 终端 |  | 否 |
| codex | /init |  | 原生 CLI 终端 |  | 是 |
| codex | /compact |  | 原生 API |  | 是 |
| codex | /config |  | 原生 CLI 终端 |  | 是 |
| codex | /recap |  | 原生 CLI 终端 |  | 是 |
| codex | /plan |  | 网页入口 | 原生参数 | 是 |
| codex | /voice |  | 原生 CLI 终端 | 原生参数 | 是 |
| codex | /goal |  | 原生 API | 原生参数 | 是 |
| codex | /agents |  | 原生 CLI 终端 |  | 是 |
| codex | /side |  | 原生 CLI 终端 | 原生参数 | 是 |
| codex | /btw |  | 原生 CLI 终端 | 原生参数 | 是 |
| codex | /copy |  | 原生 CLI 终端 |  | 是 |
| codex | /export |  | 原生 CLI 终端 | 原生参数 | 是 |
| codex | /raw |  | 原生 CLI 终端 | 原生参数 | 是 |
| codex | /tui |  | 原生 CLI 终端 |  | 是 |
| codex | /diff |  | 原生 CLI 终端 |  | 是 |
| codex | /mention |  | 原生 CLI 终端 |  | 是 |
| codex | /status |  | 原生 API |  | 是 |
| codex | /daemon |  | 原生 CLI 终端 |  | 是 |
| codex | /warnings |  | 原生 CLI 终端 |  | 是 |
| codex | /cd |  | 原生 CLI 终端 | 原生参数 | 是 |
| codex | /pwd | /cwd | 原生 API | 原生参数 | 是 |
| codex | /usage |  | 原生 CLI 终端 | 原生参数 | 是 |
| codex | /debug-config |  | 原生 CLI 终端 |  | 是 |
| codex | /title |  | 原生 CLI 终端 | 原生参数 | 是 |
| codex | /statusline |  | 原生 CLI 终端 | 原生参数 | 是 |
| codex | /theme |  | 原生 CLI 终端 |  | 是 |
| codex | /pets | /pet | 原生 CLI 终端 | 原生参数 | 是 |
| codex | /mcp |  | 原生 CLI 终端 | 原生参数 | 是 |
| codex | /apps |  | 原生 CLI 终端 |  | 是 |
| codex | /plugins |  | 原生 CLI 终端 |  | 是 |
| codex | /logout |  | 原生 CLI 终端 |  | 是 |
| codex | /quit |  | 原生 CLI 终端 |  | 是 |
| codex | /exit |  | 原生 CLI 终端 |  | 是 |
| codex | /feedback |  | 原生 CLI 终端 |  | 是 |
| codex | /rollout |  | 原生 CLI 终端 |  | 是 |
| codex | /ps |  | 原生 CLI 终端 |  | 是 |
| codex | /stop | /clean | 原生 CLI 终端 |  | 是 |
| codex | /clear |  | 原生 CLI 终端 | 原生参数 | 是 |
| codex | /test-approval |  | 原生 CLI 终端 |  | 是 |
| codex | /subagents |  | 原生 CLI 终端 |  | 是 |
| codex | /debug-m-drop |  | 原生 CLI 终端 |  | 是 |
| codex | /debug-m-update |  | 原生 CLI 终端 |  | 是 |
| claude-code | /deep-research |  | 原生 SDK 输入 |  | 是 |
| claude-code | /design |  | 原生 SDK 输入 | consent \| revoke | 是 |
| claude-code | /design-sync |  | 原生 SDK 输入 | [<project hint, e.g. "Acme DS">] | 是 |
| claude-code | /dataviz |  | 原生 SDK 输入 |  | 是 |
| claude-code | /update-config |  | 原生 SDK 输入 |  | 是 |
| claude-code | /verify |  | 原生 SDK 输入 |  | 是 |
| claude-code | /debug |  | 原生 SDK 输入 | [issue description] | 是 |
| claude-code | /code-review | /review | 原生 SDK 输入 | [low\|medium\|high\|xhigh\|max] [--fix] [--comment] [<pr#>\|<branch>\|<path>] [--max-findings <n>\|all] | 是 |
| claude-code | /simplify |  | 原生 SDK 输入 | [<target>] | 是 |
| claude-code | /batch |  | 原生 SDK 输入 | <instruction> | 是 |
| claude-code | /fewer-permission-prompts |  | 原生 SDK 输入 |  | 是 |
| claude-code | /doctor | /checkup | 原生 CLI 终端 | [prompt-audit [<path>]] | 是 |
| claude-code | /loop | /proactive | 原生 SDK 输入 | [interval] [prompt] | 是 |
| claude-code | /claude-api |  | 原生 SDK 输入 |  | 是 |
| claude-code | /workflow-authoring |  | 原生 SDK 输入 |  | 是 |
| claude-code | /run |  | 原生 SDK 输入 |  | 是 |
| claude-code | /run-skill-generator |  | 原生 SDK 输入 |  | 是 |
| claude-code | /plugin-authoring |  | 原生 SDK 输入 |  | 是 |
| claude-code | /advisor |  | 原生 SDK 输入 | [fable\|opus\|sonnet\|off] | 是 |
| claude-code | /agents |  | 原生 SDK 输入 |  | 是 |
| claude-code | /auto-mode-setup |  | 原生 SDK 输入 | [--request-id <uuid>] (--wizard posture=… scope=… depth=… --propose \| --expect-sha256 <64-hex> --apply-file <path>) | 是 |
| claude-code | /autocompact |  | 原生 SDK 输入 | [auto\|<tokens>] | 是 |
| claude-code | /clear | /reset, /new | 原生 SDK 输入 | [name] | 是 |
| claude-code | /color |  | 原生 CLI 终端 | [red\|blue\|green\|yellow\|purple\|orange\|pink\|cyan\|default] | 是 |
| claude-code | /compact |  | 原生 SDK 输入 | <optional custom summarization instructions> | 是 |
| claude-code | /config | /settings | 原生 SDK 输入 | key=value | 是 |
| claude-code | /output-style |  | 原生 SDK 输入 | [style] | 是 |
| claude-code | /context |  | 原生 SDK 输入 |  | 是 |
| claude-code | /effort |  | 原生 SDK 输入 | <low\|medium\|high\|xhigh\|max\|auto\|ultracode [on\|off]> | 是 |
| claude-code | /fast |  | 原生 SDK 输入 | [on\|off] | 是 |
| claude-code | /focus |  | 原生 CLI 终端 | [on\|off] | 是 |
| claude-code | /heapdump |  | 原生 SDK 输入 |  | 是 |
| claude-code | /init |  | 原生 SDK 输入 |  | 是 |
| claude-code | /mcp |  | 原生 SDK 输入 | [reconnect\|enable\|disable [<server>\|all]] | 是 |
| claude-code | /import |  | 原生 SDK 输入 |  | 是 |
| claude-code | /model |  | 原生 SDK 输入 | <model> | 是 |
| claude-code | /__remote-workflow |  | 原生 SDK 输入 |  | 是 |
| claude-code | /workflow-launch-exec |  | 原生 SDK 输入 |  | 是 |
| claude-code | /reload-plugins |  | 原生 CLI 终端 | [--force] | 是 |
| claude-code | /reload-skills |  | 原生 SDK 输入 |  | 是 |
| claude-code | /rename | /name | 原生 SDK 输入 | [name] | 是 |
| claude-code | /security-review |  | 原生 SDK 输入 |  | 是 |
| claude-code | /usage | /cost, /stats | 原生 SDK 输入 |  | 是 |
| claude-code | /insights |  | 原生 SDK 输入 |  | 是 |
| claude-code | /recap |  | 原生 SDK 输入 |  | 是 |
| claude-code | /skill-doctor |  | 原生 SDK 输入 |  | 是 |
| claude-code | /goal |  | 原生 SDK 输入 |  | 是 |
| claude-code | /design-consent |  | 原生 SDK 输入 |  | 是 |
| claude-code | /design-revoke |  | 原生 SDK 输入 |  | 是 |
| claude-code | /list-agents | /peers | 原生 SDK 输入 |  | 是 |
| claude-code | /team-onboarding |  | 原生 SDK 输入 |  | 是 |
| dsh | /compact |  | 原生 API |  | 是 |
| dsh | /export |  | 原生 API |  | 是 |
| dsh | /feedback |  | 原生 API | <text> | 是 |
| dsh | /goal |  | 原生 API | [<objective>\|clear\|edit <objective>\|pause\|resume] | 是 |
| dsh | /permission |  | 原生 API | <preset> | 是 |
| dsh | /plan |  | 原生 API | [off\|message] | 是 |
