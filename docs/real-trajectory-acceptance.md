# 三个 Agent 的真实轨迹与部署验收

用户在 2026-11-15 明确要求：提供 GPT、Claude 模型是为了验证 Codex、Claude Code、DSH 的官方原生行为。模型调用可以使用，但费用必须可控；保存一次真实轨迹，后续优先复用适用的记录。每次部署都要在目标平台核对三家，不能由一家成功、接口连通或源码测试通过替代完整验收。

WebDCC 负责把用户动作交给官方 CLI、SDK、Host，并投影它们的结果。验收不能改写官方的系统提示、工具定义、工具实现或权限判断。配置模型端点和使用官方原生权限设置属于正常配置；录制仅观察同一请求、响应和原生信封。

## 一次真实采集

使用目标平台上的实际 release 目录，而不是本机开发服务。另建私有验证数据库、原生 profile 和工作区，避免对用户生产会话发送测试消息。固定并核对实际 release commit、源码指纹、运行中的 CLI/SDK/Host 版本和原生协议来源。

`scripts/accept-deployed-trajectories.mjs` 接收私有 JSON 配置、一个 Agent 和可选的 `--live`。没有 `--live` 时只能进行不调用模型的创建前探针。真实任务串行执行，创建持久 admission 文件和请求账本后才能向上游发送请求。请求状态未知时先核对已有结果，禁止盲目重送。官方的重试行为不被修改；验证代理自己的请求上限拒绝必须标为诊断限制，不能伪称上游限流。

配置示意（密钥只由 credentialFile 引用）：

```json
{
  "release": "/opt/webdcc/current",
  "expectedCommit": "<deployed commit>",
  "out": "<private evidence directory>",
  "playwrightModule": "<installed Playwright module>",
  "browserCache": "<existing target-platform browser cache>",
  "maxModelRequestsPerAgent": 6,
  "agents": {
    "codex": { "credentialFile": "<private key file>", "model": "gpt-6.1-sol", "upstream": "https://freegg.app", "protocol": "openai-responses" },
    "claude-code": { "credentialFile": "<private key file>", "model": "claude-sonnet-5", "upstream": "https://api.coee.ccwu.cc", "protocol": "anthropic-messages" },
    "dsh": { "credentialFile": "<private key file>", "model": "claude-sonnet-5", "upstream": "https://api.coee.ccwu.cc", "protocol": "anthropic-messages" }
  }
}
```

对于 DSH，Responses 的 API base 含 `/v1`，Anthropic 的 base 使用 origin，SDK 自己追加 `/v1/messages`。按实际原生请求核对路由，不猜测。完整响应头及响应字节原样转发，包括压缩编码；私有记录副本脱敏。保存 Base64 字节和原始分块边界，避免 UTF-8 字符跨块时损坏轨迹。

默认真实任务覆盖文本、流式、读取/写入、真实工具结果回传、工具失败、刷新、浏览器重连和服务恢复。设置 `scenario: "question-denial"` 可运行单个短任务，实际提交原生问题的回答，并从浏览器拒绝权限；被拒绝的保护文件必须保持原样。没触发审批或问答时记录 not-triggered，不能标为通过。

DSH 的普通回复和原生自动标题是独立请求，诊断预算须分别计数；预算拒绝不能记为上游故障或完整通过。退出时先关闭托管会话，再关闭原生侧车；验证清理只处理本进程的后代及精确匹配的私有 DSH_HOME，每次发信号前重新核对 PID 启动身份。同目录外部进程保持运行。

## 轨迹保存与安全

在公开仓库之外保存完整的原生协议信封、原生输入输出、模型请求/响应、用户 UI 动作、实际文件副作用、Web 投影和恢复结果。各类证据关联 request/turn/session/tool-call/owner 身份，记录源码、原生版本、配置与证据指纹。同时保存每个实际响应的 usage/credit_usage，不能把缓存 tokens 当作不存在，也不能擅自换算货币。

不要把凭据文件、secrets.json、完整环境文件或生产用户的数据库放进轨迹归档。授权头、Cookie、Token、已知配置值必须脱敏；独立扫描应解码 Base64，并按 content-encoding 解压后检查，不能只扫描 JSON 外壳。敏感扫描的范围和任何截断、写入失败都要记录。

完整录制不等于任务完成。特别是 HTTP200、max-tokens、未闭合的工具参数、未执行工具及仍在等待的交互要分别保留。原始 failed 报告不能被新报告覆写；修正验证器后另存复核结果，并记录新增模型请求数。

## 复用真实轨迹

`scripts/replay-deployed-trajectories.mjs` 在不调用模型的情况下，将官方原生帧送入当前生产 adapter 处理器，并比较文本、工具、文件、用量和错误投影。原生 tool/call/item 身份与顺序保留。仅对本地生成的 usage 计数 ID 允许映射，而且必须先验证数量、顺序和全部用量字段一致，并把映射及数据哈希写进报告。生成时长不是回放能证明的属性，明确排除。

`scripts/recover-deployed-trajectory.mjs` 使用已有实际原生会话，补验刷新、重连和服务重启恢复，不发送新用户轮次；保护原报告，并核对 nativeId 和模型请求数量。

缓存有效性的边界是实际原生版本、协议/schema、模型配置、工具定义和待测行为。升级原生二进制、改变模型路由或协议后，重新核对适用性；改变相关协议行为时补录必要的真实样本。回放不能证明现在的 Provider 可达性、认证有效性、额度、延迟或最新模型行为。将真实调用、捕获真实行为的回放、受控模型 fixture 分开报告。

## 部署检查与关闭条件

每次部署提供三家的逐项证据矩阵：原生触发、用户动作、原生结果、Web 结果、刷新/重连/恢复。核对部署后的实际 release、数据库、服务、认证边界、原生版本和平台 UI。源码实现、源码检查、特定场景验收、完整能力验收和部署分别记录。

依据完整原生能力清单检查剩余项。缺场景、旧版本、错误来源、未触发交互、失败和不完整录制应阻断其对应验收范围。一次工具成功不能代表审批拒绝、问答取消、多模态或全部 NP-48 已验收。#57、#90 等完整范围 Issue 保持开放，直到其全部接受标准满足。新缺陷先登记 GitHub，再实现修复。

已记录的真实限制包括 FreeGG Chat Completions/Anthropic HTTP410、Coarena HTTP429，以及 DSH Responses 在输出上限下的未闭合工具调用。DSH 原生 `reason.kind=max-tokens` 应在 Web 明示输出限制并标出任务未正常完成，不能仅因收到 turn/end 就显示任务成功（#118）。
