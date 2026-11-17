# Claude 原生块身份、工具结果与顺序

完整 assistant 消息包含 `text, Read, text` 时，WebDCC 按原生块位置显示三项。
工具结果较晚返回，也不会把工具卡移到后续文本之后。主回答与子任务中的相同
toolId 分别关联各自调用，子结果不会覆盖主卡，刷新后仍保持各自身份和内容。

## 锁定合同

SDK **0.3.322** / CLI **2.1.322** 未修改。

- `SDKAssistantMessage.message` 是 Anthropic `BetaMessage`。流式期间通常每个
  已完成块单独投递，多个投递共享 `message.id`，各有 wrapper `uuid`。
- `SDKPartialAssistantMessage.event.index` 属于该 native session、message
  和 `parent_tool_use_id`。工具和 opaque 块同样占用位置，不能只计 text/thinking。
- `SDKUserMessage` 的 `tool_result.tool_use_id` 对应已有调用；
  `parent_tool_use_id` 是 actor 身份，`session_id` 在 SDK 类型中允许缺省。
  缺省 session 只在该 actor 下存在唯一当前调用时接受。
- SDK 保证同一 assistant message 内不同工具调用的 toolUseID 不同。
  定向检查中的同 message 重复 ID 是故意构造的非法/歧义输入防护，
  不作为官方原生执行场景。不同 actor/session 的同 ID 测试同样属于受控信封验证。
- 工具完成、失败及原始 native 包络保留。未匹配或歧义结果成为 unknown，
  不结算其他卡；完整消息再次包含已交付工具时不重新打开该工具。

原生 SDK 模块、schema 和 CLI 二进制 SHA256 分别为：

```text
SDK    1c70356fe073f6c5423fb7138e2f2f6580a790eb055ad247e5d7927f57b53e8b
schema c228b60931a217ea96e222ef41f47a0a83bee0a394d1735e3eb668e3f8838b2f
CLI    bfb3703ad5380242328459bc62ada4bde8ae7ba57c6e1eeadb9c00e08874c478
```

## 恢复字段与兼容

内容事件的可选 `data.claudeBlock` 保留 `agent: claude-code`、当前 `queryId`、
`nativeSessionId`、`nativeMessageId`、`parentToolUseId` 和 `blockIndex`。
工具结果继承开始时的块身份。`claudeActor` 继续只表示子输出，主块元数据不会
把主回答变成子任务。工具新键包含 query generation 和 native actor/message/block；
原生 toolId 留在原始 assistant/tool_result 中参与关联，不假定它跨 actor 全局唯一。

任务纯视图与 Claude 主时间线复用 `orderClaudeBlocks`。它只对证明属于同一个
query/session/message/parent 的行位置排序，未知记录和其他 Agent 的位置保持。
文本、思考、工具的单块投递和完整投递使用同一生产归约路径，replay 也调用它。

已持久化的旧键和 raw 包络不重写。旧数据缺少 query/message/block 证据时保持
原到达顺序；不能仅从完成时间猜原块位置。公共版本化 raw 重建与完成快照使用
其原上下文/源码指纹决定兼容范围，replay 的 queryId 是明确的回放身份，
不是旧生产 owner 身份。本改动没有修改公共 manager、数据库、命令/owner 账本
或公共同步协议。已有任务/run 停止与 query 交接保护继续使用。

## 作者验证

匹配 Issue #51 的两次认领先于实现，原始失败均保留。

- 基线和更新后 main 上，新增八项原始回归失败、七项既有回归通过。
  后续包括位置、主/两个子 actor、缺省 session、错误/歧义、重复投递、
  task/run、结构化结果和已合并 query 交接的定向检查通过。
- 新源码浏览器用受控 SDK 信封驱动实际 adapter、HTTP、Manager、SQLite、
  WebSocket 和 Chromium。主子同 ID 的工具结果独立、主/子块顺序、刷新、新 socket
  重连、会话切换、重新打开和无重复 query 均通过。原首轮未绑定 query 的超时，
  以及绑定后真正暴露的子工具完成顺序失败单独保留。
- 原 **156** 帧真实 Claude 轨迹保持全部 **14** 项原内容/实际文件终态，
  仅新增块元数据，**3** 个工具卡键按新身份有意改变。原录制总状态仍为 FAILED。
- 已捕获官方 SDK/CLI 的 **17** 帧受控模型结构化输出和 **80** 帧任务/停止轨迹
  离线回放保留原值、四个任务和原生终态通知。没有重新执行 CLI、模型或付费任务。

精确代码、证据 hash、定向/类型/Lint 和相邻源码浏览器结果在
`web_review/claude-block-identity-20261117.summary.json`。
这些是作者源码检查与原件回放；独立验收、合并、当前 Provider/model 行为及
121 三 Agent 目标平台验收由既有窗口处理。未知 SDK 类型、Teams、逐类 dialog、
Claude CLI 及其他剩余 #51 行为仍按其独立范围继续核对。
