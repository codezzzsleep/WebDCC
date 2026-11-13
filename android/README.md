# WebDCC Android 3.1

> **版本策略：安卓端有意滞后于网页版，按独立计划迭代。源码晚于网页端更新是正常且预期的，不要求同步最新网页功能。**
>
> 此目录归档原始 Android 3.1.0 源码，协议基线为 WebDCC `97b3c073c5ec67d50df58cf564d33537c109eddc`。功能代码保持交付版本；现有 APK 原样发布到 [Android 3.1.0 Release](https://github.com/codezzzsleep/WebDCC/releases/tag/android-v3.1.0)。
>
> 公开仓库不包含交付包中的开发签名私钥或本机构建日志。下文关于附带开发签名的说明适用于原始交付包；从公开源码构建签名包时应自行配置签名材料。

独立的原生 Android 客户端。Kotlin、Jetpack Compose、Material 3，直接连接 WebDCC 的 HTTP / WebSocket 接口。

## 3.1 新增

- 外观支持跟随系统、亮色、暗色，默认跟随系统。可从“连接与设置 → 外观”切换；尚未连接时也可点登录页右上角的外观按钮。选择保存在手机上，重新绑定服务器后仍然保留。
- 对话、输入框、模型及审批面板、代码块、差异审阅、弹窗和系统栏均采用对应的亮暗色。
- 输入框旁显示“思考”及当前等级。模型面板、新任务配置、会话菜单也可打开思考强度选择。
- 优先读取当前模型声明的等级；未声明时，Codex、Claude Code 使用该版本 WebDCC 的标准选项。DSH 从其模型配置中读取可用等级，不虚构固定档位。
- 新任务通过 `reasoningEffort` 传入等级；已有任务通过 `set-reasoning-effort` 更新后续回复。每个 Agent 记住最近成功选择的强度。切换模型时保留兼容等级，否则选用新模型的有效默认等级。

## 安装与连接

1. 在电脑上运行 [WebDCC](https://github.com/codezzzsleep/WebDCC)。
2. 安装 APK，粘贴终端里打印的完整 HTTP / HTTPS 启动链接，必须包含完整的 `?token=...`。也可以通过安卓的“分享”菜单把文本发给 WebDCC。
3. 手机可访问的地址会自动开始绑定。如果链接包含 `localhost` / `127.0.0.1`，界面会让你填写电脑的局域网 IP 或可访问域名，保留原 token 完成登录。
4. 选项目，点“新任务”，输入需求并发送。

绑定只交换登录 Cookie；原始 token 不持久化。登录 Cookie 使用 Android Keystore 加密保存。应用不备份登录信息或对话缓存。更换服务器时，每台服务器的缓存按地址隔离。

DSH 侧车链接与 WebDCC 登录链接用途不同。先连接 WebDCC，再从“连接与设置 → 连接 DSH”填写侧车的完整启动链接；侧车连接由电脑执行，所以这里可使用电脑的 localhost 地址。

## 手机操作流程

- 项目列表进入已有任务，或从输入框发起新任务。Agent、模型、权限通过底部面板选择。
- 默认使用项目编辑权限，额外操作需要 Agent 发起审批。Codex 的 `workspace` 与 `:workspace` 两种标识均支持；不会默认选只读。
- 对话执行中可以补充消息。后续消息明确显示为排队，当前轮结束后执行；停止当前轮是独立操作。
- 待审批或待回答的问题显示在输入框上方。打开后选择选项或填写文字，收到服务端确认后才消除请求。
- 回复使用原生 Markdown、代码块、复制操作；执行过程收进“执行详情”。最终回复遵循 WebDCC 的 `answerItemKeys` 和原生阶段标记。
- 文件改动可打开原生 diff；点击代码行，写审阅意见，放入输入框确认后继续发送。
- 电脑项目文件可查看或插入 `@路径`。手机文件通过系统文件选择器上传；普通文件插入可见引用，图片使用图片附件字段。
- 返回保留草稿及列表阅读位置。断线时已有任务继续在电脑上执行；手机上的待发送消息会保留，重连后发送。
- 任务可重命名、置顶、归档。归档任务可从连接设置恢复。

## 构建

需要 JDK 17、Android SDK Platform 35 / Build Tools 35.0.0。项目带 Gradle Wrapper 8.11.1。

```sh
./gradlew :app:assembleRelease :app:testReleaseUnitTest
```

可在 Android Studio 中直接打开本目录。`local.properties` 由本机生成，设置正确的 `sdk.dir`。产物位于 `app/build/outputs/apk/release/app-release.apk`。

本次交付使用与 2.0、3.0 版相同的开发签名，应用 ID 为 `com.webdcc.android`，versionCode 为 4，可覆盖安装保留已绑定的登录信息。`signing/local-development.keystore` 仅用于这个侧载项目的开发版更新，密码和 alias 已在 Gradle 配置中明示；正式分发前应换成自行保管的发布签名。它不包含 WebDCC 的 token、Cookie 或 API Key。

## 状态与重试

REST 命令使用稳定 `clientCommandId`。网络中断、回执不确定时重试沿用同一编号；服务端明确拒绝的消息，用户重试会创建新的编号。已被服务端接受的排队消息不显示虚假的取消按钮。只有尚未发送的本地消息可取消。

实时连接回复 JSON ping，以持久化事件序号恢复订阅。流式条目在完成事件到达时替换；重放按 seq 合并。每个任务的 feedSeq 防止旧 REST 响应覆盖较新的状态。审批按 approvalId、提问按 questionId 消重。

对接依据：WebDCC 上游提交 `97b3c073c5ec67d50df58cf564d33537c109eddc` 的 `protocol`、`rest`、`hub`、`dispatcher` 和 `turn` 实现。此客户端不替代电脑端的 WebDCC / Codex / Claude / DSH 进程。

## 交互参考

参考官方 [Codex 手机远程任务流程](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)、[Claude Code 手机端](https://code.claude.com/docs/en/mobile) 与 [Remote Control](https://code.claude.com/docs/en/remote-control)。采用它们“选择项目 → 输入任务 → 跟进执行 → 处理请求 → 审阅改动 → 继续对话”的流程。

功能以 WebDCC 实际协议为准。本版提供排队追加和停止；服务端没有单独暴露 Steer、分支 / worktree 创建等命令，因此不显示没有实际作用的入口。没有包含这些产品的界面资源或网页。
