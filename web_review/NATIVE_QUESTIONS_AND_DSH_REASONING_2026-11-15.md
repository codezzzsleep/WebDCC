# Codex 异步提问与 DSH 思考等级修复（2026-11-15）

本次候选源码接通 Codex 默认执行中的原生异步问题和回答，提供 DSH 原生 Provider/模型声明的思考等级选择，并把“输入模式”改为可理解的工作方式说明。关联 #92、#93、#94、#95；#41、#48、#57、#59 的完整范围仍开放。

验收源码提交：`fa74c452a488a7e2bca9ebe1820cb1146d7955ff`，包含 main `ec7b080`。执行源码指纹：`df02d52779f7a50844686f96b5c0adf7fa8b639602d71038deb47075194a461c`。后续仅添加说明与脱敏摘要的提交不改变该指纹；原始报告绑定上述实测提交。详细清单、原生版本和证据摘要指纹见 [JSON 摘要](native-questions-and-dsh-reasoning-2026-11-15.summary.json)。

## 已完成实现与限定验收

| 范围 | 实测结果 |
| --- | --- |
| Codex 默认异步提问 | 7/7 实际原生+Chromium 场景：空闲回答、结束收敛窗口、运行中介入、排队、直接原生回答撤销旧网页队列、文件 SQLite/原生连接恢复、停止后回答。稳定题目身份、原样 UTF-8/换行、原生回显及下一模型请求均核对，重复提交和刷新不重发。 |
| 同步问答与取消 | 8/8：Codex Plan、Default 旧同步开关关闭/开启、Claude、DSH 及三家取消；Default 的旧工具负向检查不代表默认模式不能提问。 |
| MCP | 实际 Codex 0.169.0 + 本机 MCP form 接受、原文与整数、原生继续和 Chromium 刷新通过。 |
| DSH 思考等级 | 实际 DSH 0.2.2-rc.1 Web Host、生产 attach adapter、Chromium：既有会话 high/max/off、刷新、新建 high、省略模型时沿用原生默认路由、外部 Provider/模型/等级变化同步均通过。配置隔离、模型请求数为0。 |
| 源码门禁 | 类型、Lint、原生目录、622 项单元、37 项 Chromium 和构建通过。浏览器包含桌面与420px实际点击附件入口、失败重试刷新、工作方式待确认与生效分离等回归。源码门禁本身仍标注 nativeAcceptance=not-run；上述原生证据另列。 |

工作方式选择与原生实际状态分别展示。继承工作方式时，app-server 可能不回报实际模式；产品保留“待确认”，验收读取同一原生线程、同一 turnId 的 rollout turn_context 并要求 default。先前7个不正确断言的失败报告保留，没有将其改写成通过。旧源码门禁的浏览器失败与首次被主动终止的检查同样保留。

实际运行版本为 Codex 0.169.0、Claude Agent SDK 0.3.322 / CLI 2.1.322 (Claude Code)、DSH 0.2.2-rc.1（Host fcc0ad4）、Node v26.13.0。提问模型为本机 scripted Responses/Anthropic：模型仅安排实际工具输出，adapter、原生 Harness/SDK、HTTP/WS、SQLite和浏览器均为实际实现；没有调用付费模型，也没有修改生产配置。

## 复核入口

```sh
pnpm check:source
pnpm exec tsx scripts/verify-native-questions.ts --binary <Codex-0.169.0> --report <private-questions.json>
pnpm exec tsx scripts/verify-native-elicitation.ts --binary <Codex-0.169.0> --report <private-mcp.json>
pnpm exec tsx scripts/verify-native-dsh-reasoning.ts --report <private-dsh.json>
```

回答与确认边界见 [协议说明](../docs/question-blocking-semantics.md)。完整原生、模型、Web轨迹和源码日志保存在私有恢复目录，公开摘要提供可核对指纹，不复制凭据或用户轨迹。

## 尚未完成的验收与部署

- 当前部署及121服务器未部署或重启；尚未在已连接的生产DSH Host和真实Provider上验收本次修复。
- DSH等级证明覆盖实际Host选择/确认/刷新，模型请求数为0；未证明真实Provider各档推理输出。
- 直接原生steer绕过网页命令的场景已验收；独立OS客户端、全部跨连接故障和重启/unknown矩阵未完成。
- MCP仅验收普通form接受及刷新；secret、URL、拒绝、取消、过期和完整schema矩阵仍属于开放的NP-06范围。
- Codex工作方式文案、选择与观测边界已有源码/浏览器回归及既有会话原生证据；全新会话与生产环境的完整状态矩阵仍需补齐。
- 本次没有重跑L1全矩阵；历史1/33、32 GOLDEN和16 NOT_TRIGGERED不改写为通过。48项需求与相关完整Issue保持开放。

实现、限定场景验收和部署分别记录。候选源码待PR审查/合并；没有发布release、部署或重启当前及121服务器。#96 的DSH图片能力路由缺陷单独登记，未纳入本实现。
