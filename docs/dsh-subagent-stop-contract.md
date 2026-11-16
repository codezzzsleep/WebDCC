# DSH 子 Agent 独立停止合同

关联 #53、#16、#52、#66（仅 DSH 子范围）、#42；基于子会话读取 PR #225/#236。

冻结版本仍为 DSH `0.2.2-rc.1`。实际执行的 Host release commit 为 `fcc0ad4`，bootstrap 指纹为 `932fdfe376de37d1d0cf4c17978e066604874d2586ebd1de870cff21d65d73c2`；编译 CLI SHA-256 为 `54d9e9fee0d005835a1967dba39246459a65133e13555239c5b6a2a229ab48e0`。安装源码存在预存修改；没有修改或升级官方 Agent、prompt、工具、权限、版本或编译文件。

旧冻结目录的 `subagents/interruptByParent(childSessionId,parentSessionId,mode)` 在该实际 Host 上返回 HTTP 404。编译原生 `typert.host.js`（SHA-256 `da62ec30c2e46021d8c7cf21c366c355bd7c6e32f71bfe9a079f1bb229ab92c3`）和官方 Session Controller 使用 `subagents/interruptByUser(childSessionId)`；该调用在实际 Host 上返回同 rpcId 的 `{accepted:true}`。本兼容审查只替换停止端点，重新生成库存及 schema 指纹；prompt 的旧地址参数差异留给下一独立审查。

原生 Gateway 按目标 child session 授权。WebDCC 同时从持久化父 nativeId 读取当前官方直接子目录，拒绝陌生 ID、外部/未知/一次性模式与旧连接/父身份的操作，不接受浏览器提供的任意原生端点。停止不会恢复父 Agent，也不会创建父 writer 或给父会话发送替代 prompt。

`accepted:true` 只证明 cancel 信号已受理。原生接受空闲、已完成或不存在目标的 no-op，因此该回执不证明目标停止。网页保留独立命令回执；同一命令重复提交读取已有状态。原生是否停止由 `session/state` 和子会话自身 `turn/end` 继续展示。请求或回执丢失后不会自动重发；刷新先读取已登记回执和当前原生状态。原生没有为 Stop 暴露可指定的 turn/run ID，本入口不声称仅停止某个历史轮次。

实际 HTTP 404/200、编译 descriptor 和证据哈希保存在 [`subagent-stop-contract.json`](../fixtures/dsh/subagent-stop-contract.json)。这次原生探针复用了已完成的真实父子记录，新增模型请求为 0；空闲停止受理不能扩大为运行中停止、当前 Provider 或目标平台验收。受控 HTTP/WS/Chromium 回归与实际原生执行分别记录；失败和未触发证据保留。合并、Issue 关闭及 121 部署由既有负责窗口处理。
