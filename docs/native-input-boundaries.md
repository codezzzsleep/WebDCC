# 原生输入边界

公开 `contentParts` v1 描述用户选择。能够通过 JSON schema 校验，并不证明某种引用会被原生端读取。文件名、MIME、哈希与字节大小经服务端验证；客户端不能指定 native path 或 receipt。

| Agent | 已编码的原生输入 | 当前明确拒绝或保持未知的输入 |
| --- | --- | --- |
| Codex 0.167.0 | 原文与 text elements、目录明确声明的图片/音频、当前原生 skills/list 重新确认的启用技能 | 独立文件和资源引用。目录没有声明某输入模态时拒绝该模态 |
| DSH 0.2.2-rc.1 | 原文、已声明图片能力模型的原始图片字节、原生 binary upload 与新 Session receipt | 音频、技能/资源引用、非空 text elements。不能把未知模型当作支持图片 |
| Claude CLI 2.1.322 / Agent SDK 0.3.322 | 原文、PDF 原始 base64 字节、逐字节可保留的 UTF-8 文档（包括 BOM） | 独立音频、技能/资源引用与 text elements。SDK ModelInfo 不声明输入模态，因此当前普通模型的图片能力保持未知并拒绝提交 |

## Codex 文件不是应用 mention

原生 `UserInput::Mention` 的 `path` 标识具体应用/插件等目标。不能把 WebDCC CAS 路径塞进这个字段来声称已实现文件附件。

- [精确版本 UserInput 定义](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/protocol/src/user_input.rs) 描述 `app://` / `plugin://` 目标，Skill 另有指向 SKILL.md 的 PathBuf。
- [原生消息转换](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/protocol/src/models.rs#L2231) 不直接把 Skill/Mention 转为普通模型内容块，工具内容由 core 后续处理。
- [原生 mention 分类](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/skills/src/mentions.rs#L43) 将普通 CAS/hash 路径归为 Other。

因此 Codex 独立文件输入会在原生提交前返回 `input-unsupported` / `nativeAdmission: not-submitted`。用户可以选择 DSH 的原生文件上传，或 Claude 支持的文档块。应用 mention 将来须使用其独立、可验证的选择合同。

## 网页准备与验证范围

真实 Composer 使用按会话与 revision 保存的草稿和上传 Blob。发送、排队和介入共享按钮/Enter guard；取得 IndexedDB 持久 command ID 后只清理未再编辑的草稿。上传可暂停、续传和取消，晚返回不能回填另一会话。新会话创建后显式授予所选附件访问权限，再提交正文和原生附件。

远程草稿有独立的 server revision。409 保留本机草稿，并提供“使用本机草稿”和“使用云端草稿”；两种选择都重新读取当前版本。原生文字元素在编辑后失去对应关系时，提交被阻止，用户可以显式按当前正文重新准备。

同步和冲突选择共享同数据库、同会话的操作队列。选择云端草稿时，本机 revision 与远程基线在一个 IndexedDB 事务里更新；其它页面更新过任一版本，或读到的服务器 revision 比当前基线更旧，事务会整体拒绝，不留下半份选择。只读查看云端不更新同步基线。服务器恢复到更旧数据版本属于独立的版本边界，不能通过静默降低本机基线来消除冲突。

同一浏览器的多个页面发生本地 revision 冲突时，也可以选择本页或已保存草稿，并以新读到的版本执行 CAS。已明确失败的发送可以“放回输入框”，恢复正文与完整附件引用并保留原失败记录；结果 uncertain 的输入须先核对原生执行，不能自动重发。运行轮次中的介入消息和离线 pending 会显示在原轮次内，独立命令身份不会被第一条用户消息掩盖。

`browser-tests/composer-input.spec.ts` 使用真实产品界面、IndexedDB、REST、SQLite 和 FileStore，覆盖断网/切换/刷新后的字节恢复、完整附件气泡、new-session 授权、handoff 和两种 CAS 冲突处理。测试接收 Agent 为 fixture；这些结果不代表完成了真实模型生成验收。

DSH 隔离原生上传证据验证两次真实 Host 启动后的存储字节、SHA-256 和新 receipt，不发送模型 prompt，不读取部署 profile。原生模型交互仍需主线的独立轨迹验收；不得用 schema 或 fixture 通过代替该证据。
