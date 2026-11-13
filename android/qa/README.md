# 交互验收

`acceptance-checkpoints.json` 记录本次模拟器中通过的 12 条用户流程。截图和录屏中的 `qa-model` 是测试适配器返回的模型名，不包含在 APK 中。

需要复现隔离服务端时，在本项目旁克隆上游仓库为 `WebDCC`，安装其依赖，使用 Node 24：

```sh
cd ../WebDCC
pnpm install --frozen-lockfile
node --import tsx ../WebDCC-Mobile/qa/ui-server.mts /absolute/path/to/new-empty-test-folder
```

该脚本在指定的测试目录创建 `sample-app`，启动端口为 8927 的真实 WebDCC 服务端，替换 Agent 进程为可控场景适配器。它不读取本机 Agent 的登录配置，不调用付费模型；仅修改测试目录内的主题文件。请使用新建的空测试目录。

手机与电脑位于可互通网络时，开发者需要按测试环境网络配置调整脚本的监听地址；脚本默认仅监听电脑 loopback。模拟器可通过 `10.0.2.2` 访问该地址。测试 token 固定为 `mobile-qa-token`，仅供本地隔离验收。

按以下路径操作实际安装包：

1. 绑定 → 选项目 → 创建任务 → 查看流式回复。
2. 审阅改动 → 查看源文件 → 返回 diff → 点击代码行 → 写意见 → 放入输入框。
3. 离开、重新进入同一任务，检查草稿和阅读位置。
4. Claude Code 场景停在审批请求时，先追加一条消息，检查排队状态。
5. 允许一次 → 回答选择题并补充文字 → 关闭、重新打开确认填写内容 → 发送回答。
6. 检查排队消息开始一次；停止新的待审批任务。
7. 以 `fail-once` 开头发送消息，服务端仅第一次拒绝。点击重试，检查同一原文只入库一次。
8. 断开传输网络，写入消息，强制关闭应用并重开；恢复网络，检查离线消息只入库一次。
9. 从历史位置发送新消息，检查自动定位；手动阅读历史时检查实时输出没有强行拉走阅读位置。
10. 从系统文件选择器选择文件，返回原任务，检查可见引用和服务器收到的文件内容。

协议单元测试直接使用 `./gradlew :app:testReleaseUnitTest`，无需模拟器。

## 3.1 appearance and reasoning checks

`v31-checkpoints.json` records nine additional flows. The screenshots include system light / dark, the reasoning selector and both thread appearances. The new-task assertion reads the actual SQLite reasoning field; the existing-task assertion also checks the scenario adapter call log. The scenario fast model declares only `low` and `high`, so the UI must restrict levels and normalize unsupported values when changing models.
