# Claude 指定任务停止及恢复（#51/#65/#66，关联 #84）

公共任务树现在为每个当前任务提供原生停止入口。请求必须携带当前 taskId 与显式 runId；原生未提供 run 时使用 null，旧 run、终态、缺少当前身份的任务在发送前拒绝。当前后台快照中的任务可以在保留 unknown 生命周期的同时被停止。每次点击重新读取当前 query 和目标，其他任务的进度不会使该目标的 query 版本无谓失效。

唯一原生停止调用是锁定 SDK `Query.stopTask(taskId)`。runId、原生会话和 owner/generation 用于 WebDCC 核对，不作为 SDK 不支持的参数发送，也不通过父级 prompt 模拟子任务输入。调用返回只保存时间和目标引用，停止终态必须来自匹配原生 task_notification；自然完成/失败、断线或代际丢失不会伪装为停止成功。SDK 已返回而后续 owner 校验失败时，返回证据仍保留，操作保持 uncertain。

任务按钮保留同一命令身份，reply 或 receipt 暂不可读时只恢复 receipt。刷新和会话切换恢复当前 task/run 的原命令；停止一个任务时另一个任务的按钮仍独立可用。旧 run 的返回和通知不能覆盖新 run。任务层级、主子输出身份及进程回收恢复复用 #207/#215/#223 和独立 #233，不重复实现其他窗口的回收修复。

`perTaskStopAffordance` 只对已验收的 Linux x64、SDK0.3.322/schema/module 和 CLI2.1.322 二进制组合开启，运行时核对三个文件的 SHA256。其他组合继续保留 SDK 的默认 interrupt 范围。声明开启后，WebDCC 使用 open-input query，普通停止按钮按 SDK 合同标明当前回答的范围；任务分别使用自己的停止按钮。

源码定向检查验证 task/run 校验、snapshot-only/null-run、调用返回先后、自然终态、owner 丢失、幂等、数据库恢复及生产 Manager 回收。受控源码 Chromium 检查验证丢失回复/receipt、刷新、会话切换和独立按钮；这些夹具不算真实 SDK/model 执行。

实际链路另使用官方 SDK/CLI 执行两名 Agent 的真实 Bash/Python 进程，模型回复复用唯一已捕获原件，provider 新增请求为 0。真实源码按钮停止 A 后，A 收到 stopped 并退出，B 持续写入且保持 running；open-input interrupt 也保留 B。实际 initialize 收到 perTaskStopAffordance=true，两个 stop_task 控制仅包含 task_id。任务及 receipt 的刷新、WebSocket 重连和实际会话切换均通过。

原始付费任务的定位失败、前三次回放失败、源码负向复现、折叠面板断言失败、收集失败和共享重负载超时全部保留。未录制的两项模型续答保持未触发；本项不证明当前 provider、最新模型行为、其他平台或目标部署验收。版本、原始模型/native/副作用/源码 UI 证据及指纹绑定在 `task-stop-verification.json` 和本窗口私有账本。合并、聚合 Issue 关闭及部署仍由现有负责窗口处理。
