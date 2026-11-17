# DSH 完整原回答恢复

关联 #325、#53 / NP-11、#52、#48（仅 DSH）、#42。两题同属一个原生 waterfall 时，第一题只是 collected；最后一题才发送完整 batch。最后一次网络结果未知后，普通 answer 仍被阻止，刷新不会自动重发。页面可核对本组原问题、选择和自定义文字，然后明确点击“重试本组原回答”。

完整非敏感 batch 在原生副作用前写入 SQLite，保留 nativeId、实际 Agent、callId、waterfall eventId、全部 itemId、原问题 schema、Host、原 Client、原命令及答案顺序。选择、空白和换行沿用实际 native reply 字节。敏感组、未完整收集或缺少原身份/命令正文指纹的记录不从当前表单推测恢复。

恢复查询只提供与当前前台投递一致的原件。新稳定 `answer.retryOf` 命令必须包含完整原 batch；整组状态、命令、revision 和当前投递参与 SQLite 比较。两个竞争者只允许一个进入原生调用。问题、Host、Agent、call、event、item、schema、选择或令牌变化在副作用前拒绝。拒绝后可重新核对；重试自身结果未知时仍保留各次命令和原件，等待另一次明确操作。

重试使用官方 `$events/result` 的同事件幂等边界。它只允许核实后的同事件回应通过既有 RPC 写入保护，普通输入的保护不清除。收到 void ACK 只表示已发送，`sentCommandId` 记录是哪次发送；服务重开把索引恢复为 uncertain 时，这个持久标记仍禁止再次发送。它不证明哪个 Client 的答案被原生接受。原生 `tool/result`/settled 结束本组，并保留 [native-resolved 与本地接收来源的区分](dsh-question-provenance.md)。原生取消、未知终态、旧连接结果和 ACK 先后顺序不会覆盖新的交互状态。

本恢复入口只处理非敏感前台回答。原生已 continued、queued、sent 或结束的批次不能借此重发；稍后回答保留现有官方 `userQuestions/answer` 的 active/queued/false/REPLY_QUEUED 语义和明确限制，不生成父会话 prompt，不复制未知前台输入为普通消息。

验证口径分别记录：

- 当前生产 HTTP、WebSocket、SQLite、命令账本和 Chromium，由受控 native producer/故障驱动。包括完整 batch、陈旧令牌、竞争、终态竞态、服务重开、发送保护、桌面与 390px 页面。这不证明当前真实 Host、网络或 Provider。
- 未改官方 Gateway 库的同事件 result/no-op/cancel 合同，复用 [已捕获且哈希一致的证据](../fixtures/dsh/approval-identity-contract.json)。固定 native 为 `0.2.2-rc.1` / `fcc0ad4`，CLI SHA256 `54d9e9fee0d005835a1967dba39246459a65133e13555239c5b6a2a229ab48e0`，Gateway 库 SHA256 `91abae7edfaa2bf3154680829e77b1f341aa01ba9094795aa70b96ff3e15f52b`。它是受控的未改原生库合同执行，不是 Host/Agent/Provider 验收。
- 兼容的真实问答轨迹有限回放保留原 call/event/答案和 nativeSeq；原整批失败、旧 Host 图差异及未捕获 global ready 都保留，不补造身份或重新提交原付费回答。回放不证明当前 Provider 或完整断线矩阵。

官方 Agent、版本、提示词、工具、权限及协议没有改动。#52 的 Host 重启、activeAttempt、工作区 baseline 和完整双界面恢复矩阵继续独立核验。实现、源码验收与部署分开；合并、Issue 关闭和目标平台部署由现有负责窗口处理。
