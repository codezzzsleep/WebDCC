# WebDCC 修复进度

用户授权：持续推进全部 NP-01–48，仅修复项目；暂不更新本地已部署版本。

源码工作区：`/root/WebDCC-repair`，分支 `fix/native-parity-repair`，起点 `878c8c9`。
审查基线：`9b1ae9096c19162206361e3910b7ef2592c5f30b`；差异为 Android 发布相关内容。
实施合同：本目录 SPEC、约束、需求矩阵；保留现有技术栈、adapter facade、旧会话 URL。

## 实施状态

全部 48 项均属于授权范围。实现与验证分别记录；没有真实触发证据的能力不标 verified。
按矩阵依赖推进，首批 NP-01 → NP-02 → NP-13/15 → NP-46，随后推进 M0 剩余需求和 M1–M3。
`IMPLEMENTATION_MATRIX.json` 的 execution 字段记录具体状态、文件计划、检查与剩余验收。

## 隔离边界

测试使用本 worktree 的构建及临时数据目录。未经后续部署指令，不运行 release、服务重启、部署目录更新或已部署数据库迁移。
原生配置、真实会话、账号及模型测试使用显式隔离条件；缺少条件的验收保留未验证状态。

## 当前检查与源码检查点

- 已在独立 worktree 用 Node 26.13.0 / pnpm 12.18.0 完成 frozen/offline 安装，批准所需 SQLite 原生构建策略。原工作区仍是 `878c8c9`，只含原有未跟踪审查文档；部署、服务和部署数据库未操作。
- `pnpm check:source` 六类检查通过，当前报告和逐项日志位于 `evidence/source-checks.json`。报告按 commit 和实际源码 fingerprint 绑定；后续源码变化需要新报告。该报告不宣称原生验收完成。
- 首版固定库存包含 515 项 Codex 方法、DSH 端点、Claude Query/Options 及原生入口；原生导出未修改。能力页面保持未实现/未验证状态。
- Codex 已用导出类型和 JSON schema 校验已调用的请求/结果，区分 thread sandbox 与 turn sandboxPolicy；字符串/数字请求身份、未知请求拒绝、监听器和启动失败清理有回归。
- 实测本机 Codex 0.168.0，合同基线为 0.167.0。新建/resume 已加版本门禁；未安装/升级任何原生 CLI。Claude CLI 2.1.322、DSH CLI 0.2.2-rc.1 是只读版本检查，DSH 远程 Host 版本仍待证明。
- 命令账本和队列使用 SQLite schema v2 / FULL 同步。20 个同 ID 并发请求只形成一个轮次；真实 SIGKILL 后已 ACK 队列正文/附件仍在，已发原生的命令成为 uncertain，禁止盲重发。网页恢复队列、取消、过期响应保护及 outbox 先存后发有回归。
- 自由文本答案从真实表单形状经 HTTP→manager→Codex 响应保持原文；三 adapter 共用答案归一化。Codex 问题按请求隔离，数字与字符串请求 ID 的相同打印值不混淆。
- 已修复历史请求失败仍前移订阅、第二次打开不重试、乱序事件跨过缺口、空快照保留旧热项，以及 pending 投影覆盖掉用户消息的问题。
- HTML/SVG/伪装 raster 内容下载，真实 raster 按字节识别；Origin/Host/可信代理/Secure Cookie、坏 Cookie、索引/分片长度/重复冲突/完整性、上传配额/取消/过期清理有确定性与真实 Chromium 安全测试。
- 诊断录制现为显式 `WDCC_TRACE=1`；secret 脱敏/存储/保留期限尚未完成。
- M8/M9 写本轮报告，检查 SHA/source/schema/ID 集合；旧 Boolean ratchet 拒绝；M9 重跑 M8。跳过 E2E 的 M8 负向执行确实失败并产报告；旧记录中 9 个场景共缺 18 个审批/问答谓词，L1 场景门禁因此失败，未改 golden 数据。
- 所有 NP 仍保留完整验收要求，没有把局部修复写成 48 项完成。矩阵 execution.remainingWork 说明已开始需求的具体余项。
- 本轮源码检查为 45 个测试文件 / 197 项测试，加独立 Chromium 安全测试；六类源码门禁通过。新增 DSH 远程错误不写本机 YAML、旧轮次不盲恢复、Claude 旧回调隔离的局部修复。完整 native 验收仍未运行。
- `web_review/evidence/` 和 `.artifacts/` 为本机验收产物，不提交，以避免报告提交后自身 SHA 变化；这里的源码检查点和矩阵提交到独立分支。
- 本地只有四份主审查文档，原审查 ZIP/补充证据及 AGENTS 指定的私有记忆不存在。按 AGENTS 限制未写私有 MEMORY；本文件保存工程恢复点。

## 下一步

重新生成源码检查证据并提交本地源码检查点，然后继续 M0：优先移除 DSH 远程错误时写本机 YAML 的 fallback，修复 base URL 前缀/连接重订阅/开场快照和子 Agent 参数合同；补 Claude block/system/generation 和权限 inherit/requested/effective。随后完善持久 owner/reconciliation、raw ledger、交互状态机及 secret 存储，再按依赖推进全部 M1–M3。

运行入口：所有命令在 `/root/WebDCC-repair` 执行。`pnpm check:source` 构建只写 `.artifacts/<runId>/`；不要执行 release 或重启服务。真实 Codex 0.167.0 与付费模型对照尚未准备，不能拿 0.168.0 当基线通过证据。
