# 斜杠命令适配与验证 · 2026-11-15

本轮通过 [PR #39](https://github.com/codezzzsleep/WebDCC/pull/39) 交付，合并状态以 PR 为准。原始 48 项需求继续由 #42 和各子 Issue 验收。

## 基础与覆盖

先固定原生版本、命令来源与执行路由，再保留多行正文、参数和附件语义。控制操作先持久认领身份；刷新读取已有结果，未确认结果不盲目重发。无需等待全部 48 项完成即可接通这些链路。

| Harness | 固定版本 | 目录条数 | 路由 |
| --- | --- | --- | --- |
| Codex | CLI 0.167.0 | 65 | 5 个 API、4 个网页入口、56 个终端入口 |
| Claude Code | CLI 2.1.322 / SDK 0.3.322 | 127 | 47 个 SDK 输入、80 个终端入口 |
| DSH | 0.2.2-rc.1 | 6 | 原生 commands/execute |

合计 198 条。Claude 将实际 SDK supportedCommands 与固定 CLI 内嵌的 105 条原生声明按名称/别名去重，动态技能以实际 SDK 目录为准。补齐 `/login`、`/logout`、`/resume`、`/permissions`、`/rewind`、`/sandbox`、`/keybindings` 等入口。隐藏、账号、平台及配置条件仍由原生 CLI 判断；目录声明和路由覆盖不表示每条业务效果都已验收。Codex `/app` 在当前 Linux 不可用。

## 实现与验证

- Codex `/goal` 查看、设置、编辑、替换确认、暂停、恢复、清除经类型化 thread/goal API。图片与文件字节完整保留；超过 4000 字符时通过原生 fs API 保存目标文件，编辑还原全文。替换确认在刷新后保留附件引用；非法或变化的附件在原生写入前拒绝。`/compact`、`/rename`、`/status`、`/pwd` 保留独立路由。
- Claude SDK 指令原样发送，展示 local_command_output；终端专用指令转 CLI。DSH 保留 commands/list 的参数/附件合同与 commands/execute 结果，goal 暂停/清除等即时控制不进入普通队列。
- CLI 入口保留原文，用户填入后按 Enter。Codex 同会话接管核对原生内核写锁、旧进程退出、权限和完整历史；返回沿用原生设置并导入新消息。返回重试不新建进程，已锁线程拒绝外部 writer。
- 修复返回结构化会话重复投影已有回答：按轮次与 item 身份去重，完整来源仍保存在历史账本。补入确定性回归与原生浏览器去重断言。
- 高频目标通知按绘制帧通知 React；较旧快照不能覆盖确认的暂停。schema v14 的脱敏 slash_results 保留结果/表单，secret 回复只存回执。
- 保留 Codex Plan/default 原生模式边界、Claude 多题原文答案键/多选、DSH waterfall/晚答及停止/刷新语义，不静默打开默认提问功能开关。

源码检查全部通过：578 单元、30 Chromium、类型、Lint、原生协议库存、构建。实际固定 Harness + 生产 adapter + Chromium 验证三家 goal 和刷新；Codex 验证 4005 字符目标、图片/文件原字节、全文编辑刷新、同会话 `/theme`、CLI 消息导入、回答去重、返回重试及外部 writer 拒绝。Claude 在隔离 API-key 模式验证模型轮次、`/permissions`、`/color`、`/doctor` 原生展开、插件重载及刷新保留 PID。七个原生问答/停止/刷新场景通过。

源码指纹：`528db650b7f5bb225a2f58f2465eeae6d870af809f926e279dc9f98152400698`。检查执行于提交前工作树，执行基线为 `e299773679ef43edf98c85efab7efe3fedfca17b`；提交后核对指纹。模型均为本机免费 scripted mock，此证据不构成真实付费 Provider 或自主目标任务完成验收。

L1 复核仍为 1/33 场景通过、32 GOLDEN 差异、16 NOT_TRIGGERED，无 I1–I8 失败，黄金文件未修改。该基线和其余 NP 能力保持独立追踪。Claude 同会话仲裁、所有终端指令业务效果、完整 secret/MCP/服务重启和真实 Provider 验收尚未完成。现有部署未更新。

复现：`pnpm check:source`；`pnpm exec tsx scripts/probe-native-slash.ts --browser --sequence --fast --attachments --takeover --report <私有路径>`；`pnpm exec tsx scripts/verify-claude-terminal.ts --report <私有路径>`；`pnpm exec tsx scripts/verify-native-questions.ts --report <私有路径>`。目录复核脚本为 `scripts/export-codex-slash-catalog.ts` 和 `scripts/export-claude-slash-catalog.ts`。公开摘要见 `slash-adaptation-2026-11-15.summary.json`，CSV 见 `SLASH_COMMAND_ROUTES_2026-11-15.csv`；完整轨迹、截图和失败尝试留在私有证据目录。

## 逐条路由

| Harness | 指令 | 别名 | 路由 | 参数提示 | 可用性 |
| --- | --- | --- | --- | --- | --- |
| codex | /model |  | 网页入口 | 原生参数 | 已发现 |
| codex | /presets |  | 原生 CLI 终端 |  | 已发现 |
| codex | /daybreak |  | 原生 CLI 终端 |  | 已发现 |
| codex | /ide |  | 原生 CLI 终端 | 原生参数 | 已发现 |
| codex | /permissions |  | 网页入口 | 原生参数 | 已发现 |
| codex | /keymap |  | 原生 CLI 终端 | 原生参数 | 已发现 |
| codex | /vim |  | 原生 CLI 终端 |  | 已发现 |
| codex | /setup-default-sandbox |  | 原生 CLI 终端 |  | 已发现 |
| codex | /experimental |  | 原生 CLI 终端 |  | 已发现 |
| codex | /approve |  | 原生 CLI 终端 |  | 已发现 |
| codex | /memories |  | 原生 CLI 终端 |  | 已发现 |
| codex | /skills |  | 网页入口 |  | 已发现 |
| codex | /import |  | 原生 CLI 终端 |  | 已发现 |
| codex | /hooks |  | 原生 CLI 终端 |  | 已发现 |
| codex | /review |  | 原生 CLI 终端 | 原生参数 | 已发现 |
| codex | /rename |  | 原生 API | 原生参数 | 已发现 |
| codex | /new |  | 原生 CLI 终端 | 原生参数 | 已发现 |
| codex | /archive |  | 原生 CLI 终端 |  | 已发现 |
| codex | /delete |  | 原生 CLI 终端 |  | 已发现 |
| codex | /resume |  | 原生 CLI 终端 | 原生参数 | 已发现 |
| codex | /fork |  | 原生 CLI 终端 | 原生参数 | 已发现 |
| codex | /worktree |  | 原生 CLI 终端 |  | 已发现 |
| codex | /app |  | 原生 CLI 终端 |  | 否 |
| codex | /init |  | 原生 CLI 终端 |  | 已发现 |
| codex | /compact |  | 原生 API |  | 已发现 |
| codex | /config |  | 原生 CLI 终端 |  | 已发现 |
| codex | /recap |  | 原生 CLI 终端 |  | 已发现 |
| codex | /plan |  | 网页入口 | 原生参数 | 已发现 |
| codex | /voice |  | 原生 CLI 终端 | 原生参数 | 已发现 |
| codex | /goal |  | 原生 API | 原生参数 | 已发现 |
| codex | /agents |  | 原生 CLI 终端 |  | 已发现 |
| codex | /side |  | 原生 CLI 终端 | 原生参数 | 已发现 |
| codex | /btw |  | 原生 CLI 终端 | 原生参数 | 已发现 |
| codex | /copy |  | 原生 CLI 终端 |  | 已发现 |
| codex | /export |  | 原生 CLI 终端 | 原生参数 | 已发现 |
| codex | /raw |  | 原生 CLI 终端 | 原生参数 | 已发现 |
| codex | /tui |  | 原生 CLI 终端 |  | 已发现 |
| codex | /diff |  | 原生 CLI 终端 |  | 已发现 |
| codex | /mention |  | 原生 CLI 终端 |  | 已发现 |
| codex | /status |  | 原生 API |  | 已发现 |
| codex | /daemon |  | 原生 CLI 终端 |  | 已发现 |
| codex | /warnings |  | 原生 CLI 终端 |  | 已发现 |
| codex | /cd |  | 原生 CLI 终端 | 原生参数 | 已发现 |
| codex | /pwd | /cwd | 原生 API | 原生参数 | 已发现 |
| codex | /usage |  | 原生 CLI 终端 | 原生参数 | 已发现 |
| codex | /debug-config |  | 原生 CLI 终端 |  | 已发现 |
| codex | /title |  | 原生 CLI 终端 | 原生参数 | 已发现 |
| codex | /statusline |  | 原生 CLI 终端 | 原生参数 | 已发现 |
| codex | /theme |  | 原生 CLI 终端 |  | 已发现 |
| codex | /pets | /pet | 原生 CLI 终端 | 原生参数 | 已发现 |
| codex | /mcp |  | 原生 CLI 终端 | 原生参数 | 已发现 |
| codex | /apps |  | 原生 CLI 终端 |  | 已发现 |
| codex | /plugins |  | 原生 CLI 终端 |  | 已发现 |
| codex | /logout |  | 原生 CLI 终端 |  | 已发现 |
| codex | /quit |  | 原生 CLI 终端 |  | 已发现 |
| codex | /exit |  | 原生 CLI 终端 |  | 已发现 |
| codex | /feedback |  | 原生 CLI 终端 |  | 已发现 |
| codex | /rollout |  | 原生 CLI 终端 |  | 已发现 |
| codex | /ps |  | 原生 CLI 终端 |  | 已发现 |
| codex | /stop | /clean | 原生 CLI 终端 |  | 已发现 |
| codex | /clear |  | 原生 CLI 终端 | 原生参数 | 已发现 |
| codex | /test-approval |  | 原生 CLI 终端 |  | 已发现 |
| codex | /subagents |  | 原生 CLI 终端 |  | 已发现 |
| codex | /debug-m-drop |  | 原生 CLI 终端 |  | 已发现 |
| codex | /debug-m-update |  | 原生 CLI 终端 |  | 已发现 |
| claude-code | /deep-research |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /design |  | 原生 SDK 输入 | consent \| revoke | 已发现 |
| claude-code | /design-sync |  | 原生 SDK 输入 | [<project hint, e.g. "Acme DS">] | 已发现 |
| claude-code | /dataviz |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /update-config |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /verify |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /debug |  | 原生 SDK 输入 | [issue description] | 已发现 |
| claude-code | /code-review | /review | 原生 SDK 输入 | [low\|medium\|high\|xhigh\|max] [--fix] [--comment] [<pr#>\|<branch>\|<path>] [--max-findings <n>\|all] | 已发现 |
| claude-code | /simplify |  | 原生 SDK 输入 | [<target>] | 已发现 |
| claude-code | /batch |  | 原生 SDK 输入 | <instruction> | 已发现 |
| claude-code | /fewer-permission-prompts |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /doctor | /checkup | 原生 CLI 终端 | [prompt-audit [<path>]] | 原生条件判定 |
| claude-code | /loop | /proactive | 原生 SDK 输入 | [interval] [prompt] | 已发现 |
| claude-code | /claude-api |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /workflow-authoring |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /run |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /run-skill-generator |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /plugin-authoring |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /advisor |  | 原生 SDK 输入 | [fable\|opus\|sonnet\|off] | 已发现 |
| claude-code | /agents |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /auto-mode-setup |  | 原生 SDK 输入 | [--request-id <uuid>] (--wizard posture=… scope=… depth=… --propose \| --expect-sha256 <64-hex> --apply-file <path>) | 已发现 |
| claude-code | /autocompact |  | 原生 SDK 输入 | [auto\|<tokens>] | 已发现 |
| claude-code | /clear | /reset, /new | 原生 SDK 输入 | [name] | 已发现 |
| claude-code | /color |  | 原生 CLI 终端 | [red\|blue\|green\|yellow\|purple\|orange\|pink\|cyan\|default] | 原生条件判定 |
| claude-code | /compact |  | 原生 SDK 输入 | <optional custom summarization instructions> | 已发现 |
| claude-code | /config | /settings | 原生 SDK 输入 | key=value | 已发现 |
| claude-code | /output-style |  | 原生 SDK 输入 | [style] | 已发现 |
| claude-code | /context |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /effort |  | 原生 SDK 输入 | <low\|medium\|high\|xhigh\|max\|auto\|ultracode [on\|off]> | 已发现 |
| claude-code | /fast |  | 原生 SDK 输入 | [on\|off] | 已发现 |
| claude-code | /focus |  | 原生 CLI 终端 | [on\|off] | 原生条件判定 |
| claude-code | /heapdump |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /init |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /mcp |  | 原生 SDK 输入 | [reconnect\|enable\|disable [<server>\|all]] | 已发现 |
| claude-code | /import |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /model |  | 原生 SDK 输入 | <model> | 已发现 |
| claude-code | /__remote-workflow |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /workflow-launch-exec |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /reload-plugins |  | 原生 CLI 终端 | [--force] | 原生条件判定 |
| claude-code | /reload-skills |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /rename | /name | 原生 SDK 输入 | [name] | 已发现 |
| claude-code | /security-review |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /usage | /cost, /stats | 原生 SDK 输入 |  | 已发现 |
| claude-code | /insights |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /recap |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /skill-doctor |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /goal |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /design-consent |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /design-revoke |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /list-agents | /peers | 原生 SDK 输入 |  | 已发现 |
| claude-code | /team-onboarding |  | 原生 SDK 输入 |  | 已发现 |
| claude-code | /web-setup |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /add-dir |  | 原生 CLI 终端 | <path> | 原生条件判定 |
| claude-code | /cloud-plugins |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /artifacts |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /autofix-pr |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /btw |  | 原生 CLI 终端 | [question] | 原生条件判定 |
| claude-code | /project |  | 原生 CLI 终端 | [Project ID or claude.ai address] [--save] \| clear [--save] | 原生条件判定 |
| claude-code | /feedback |  | 原生 CLI 终端 | [report] | 原生条件判定 |
| claude-code | /bug | /share | 原生 CLI 终端 | [report] | 原生条件判定 |
| claude-code | /cd |  | 原生 CLI 终端 | <path> | 原生条件判定 |
| claude-code | /copy |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /desktop | /app | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /diff |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /memory |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /pause-memory | /memory-pause, /toggle-memory | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /help |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /ide |  | 原生 CLI 终端 | [open] | 原生条件判定 |
| claude-code | /keybindings |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /design-login |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /login |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /logout |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /install-github-app |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /install-slack-app |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /mobile | /ios, /android | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /voice |  | 原生 CLI 终端 | [hold\|tap\|off] | 原生条件判定 |
| claude-code | /powerup |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /release-notes |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /resume | /continue | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /setup-bedrock |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /setup-vertex |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /ultrareview |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /session | /remote | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /scroll-speed |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /skills |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /status |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /tasks | /bashes | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /teleport | /tp | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /terminal-setup |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /ultraplan |  | 原生 CLI 终端 | <prompt> | 原生条件判定 |
| claude-code | /theme |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /tui |  | 原生 CLI 终端 | [default\|fullscreen] | 原生条件判定 |
| claude-code | /permissions | /allowed-tools | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /plan |  | 原生 CLI 终端 | [open\|<description>] | 原生条件判定 |
| claude-code | /passes |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /privacy-settings |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /hooks |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /loops |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /branch |  | 原生 CLI 终端 | [name] | 原生条件判定 |
| claude-code | /fork |  | 原生 CLI 终端 | <directive> | 原生条件判定 |
| claude-code | /subtask |  | 原生 CLI 终端 | <task> | 原生条件判定 |
| claude-code | /plugin | /plugins, /marketplace | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /rewind | /checkpoint, /undo | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /version |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /sandbox |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /chrome |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /stickers |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /radio |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /exit | /quit | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /restart | /update | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /export |  | 原生 CLI 终端 | [filename] | 原生条件判定 |
| claude-code | /remote-env |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /use-case |  | 原生 CLI 终端 | [use case] | 原生条件判定 |
| claude-code | /upgrade |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /usage-credits |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /extra-usage |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /pro-trial-expired |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /rate-limit-options |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /statusline |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /wellbeing | /breaks, /break-reminder, /downtime | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /background | /bg | 原生 CLI 终端 | [prompt] | 原生条件判定 |
| claude-code | /stop |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /workflows |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /brief |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /remote-control | /rc | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /daemon |  | 原生 CLI 终端 |  | 原生条件判定 |
| claude-code | /install |  | 原生 CLI 终端 | [options] | 原生条件判定 |
| dsh | /compact |  | 原生 API |  | 已发现 |
| dsh | /export |  | 原生 API |  | 已发现 |
| dsh | /feedback |  | 原生 API | <text> | 已发现 |
| dsh | /goal |  | 原生 API | [<objective>\|clear\|edit <objective>\|pause\|resume] | 已发现 |
| dsh | /permission |  | 原生 API | <preset> | 已发现 |
| dsh | /plan |  | 原生 API | [off\|message] | 已发现 |
