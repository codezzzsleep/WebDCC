# 结构化附件、队列恢复与草稿并发

浏览器提交公开的 `contentParts` v1；文件部分只引用 `fileId` 和可选元数据。命令格式拒绝客户端路径、原生 receipt、未知字段、正文与 text parts 不一致。服务端生成的原生路径来自当前 FileStore；不把附件改写成隐藏提示词，也不重排正文、图片和文件部分。

## 会话授权与实际内容

`POST /api/uploads` 接受可选 `sessionId`。现有会话的网页上传携带该字段；完成上传后给该会话建立持久 grant。命中现有 CAS 时先检查实际字节，仍需建立目标会话的 grant。新建会话之前的上传可以暂时没有作用域；创建会话后，用户选中的文件需要通过显式 `POST /api/sessions/:id/attachments {fileId}` 附加到目标会话。

`file_session_grants` 是会话输入授权来源。知道一个全局 `fileId` 不足以提交它，也不能直接把另一会话的附件放进草稿或送给 native。显式附加操作检查实际 CAS 后授予所选会话权限，不复制外部 workspace 或保存原生上传 receipt。

文件身份与内容缓存分开：相同 SHA-256 的字节只保存一次，`fileId` 保留对应选择的文件名和 MIME。相同图片先作为普通二进制文件上传，再作为 PNG 上传，会得到各自正确的元数据引用；后续上传不改变先前文件的 MIME。秒传仍直接返回可使用的 `existingFileId`，其值可能是新的元数据别名。存储配额与备份 CAS 对象按唯一 SHA 计算，备份数据库保留所有文件身份及授权。

接收新发送命令前，服务端验证 grant、文件元数据、当前 CAS 路径、普通目录/文件、SHA-256 和大小。读取拒绝符号链接根目录、符号链接前缀及符号链接对象。图片还检查格式签名与 MIME；这不是完整的图片解码器。失败不会创建该命令的队列输入或原生输入 UUID。

队列恢复和 steer 在实际 native admission 前再次执行校验。恢复库中的绝对路径只作为历史派生字段保留，不用于 native 路径选择。新目录下解析的路径交给 adapter；原正文、命令身份、输入顺序和原生身份关联保持不变。

## 发送、排队与介入

新客户端显式指定 `intent: "send" | "queue" | "steer"`。忙态或仍有已接受输入时，显式 `send` 返回 409，请用户明确选择排队或介入。旧客户端省略 intent 时保留原有运行中排队行为。`queue` 保留原输入结构，按持久 ordinal 依次处理；闲置时也会按正常轮次接收执行。

`steer` 必须携带 `expectedTurnId`，其值是当前 Web 轮次 ID。服务端确认它仍属于正在运行的会话，再映射成已绑定的 native turn ID 传给 adapter。每次介入保留独立的入账身份和原生输入 UUID，并在 `native_input_ids.target_turn_id` 固定绑定到服务端核实的 Web 轮次；不能信任浏览器字段来做后续历史归属。

原生 RPC 接收介入后状态为 `native-accepted`，响应包含 `confirmed: false`，并不宣称已捕获真实回声。只有带相同原生输入 UUID 且正文匹配入账数据的真实 user-message 回声才能确认该介入。历史导入沿用同一持久映射，介入身份不能绑定到之后的新 native turn-start。连接中断导致的 uncertain 输入仍需要核对，不能自动重发。

## 附件失效后的操作

已接受队列输入的附件若缺失、损坏或授权不符，输入保留在原 ordinal，`preparationError` 说明原因。服务端不会启动该输入的原生轮次，也不会让后面的输入越过它。

重新上传原始字节可以修复缺失或损坏的 CAS。服务端只有在新上传的完整内容匹配原 SHA-256 时才替换对象，保留原 `fileId`；分片和合并文件需要持久化，合并过程中再次核对内容，不能用不同内容改变已有引用。随后通过 `POST /api/sessions/:id/queue/:commandId/retry` 重新校验并恢复队列处理。这个操作只接受尚未提交 native 的 `queued` 输入；uncertain 或原生已接受的输入不能伪装成未执行重试。

## 远程草稿 CAS

`GET /api/sessions/:id/draft` 返回 `text`、`fileIds`、可选 `contentParts`、`updatedAt` 和数字 `revision`。不存在的草稿版本为 0。

`PUT` 必须携带已经读取的 `expectedRevision`。缺少版本返回 428；版本冲突返回 409，并保留另一端的新草稿。正文必须与结构化 text parts 完全一致，`fileIds` 与结构化附件清单顺序一致；附件需拥有当前会话 grant 且实际 CAS 校验通过。保存草稿不连接 native 或查询 Provider，也不会因为能力暂不可用而偷偷丢掉部分内容。

网页的本机草稿、未上传附件与远程版本由各自的草稿控制器维护。远程 API 只保存合法的文件引用，不能把尚未上传的浏览器 task ID 或原生 receipt 当作已持久附件。

## Schema 与隔离验证

Schema v12 的迁移包含 grant、上传会话作用域、草稿版本/结构和介入关联。旧数据库只从已持久化的用户消息、队列和草稿文件引用建立 grant；未引用的全局文件及内部工具记录不自动授权。迁移不删除 events、改写旧队列正文或改变 sessionId/URL。新字段与限定来源授权在事务中完成，故障回滚后仍保留旧版本；标记 v12 却缺失必需字段的库拒绝启动。

Schema v13 移除原来把全局 SHA 与名称/MIME 绑在一起的唯一约束。迁移在事务中保留全部旧文件 ID、记录和 session grants，只给后续上传增加独立元数据别名。未知文件表字段会使迁移拒绝执行，避免默默丢掉数据。

`packages/server/test/attachment-admission.spec.ts` 使用隔离的真实上传/REST API、SQLite 账本和捕获型 adapter，验证命令进入 adapter 时的实际输入，覆盖缺失/hash 错误/符号链接、跨会话 grant、图片 MIME、结构顺序、队列损坏与 API 修复、并发草稿 CAS、显式意图、steer 回声关联、迁移故障和复制数据目录后的路径更新。这证明服务端接入链路；三家真实原生协议及模型交互的验证由对应 adapter 的测试和独立原生轨迹提供。
