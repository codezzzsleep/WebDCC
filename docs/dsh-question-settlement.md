# DSH 问题提交与原生结果

关联 #53/#52/#42，仅 DSH。官方版本保持 `0.2.2-rc.1`，没有修改原生工具、提示词、权限或运行规则。

`$events/result` 的成功回执没有业务值。官方 Gateway 对已完成的 waterfall，或不属于当前 Client 的旧 delivery，接受幂等 no-op。因此 HTTP 成功只记录“已提交，等待原生结果”。同一个原生 `callId` 的 `tool/result` 答案，或 timed `userQuestions.settled`，才结束问题。它们可能来自另一个原版界面；forwarding `cancel` 也可能由该界面先回答引发，不能单凭它显示用户取消。

WebDCC 保留原始 waterfall `eventId`、每一道题的 `id` 及原生 `callId`。旧版 `ask_user_question` 的 waterfall 没有 `wait.callId` 时，只能用无歧义的已记录 live 调用核对完整问题集；原生工具把 `multi_select` 转换为客户端 `multiSelect`，其他题目、选项和答案字节保留。含糊身份、缺少完整答案或未知结果不会被计作成功。旧连接的 HTTP 返回不会删除当前重新获得的问题。

答案结果到达时，匹配此次本地提交的完整答案记为原生确认；其他原生答案收敛为 external。原生明确的 `ASK_CANCELLED`/`ASK_ABORTED` 结果收敛为取消，其他失败保留结果未确认。业务结果与 HTTP 返回的先后顺序不改变问题终态。

实际命令入口也使用该业务证据：完整匹配的原生答案先到时，即使随后HTTP失败也可返回confirmed；外部不同答案/取消先到时，后来的void ACK不能把本地回答命令记作完成。前后原失败与回执仍可分别核查，旧回调只提供原命令的证据，不改当前pending。

[选取的原生协议信封](../fixtures/dsh/question-settlement.json) 来自一次实际固定原生执行和 loopback scripted model 的历史采集，带原 capture/Host 哈希和原始身份；这是实际原生受控模型证据的有限回放，不是 live Provider 验证。定向 HTTP/Chromium 测试驱动受控原生帧，验证当前生产 adapter/manager/界面的确认和刷新语义，未执行新的原生或模型任务。原失败报告保留。

另以既有 live `claude-sonnet-5`/Native0.2.2-rc.1 问答采集复核当前处理器的原生终态投影。原整批任务因后续 sandbox 写入/审批未触发而失败，该报告和完整轨迹保持原样；只核对其中实际问题、答案 batch、工具 callId 与业务结果。原 Host graph 与当前不同，有限回放不证明全部目录或当前 Provider，且原 per-session trace 未保存全局 ready；不补造握手或再次发送原回答。来源报告 SHA256 `45de74991419878e03ae89b4807133c988d94577a63c9d3df2956424bc107fbf`，完整 trace SHA256 `1b40828a7f368673e8076495608d7533670075752238a98d6c0d8a05d0bed677`；复核和原未触发范围分别记录在私有专项账本。

剩余独立范围为前台计时/续答转换和网络结果未知时的原生对账、安全重试，以及 Host 重启全矩阵。原生 `UserQuestionService.assertLiveRoot` 明确拒绝被另一 Agent 管理的子 Agent 人工交互（`DELEGATED_CALLER`）；WebDCC 保留该限制，不能用父 prompt 模拟子问答。源码交付与特定原生/provider/目标平台验收分开；合并、Issue关闭和部署由既有负责窗口处理。
