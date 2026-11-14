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

## GitHub 发布与 CI 权限（2026-11-14）

- 用户要求修复代码在 GitHub 可见；修复分支正在发布，草稿 PR 不表示 48 项完成。
- GitHub OAuth 凭据缺少 workflow scope，拒绝上传新增 `.github/workflows/source-checks.yml`；现有 SSH 也未授权。源码及检查命令照常保留，CI 定义暂存于 `docs/ci/source-checks.yml` 供审查；它不是已启用的 GitHub Actions。
- 恢复自动 CI 需要有 workflow scope 的发布凭据或仓库维护者将该文件放回 `.github/workflows/`。NP-15/46 的 CI 验收保持未完成，不以模板替代实际执行。
- 后续部署仅限用户新增授权的独立远程环境，原有本机部署边界继续有效。

## Codex 原生交互确认阶段（2026-11-14）

- 修复分支已公开推送，草稿 PR： https://github.com/codezzzsleep/WebDCC/pull/39 。主分支未合并，原有部署未更新。
- Codex 回复传输后返回 confirmed=false；manager 保留 sent 占用和待解决投影，直到收到 threadId 与类型化 requestId 完全匹配的 serverRequest/resolved。数字 0 与字符串 "0" 独立，其他线程、重复或未知通知不能结束请求。
- 原生确认关闭整组问题/审批；外部结束保留不同展示，不伪称收到本地答案。已提交请求在等待确认或停止清理时不重复回复；回放 adapter 也保留确认状态。
- 持久事件记录 sent/collected/uncertain 展示，刷新仍禁用等待确认的按钮。重启后 sending/sent/collected 整组变为 uncertain 并持久化投影。SQLite schema v6 阻止不理解 sent 语义的 v5 二进制直接回退使用数据库。
- 局部 16 项协议/服务测试及 2 项真实 Chromium 测试通过；完整源码门禁在提交 `e493ec4` 全部通过：64 文件 / 280 项单元、5 项 Chromium、typecheck/lint/库存/构建通过，源码 fingerprint 为 `39339fb5d905ecf246c343480e086f67762cdfad2246c4b1e23f90f699c51d2d`。仍无真实模型/native 验收，NP-06 未完整完成。
- 新远程环境采用独立目录/运行用户/数据/工具链；安装与传输进行中。原服务器的其他服务不变。具体运维检查点保存在仓库外私有目录，不提交凭据或环境文件。

## GitHub 与独立远程部署检查点（2026-11-14）

- 已推送修复源码 `e493ec49cd6bab75382598ce552b180ee1b6a874` 到 `fix/native-parity-repair`，草稿 PR #39 可见。没有合并 main。新增 CI 定义仍在 docs/ci/source-checks.yml；GitHub Actions 未启用，缺少 workflow 凭据权限。
- 本轮源码报告绑定 `e493ec4`；L1 同提交检查 33 轨迹 / 3,681 帧，I1–I8 没有失败，22 GOLDEN、16 NOT_TRIGGERED，8/33 场景通过，门禁保持失败。报告位于忽略的 evidence/source-checks.json 与 evidence/l1-e493ec4.json。
- 用户另行授权的远程环境已部署该源码：独立 release、Node 26.13.0、非 root 用户、数据库和两个 systemd 单元。真实浏览器经独立临时 HTTPS 入口验证登录、Secure/HttpOnly Cookie、地址去 token、页面渲染、刷新、版本/fingerprint 和双向 WebSocket；构建字节 SHA 与本机构建一致。
- 该 HTTPS 入口由 quick tunnel 提供，进程重建时地址可能改变，须重新登记 origin。部署证明网页与传输可用，不代表 48 项或真实 Agent 验收完成。原生账号未配置；远程既有 DSH CLI 版本 0.2.1-rc.2 与锁定基线不同，既有 DSH 服务未升级。隔离 Codex 0.167.0 与 Claude CLI 2.1.322 已以服务运行用户执行 --version 验证；账号仍未配置，DSH 固定 Host 基线仍待准备。
- 私有运维记录与登录链接保存在仓库外，未公开凭据、Cookie、完整环境文件或远程运维身份。恢复时先读私有 deployment-state.json 并核实活跃进程、当前 tunnel 地址和安装任务，不重建已完成部署。
- 原有本机 release 仍为 `97b3c073c5ec67d50df58cf564d33537c109eddc`，原进程 PID 2303523 保持运行；原 worktree 未改变业务源码。
- 全部 48 项继续：17 项部分推进、31 项待专项实施，0 项全部验收完成。下一步继续 NP-06 uncertain 对账与部分答案恢复，并推进 NP-04 owner/fencing 与 NP-05 原生账本；随后按矩阵补齐 M1–M3。

## 持久运行代际与原生记录阶段（2026-11-14）

- SQLite schema v7 增加 native_owners、native_event_envelopes、native_event_projections 及事件信封关联；新表、关联列和版本变更同事务交付。旧 URL、事件正文、nativeId 与既有结果保留，旧缺失的原生证据不补造。
- Managed owner/generation 在 native create/resume 前持久占有；同一原生身份不能由两个 Web 会话写入。只约束 WebDCC 管理的连接/进程，不宣称约束外部 CLI/DSH 客户端。租约过期不证明 writer 已退出；跨实例未验证释放保持阻塞。
- 重启根据 boot ID/进程起始信息识别失联 owner，保留 activeNativeTurn/lastObservedSeq 为 uncertain。第二个 manager 不改写仍存活实例的命令/交互；create/resume single-flight、所有权检查贯穿原生调用前后，三 adapter 事件带接收运行代际。
- 通道关闭与原生 turn 终态分离：未确认结果保留轮次/输入和待核对提示，不伪造用户中断。收到已确认的终态后可关闭 managed connection；未知副作用不自动重发。
- 原始 RPC/SDK/已关联 DSH 调用记录在映射前写入，和适配记录分开。旧代际、未关联及未知/内部事件可查；不可访问 JSON 的缺口改为受认证的分页列表、单记录及任意 Web seq 证据接口，并有浏览器原生记录入口。
- 凭据写前脱敏，声明 secret/writeOnly 的请求及关联响应省略；记录限额明确标 coverage 缺失。Native capture 失败会隔离 writer，不把未持久化输入发给原生。诊断 JSON 展示采用文本，实际 JSON-RPC echo 子进程验证脱敏不修改原生输入/响应。
- 已确认修复原 manager 把所有 internal data 改成 turn.started 的问题。精确重复的已完成事件只形成一个语义事件；投影去重的完成标记与 event 同事务，恢复不把仅占位的记录误当成已投影。
- 本阶段首轮六类源码检查通过（66 文件 / 290 单元、6 项 Chromium），之后补了投影落盘窗口回归，目标检查点将重新绑定正式提交。新运行隔离/恢复/捕获局部 11 项单元与 1 项真实 Chromium 已验证；不属于真实模型的完整验收。
- 仍需 NativeSessionRef 的真实 Host/profile/version 校验、可操作 native 状态对账与 partial answers 恢复、完整全局/设置/错误帧及历史覆盖、持久 gap/版本化重建、完整 actor 关联和真实三家故障验收。NP-04/05/14/47 保持部分推进。
- 已部署版本和原本本机部署不更新。本批源码提交后推送修复分支，继续 NP-04/06 的原生只读对账与安全恢复。

## 本批源码验证检查点（2026-11-14）

- 修复提交 `20701b2d356ebd68711f36f53d9201d68b065334` 已推送到修复分支与 PR #39。共 29 个触及文件，1,037 新增/76 删除（包含测试和工程文档）；不代表 48 项全部完成。
- 精确提交源码门禁六类全部通过：66 个单元文件 / 291 项测试、5 个 Chromium 文件 / 6 项真实浏览器测试。报告 source-checks.json 绑定上述提交，source fingerprint `f28db751cb2a24941fe0f603c4a97a3efdaca73a0809cd3c4b1bde0fd5ca0441`。
- 同提交 L1 33 轨迹 / 3,681 帧：I1–I8 没有失败；22 GOLDEN、16 NOT_TRIGGERED，8/33 场景通过，门禁仍失败。evidence/l1-20701b2.json 绑定当前检查点，未改 golden。
- 下一可执行路径：扩展 Codex typed thread/read + thread/turns/list 只读观察（notLoaded 不代表其他进程空闲），通过 SDK 公共 spawnClaudeCodeProcess 记录可验证的 managed child identity，再接原生状态对账和交互恢复。SDK prewarm().claim 是绑定备用进程，不是原生全局所有权证据；不要将其用于声称安全接管。
- 原生 Sidecar/Host 全局帧、坏 JSON/错误帧、版本化投影重建、准确 Host/profile 以及可操作 uncertain 恢复仍未完成。继续实现并补证，不将局部源码绿灯换成 native 完成。原本本机部署不变；当前远程部署仍为上轮的 e493ec4。

## 接续实现：原生终态核对与恢复（2026-11-14）

- 用户重新授权本任务继续全部 NP-01–48；使用原修复 checkout 接续暂停时的工作，不重启被调查对话，也不创建新的持久目标。当前服务器与121部署不更新。
- 完成继承的 SQLite v8 managed process 身份和核对记录、Codex typed thread/read + thread/turns/list 只读观察、SDK 公共 spawner、Web 核对/恢复入口。绑定机器/boot/PID启动时刻/profile/原生版本，旧库身份缺失仍不能冒充安全释放。
- 核对预览有60秒有效期和状态指纹；应用前二次读取，唯一 native turn / command identity、完整终态、工作区/版本/配置目录、旧writer已退出必须同时成立。事务失败无部分写入，重复应用被拒。
- 恢复保留排队正文与附件，不发新模型请求，不自动重发。原生轮次终态不能证明交互答案或审批被接收，问答/审批明确展示“结果未确认”。
- 完整源码检查六类通过：70文件/301项单元、6文件/7项真实Chromium；最后展示修订另行通过6项恢复单元及1项Chromium。完整报告为 web_review/evidence/source-checks.json；它不是全48项或真实模型验收。
- 独立Codex 0.167.0 + scripted model：原生直接RPC完成→SIGKILL writer→重开SQLite→只读核对→明确应用终态→再重开确认，保留队列且核对期间模型请求数不变。证据 web_review/evidence/native-recovery-current.json；不冒充真实付费模型效果验收。
- 后续继续目标状态/统计投影、全局原生帧、完整能力目录与M0剩余项；三家真实故障与外部writer仲裁、secret及完整原生surface仍待完成。
