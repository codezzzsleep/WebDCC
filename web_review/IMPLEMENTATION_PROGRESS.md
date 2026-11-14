# WebDCC 修复进度

用户授权：持续推进全部 NP-01–48，仅修复项目；暂不更新本地已部署版本。
2026-11-14 用户再次明确：未完成48项不能以阶段检查点为停止点。继续实施；只有真正完成或实际外部依赖阻断才说明限制。

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

## DSH 恢复与身份阶段（2026-11-13）

- DSH HTTP/WS 保留 basePath；HTTP deadline、WS 指数退避、401 停止等待新 Cookie、订阅注册表、已关闭 socket 幂等关闭和失败 sidecar 清理已实现。真实本地 WebSocket 回归验证存活订阅重开、取消订阅不复活、401 后更新凭据可恢复。
- 开场 snapshot 固定 cut，缺失区间由 session/page 向前补齐；补读完成前缓冲新事件。失败、乱序、Host/session 变化和旧代际页回调不前移覆盖水位。activeAttempt 流基线重建仍未完成。
- SQLite schema v3 添加原生轮次映射和恢复记录，以事务保留原生源/时间/身份与投影。恢复历史不进入实时轮次结束启发式；本地预写 user 消息按命令 ID 去重，已接受 inbox 也能绑定同一个原生轮次。原生轮次 ID 在 TurnTracker 中按会话隔离。
- DSH 子 Agent 使用锁定 catalog 的 request 包装、parentSessionId、continuable 和 interruptByParent；非本父会话及 one-shot 控制拒绝。审批保留 durable id/callId/waterfall eventId 映射，读取真实 {id,outcome}，未知 outcome 不猜允许。原生 cancel 收敛问答卡；多题原生批量 ACK 前不显示全部完成。
- DSH 连接保存先校验/连接/持久，再替换旧连接；不同 Host 不能继承既有会话。断开同时停止 adapter 订阅并持久化 null。连接文件原子替换/fsync，存储不对外暴露可修改引用。
- 51 个测试文件 / 218 项（阶段新增测试后以最新源码报告为准）；恢复前回调、事务回滚、SQLite 重开去重、无关旧轮次结束、真实 DSH S01 录制经 manager 不重复输入已通过针对性测试。
- L1 3,681 帧重新检查后没有 I1–I8 语义不变量失败；仍有 16 个 NOT_TRIGGERED 与 11 个 GOLDEN。golden 因修复后的消息身份/内部保真事件与旧输出不一致；未修改 golden，门禁保持失败。完整 L1 历史投影统一仍待 NP-15 完成。

## Claude 块与问答阶段（2026-11-13）

- DSH 阶段源码已提交为 `d0ed37b`，仅独立分支本地提交；六类源码门禁通过。
- Claude 的流式内容已提取到 actor/message/block/generation reducer；两个文本块分别完成、单块 SDK 投递、thinking/text 混排、主/子 Agent 同编号以及主结果不提前完成后台子块都有生产 Handler 回归。
- Claude system/init、压缩、状态、任务与未知系统消息不再从生产路径丢弃；原生 API 错误不再统一误标用户中断，explicit aborted_* 按原生终态区分。
- 三 adapter 的多题收集返回 submitted 状态和整组 questionIds；manager 等整组传输提交后同步问题卡。同步产生的问题不会被 send 成功后的 running 状态覆盖。
- Web 问答/审批卡依据服务端事件确认完成，提交中不本地提前显示解决；失败保留原文、旧 ACK 不覆盖新重试、uncertain 保持等待对账。共用 Turn reducer 展示条目/问题最新投影，避免旧 pending 卡与重复工具计数。
- Chromium 原始源码 UI→真实 WS→manager→Codex adapter fixture 回复→失败重试→刷新已走通，保留文本首尾空格。测试页面从临时目录真实提供，未关闭 Chromium 安全策略，未使用部署目录。
- 局部测试通过；完整源码门禁正在刷新。已有单元测试 52 文件 / 227 项，新补背景子块回归后以最新报告为准；独立 Chromium 新增一项问答回归。L1 无 I1–I8 失败，但 22 个旧 GOLDEN 与 16 个 NOT_TRIGGERED 仍使门禁失败。未更新 golden；不宣称原生验收完成。
- 仍需持久 interaction、跨浏览器竞争、真正 native 解决确认、secret、计时问题与 query 代际/换模型全生命周期；以上局部修复不代表 NP-06/09 已完整完成。

## 权限状态与运行控制阶段（2026-11-14）

- 前阶段源码已提交为 `84d6029`；本阶段继承其独立工作区，没有触及部署。
- 统一权限状态记录 requested/effective/revision/source/scope，原生 session 默认沿用配置；新建界面不再沿用上次记住的权限。SQLite v4 把旧 selection 迁移为 unknown，原 URL 与历史保留。
- Codex thread 与 turn 参数保持各自合同；turn/start 成功后使用无覆盖的 thread/resume 读取原生当前权限，不假定请求策略已生效。权限覆盖持续到后续轮次，inherit 不再显示启动时过期策略。回读失败不把已接受轮次改成失败，但实际权限未确认。
- DSH 使用实时权限 catalog/投影并检查 commands/execute 业务结果；不支持或原生不允许的模式不能选择。尚未实现动态 catalog 通知与完整 generation 刷新。
- Claude query 替换等待 SDK 初始化，旧 query 先关闭；失败后恢复同一 native session 的此前启动配置。权限/effort 变更保存在下一实例配置；background_tasks_changed 使用替换语义，迟到 bookend 不阻塞切换。
- 发送、已 ACK 队列、模型/权限/effort 切换统一串行处理。权限失败保留 queued 正文并暂停，修正后执行。Chromium 已验证待生效显示实际旧权限、禁选原生 forbidden 模式，仍为 fixture 验证。
- 本阶段六类源码门禁已通过：58 个测试文件 / 248 项单元测试及 3 项独立 Chromium 测试；以 `evidence/source-checks.json` 的实际 SHA/fingerprint 为准。真实 Codex 0.167.0 与实际模型执行验收未运行，NP-07/04/09 均未标完整完成。

## DSH 配置作用域与 CAS 阶段（2026-11-14）

- 权限阶段已提交 `fdcf1dc`，248 项单元 / 58 文件与 3 项 Chromium 回归及完整源码门禁通过，构建只写独立 `.artifacts/`。
- 原生配置路由提取到 typed service 和公共协议；每次变更绑定 Host URL/连接身份和客户端已读取 revision。提供只读变更预览，原生 schema 校验，CAS 冲突 409 和同 Host 写后回读。
- 模型编辑与设为默认拆成单 namespace 原子动作；编辑 B 保留模型 A、名称、未知字段及未传思考/容量，不更新全局默认。重名冲突和重命名当前默认的悬空引用拒绝。
- 使用原生 settings/mutate 精确字段路径，不重述整个 Provider 或其他 Provider；含隐藏 secret 的模型数组不重述。不存在 fallback 写本机 YAML。
- Chromium 真实 UI→HTTP→本地 Host 合同 fixture 验证 Host/变更预览、取消无写、冲突保留草稿、刷新重新核对、独立默认选择与刷新；新增 8 项服务回归。真实 DSH 服务/文档/重启验收尚未运行。
- 本阶段六类源码门禁通过：59 个测试文件 / 256 项单元测试、4 项 Chromium 测试；报告绑定 `fdcf1dc` 及实际源码 fingerprint。旧 home patch helper 无生产调用，显式本地 YAML 编辑仍属待实施；不要因原生写失败恢复它。

## 诊断写前脱敏与保留阶段（2026-11-14）

- DSH 配置阶段已提交 `c46f5e8`；59 文件 / 256 项单元、4 项 Chromium 回归与六类源码门禁通过。
- HTTP/model/native preload 和主 recorder 共用写前脱敏：nested/escaped JSON、Cookie 片段、known secrets、URL 和 sensitive fields；HTTP 跨分片凭据在有限拼接范围内脱敏。模型诊断 SHA 描述 redacted bytes，独立原生字节对照仍由测试负责。
- 请求流式转发与背压，响应持续原文转发；录制按 body bytes/chunks、writer queued bytes 和 JSONL 文件设置上限。正文超限整份丢弃并标 coverage，文件/排队写失败留下小型覆盖缺失标记，错误列表与重复 stderr 有界。
- 主 recorder 在启动和每小时有记录活动时清理过期的诊断文件；无计时器，无部署数据迁移。启动目录或 proxy listen 失败继续原生配置，不把诊断失败变成用户命令失败。
- 已用真实 Node 子进程加载 native preload，验证正常/正文超限/文件超限均保持 request/response 原文；测试只访问临时目录和本地 HTTP fixture，没有真实模型调用。
- 本阶段六类源码门禁通过：63 个测试文件 / 269 项单元测试、4 项 Chromium 测试；报告绑定 `c46f5e8` 及源码 fingerprint。仍需 SQLite/queue/command/outbox 的 secret-aware 存储、SDK/RPC 跨帧连续脱敏、全局跨进程配额、旧录制导出以及完整 native 对照；NP-14 保持未完整完成。

## 持久交互占用与浏览器竞争阶段（2026-11-14）

- 诊断阶段已提交 `ecdc138`；63 文件 / 269 项单元、4 项 Chromium 与完整源码门禁通过。
- SQLite schema v5 添加 native interaction/group 占用，与 event 追加同事务；旧事件索引一次性迁移保留 URL、历史和 resolved 状态。索引只保存选项 ID、身份/状态和错误类别，不重复存储问答原文或审批详情。
- 不同 clientCommandId / 浏览器回应同一 native group 时，原子 claim 只允许一个 sending；unknown 结果与重启中的 sending/collected 变为 uncertain，保持禁止盲重发。已接受的部分答案仍在命令账本，需要后续恢复对账与 rehydrate。
- cancel/外部已解决状态胜过迟到本地完成；最新交互投影决定 waiting/running，避免解决卡片仍卡在等待。Claude 不再把已结束审批回成功，带冒号问题 ID 保持完整，fallback ID 含 query generation。
- 20 个不同命令竞争审批只一次 native submission；多题最后提交期间不能重发前题；真实 SIGKILL 保留占用并恢复 uncertain；真实双 Chromium context 竞争只提交首个答案。均为本地隔离/adapter 合同 fixture，不是付费真实模型证据。
- 本阶段六类源码门禁通过：64 个测试文件 / 276 项单元测试、5 项 Chromium 测试；报告绑定 `ecdc138` 及实际源码 fingerprint。真正 native 接收确认、deadline/revision、secret/URL/form、可操作 uncertain 对账与恢复、完整三家验收仍待推进，NP-06 保持未完整完成。

## 当前源码检查点与下一步（2026-11-14）

- 当前源码检查点 `64cf89e`（本轮四个修复提交：`fdcf1dc`、`c46f5e8`、`ecdc138`、`64cf89e`）。`evidence/source-checks.json` 保存六类源码通过证据：64 文件 / 276 项单元及 5 项 Chromium；验证按实际源码 fingerprint 绑定，提交元数据为测试时的父提交 `ecdc138`。
- `evidence/l1-64cf89e.json` 绑定实际源码 `64cf89e`：33 轨迹 / 3,681 帧，未出现 I1–I8 语义不变量失败；22 项 GOLDEN 和 16 项 NOT_TRIGGERED 使门禁继续失败。没有修改 golden/原录制，也没有宣称 native 验收已完成。
- 原工作区仍 `878c8c9`；部署进程 PID `2303523` 和 `/opt/webdcc/current` 指向的 release `97b3c073c5ec67d50df58cf564d33537c109eddc` 未变。仅修复 worktree 源码与本地测试/构建产物。
- 下一可执行项：NP-06 的 uncertain 对账、部分答案安全恢复与 secret；然后 NP-04 持久 owner/fencing、NP-05 raw ledger 与 DSH activeAttempt/workspace 基线。全部 48 项继续按矩阵依赖推进，scope 没有缩成当前几批。
- 真实 Codex 0.167.0 / 真实模型及账号、真实 DSH 双界面断线、CLI/PTY、secret/URL/form 等验收仍待准备/实施；不能以本机 0.168.0 或 fixture 通过代替固定基线证据。

运行入口：所有命令在 `/root/WebDCC-repair` 执行。`pnpm check:source` 构建只写 `.artifacts/<runId>/`；不要执行 release 或重启服务。真实 Codex 0.167.0 与付费模型对照尚未准备，不能拿 0.168.0 当基线通过证据。
