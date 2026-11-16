# Claude 任务在服务异常退出后恢复（#242）

原进程没有机会执行正常回收时，新 Manager 虽将 owner 标为 uncertain，但保留的任务仍显示 running。启动恢复现在沿用现有可恢复 owner 判断，为 Claude 记录观察通道不可用。旧活动、暂停、待处理及仅有后台成员身份的任务恢复为 unknown，保留 nativeStatus、task/run、层级、工具、输出和已完成/失败/停止终态。

该观察属于 WebDCC，原始 SDK 信封保留。另一个仍活跃的 owner（含过期 lease）不改写；重复恢复不重复追加观察。缺少 query ID 的 legacy 记录也保持待确认；新 query 和原生生命周期可重新确认，旧 unavailable 不能覆盖新实例。

原源码两项语义回归失败，live-owner 保护通过；补齐启动恢复与 legacy 处理后，46 项任务/输出/所有权/回收定向检查及 server 类型、改动 Lint 通过。Chromium 从实际被 SIGKILL 的本窗口 writer 数据库打开源码 UI，验证 unknown、终态和 run/子输出、刷新、以新 socket generation 确认的重连及会话切换。

上述进程、SQLite、HTTP/WebSocket 和浏览器真实执行，任务信封为受控 SDK 形状，不算官方 CLI/模型或目标平台验收。另回放既有实际官方 SDK 的 68 帧原始消息，主任务停止/并发 peer 运行与 adapter、持久公共视图保持一致；没有新 SDK 进程或 provider 请求。原始失败、legacy 中间失败及证据范围保留。源版本与证据哈希在本窗口私有账本，合并及部署由现有窗口处理。
