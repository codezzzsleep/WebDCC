# WebDCC M8 SPEC：修复、补齐与强制验收

> **交给本地执行模型。** 这是 **v2**，用它原样替换仓库里的 `docs/specs/SPEC-M8.md`（验收脚本从这个文件解析用例 ID，见 6.6）。
>
> v2 包含审查方对 PR #11 的全部答复（见 0.1）。答复都是确定的，不需要再请示。

---

## 0. 为什么要做 M8

M1–M7 的自动化检查全部通过：typecheck、lint、48 个单测、16 个 e2e、三个 A1 脚本各 8/8。但这些检查没有覆盖到真实的使用路径：

- e2e 全部用 FakeAdapter；
- A1 脚本用 tsx 跑源码，而且不经过界面；
- 验收报告是手写的。

审查时改用生产构建（`node packages/server/dist/main.js`），接上真实的 DSH、Codex 和 Claude Code，模型用假模型，在浏览器里像用户一样点一遍，发现：

- Claude Code 根本启动不了；
- DSH 一用任务清单，整个页面崩溃，刷新也恢复不了；
- 选的模型没有传给 Agent；
- 时间线多出永远在转的"运行中…"；
- 新建的会话被标成 DSH；
- 访问模式、附件、斜杠命令、手机布局没有实现或没有接上。

所以 M8 做两件事：**修复和补齐**，以及**一套强制的真实界面验收**。M8 是否完成，只由这套验收决定。

**目标不是演示，而是用户每天用来跑真实任务的工具。** 三个 Agent 各自原有的功能（工具、计划/任务/目标、提问、审批、访问模式、警告）都必须在网页里完整可用、看得见，WebDCC 不许替它们删减或改变行为。

### 0.1 对 PR #11 的答复（v2 新增，全部是确定的决定）

**方案：** A、B、C 都不按原样采用。范围不缩减（B 否决），不暂停（C 否决），按本 v2 执行。

**立刻要做的三件事（写任何新功能之前，见 1.6）：** 清理测试泄漏的真实凭据副本；所有测试入口统一隔离并加启动守卫；打开 main 的分支保护。

| # | 问题 | 决定 | 落实位置 |
|---|---|---|---|
| Q1 | Codex 用 `gpt-5` 还是做 code mode 的 mock | **两条路径都测，code mode 为主。** 用户用 GPT 模型（ChatGPT 登录）时，Codex 0.167 走的就是 code mode；用户通过 Codex 用 DeepSeek 时，走的是直接工具。审查方已实测：mock 只需返回一个 `custom_tool_call`（`name: "exec"`，`input` 为 JavaScript），Codex 就会执行其中的 `tools.exec_command`、`tools.apply_patch`，并照常发出 commandExecution 和 fileChange 条目，工作量不大。直接工具路径用 `deepseek-v4-pro` 这个 slug（审查方实测：它的工具集与 `gpt-5` 完全相同，而且正是用户实际会用的模型名），不用 `gpt-5` | 6.2、6.3、7.4 的 `AG-codexd-*` |
| Q2 | 接受 AG-codex-04 / AG-claude-04 的断言修改吗 | **Claude：接受，另加 04b。** 审查方在干净环境里分别抓取了交互式 `claude` 和 `claude -p` 的请求，工具清单相同，都没有 TodoWrite 或 Task* 工具，这就是原生行为。但用户的 Claude Code 可能开启了任务工具，所以新增 AG-claude-04b：开启后，任务面板必须正常显示。**Codex：不接受"不显示任何东西"。** Codex 0.167 没有 `update_plan`，但两条路径下都有 `create_goal`、`update_goal`、`get_goal`，Codex 用"目标"来代替任务清单。AG-codex-04 改为显示目标 | F12、F19、7.4 |
| Q3 | Provider 用例的隔离 | **不用 REST 重置。** 每个 PRV / NEW 用例启动自己的服务实例，使用自己的配置副本和自己的浏览器上下文；先关闭上下文，再停服务。之前独立实例失败，根因是 WebDCC 的 Cookie 名不区分端口，同一个浏览器上下文里的两个实例会互相覆盖 Cookie。产品本身也要修这个问题（F18） | 6.2、F18 |
| Q4 | mock 的 optional 步骤 | **删除 optional。** 每个 Agent 用自己的计划变体，步骤按 6.3 的对照表解析成该 Agent 的原生工具。缺少必需的工具一律返回 500 | 6.3 |
| Q5 | 轮询式自动批准 | **可以用条件等待实现，但规则改严。** 只点击 `data-state="pending"` 的卡片，每次点击都记录工具名。每个用例结束时，实际发生的审批必须**完全等于**该 Agent 在该访问模式下的预期列表（预期列表实测后写进 protocol-notes）。多一个、少一个都算失败 | 第 7 节开头 |
| Q6 | F16 的 DSH 导入是否必须 | **必须，而且在 PR 2b 里做，不放到最后。** 用户的 DeepSeek Key 很可能就存在 DSH 里，这是 Codex 和 Claude 使用 DeepSeek 的来源，也是真实模型冒烟的来源 | F16、PRV-01 |
| Q7 | 部署时机 | **分两步。** ① 现在就把 main（已含 F1、F2、F3、F5）部署到 :80，DSH 保持关闭。M7 的生产构建里 Claude Code 根本启动不了，现在部署 main 可以让 Codex 和 Claude 先用起来。② DSHX 全部通过、PR 2b 合并后，再切换到 attach。DSH 访问链接由用户自己在 WebDCC 设置页粘贴，**不要向用户索取，也不要让用户发给你** | 9.0、9.2 |
| Q8 | `endpoints` 是否取代 `baseUrl` | **是，在 PR 2b 里完成，不留双轨。** 写数据库迁移，API 和数据库里都去掉 `baseUrl` | F16、PRV-09 |
| Q9 | 27/125 的增量推进 | **不接受原样。** PR 2a 里第 7 节的全部 ID 都必须落成测试。还没实现的，用例体里显式 `throw new Error('NOT IMPLEMENTED: <ID>')`（这算失败，不算跳过）。status.json 记录三种状态：通过、失败、未实现。棘轮规则：通过的集合和已实现的集合都只能增加，不能减少 | 6.6、第 8 节 |
| Q10 | MOB / NAT / ROB 标"待用户确认" | **不允许。** 只有 A12 的"与 DSH 截图对照"一项由用户确认，其余全部是硬验收 | 1.1 |

**PR #11 第三节"妥协"的答复：**
1. `baseUrl` 与 `endpoints` 双轨：见 Q8。
2. Codex 的 `approvalId = 进程token:请求id`：保留，这是正确的做法。
3. 流式条目在第一个增量到达时才创建：保留，但要补单测，覆盖"没有 started / block-start 事件"的情况。
4. `inject-event` 使用 `turnId='injected'`：改掉。钩子按原样写入事件（turnId 可以是 null），由用例自己构造真实形状的轮次（6.4）。
5. 只实现了 27/125 个用例：见 Q9。
6. `spawnServer` 写死了 `node` 和仓库路径：改用 `process.execPath`，仓库根目录从 `import.meta.url` 推出。审查方会在另一台机器上复跑。
7. 以 root 运行时 Claude 不能用 `bypassPermissions`：部署保持现状（用户现在就是这样运行的），但 UI 要如实反映：在 root 下这一档灰显，并写明"以 root 运行时 Claude Code 不允许此模式"（MODE-claude-01）。

**PR #11 之外，审查方新发现的问题（已并入本 v2）：**
- **Codex 原生内容被丢掉了：**
  - `thread/goal/updated`（目标）被当成 unknown；
  - `turn/plan/updated`（计划）和 `turn/diff/updated`（本轮改动）被归为 internal；
  - `warning`、`configWarning`、`deprecationNotice` 也被归为 internal。例如 Codex 会警告"模型元数据缺失，使用兜底配置，可能影响效果"，用户在终端里能看到，在网页里却看不到。

  直接工具路径下（也就是 DeepSeek）没有 `apply_patch`，文件是通过命令修改的，这时 `turn/diff/updated` 是改动卡片**唯一**的数据来源。见 F12。
- **Claude 的映射不完整：** adapter 只认 `TodoWrite`，不认 Claude Code 2.1 的 `TaskCreate` / `TaskUpdate`；计划模式下 `ExitPlanMode` 带来的计划没有显示出来。见 F19。
- **提问功能缺用例：** Codex 的 `request_user_input` 和 DSH 的提问功能都是原生功能，之前没有用例。新增 AG-codex-14、AG-dsh-14。
- **真实模型冒烟的 Key：** "环境里没有 Key"不成立。部署实例会从用户本机的配置导入（F16）；用户的 `~/.claude` 里就有真实的端点和凭据（这次泄漏事件本身就说明了这一点），DSH 也能在 attach 后直接使用。见 9.3。
- **报告没有入库：** `report.json`、`status.json` 和截图都没有提交到仓库，棘轮规则因此无从执行。见 1.1。

---

## 1. 硬性规则（违反任何一条，M8 视为未完成）

### 1.1 完成的唯一标准

1. 在干净的检出上执行 `pnpm accept:m8`，退出码为 0。"干净"指 `git clean -xfd && pnpm install --frozen-lockfile`。
2. `accept:m8` 依次执行：typecheck、lint、单测、原有的 FakeAdapter e2e（含 A10），然后把**真实界面验收套件连续完整跑 2 遍**（每遍使用全新的临时目录和全新的服务进程）。全部通过才算通过。
3. 报告由脚本生成：`docs/acceptance/M8/report.json`、`docs/acceptance/M8/status.json`、`docs/acceptance/M8/index.html`（截图总览）和 `docs/acceptance-report.md` 的 M8 一节。**这些文件连同截图都要提交到仓库。不许手写或手改任何"通过"标记。**
4. 第 7 节里的每一个用例 ID 都必须执行并通过。漏执行、跳过，或者执行了不在第 7 节里的 ID，`accept:m8` 都判失败。
5. 第 9 节的部署和真实模型冒烟已经完成。没有 Key 的部分按规则标"待真实模型验证"。
6. 最终汇报必须原样包含报告器输出的汇总行，格式为 `M8 ACCEPTANCE: <通过数>/<总数> passed ×2 @ <commit>`。没有这一行，不许宣布完成。

**交付后，审查方会在另一台机器上从干净检出重跑 `pnpm accept:m8` 复核。**

### 1.2 测试里不许做的事

- 验收套件里不许出现 `test.skip`、`test.only`、`test.fixme`、`test.fail` 或任何条件跳过；`retries` 为 0；`forbidOnly: true`。
- 真实界面验收套件里不许使用 FakeAdapter（原有的 FakeAdapter e2e 保留，作为快速测试）。`/api/meta` 每个 Agent 新增 `adapterKind: 'real' | 'fake'` 字段，套件开头断言三个 Agent 都是 `real`，并且版本等于锁定版本。
- 不许用 `waitForTimeout` 代替条件等待。只有用例本身就是要制造时间流逝的（例如断网 30 秒），才允许固定等待，并写注释说明。
- 不许用 try/catch 吞掉断言失败，不许把断言放宽（例如把"等于"改成"包含"、把"出现 1 次"改成"至少出现"）来让用例通过。
- 单个用例的超时上限是 180 秒，`expect` 的超时上限是 15 秒，不许调大。
- 断言与 Agent 的原生实际行为冲突（即本 SPEC 写错了）时，可以修改断言，但必须同时满足：
  - 在 `docs/protocol-notes.md` 里贴出原生事件原文作为证据；
  - 在 PR 描述的"修改的断言"一节逐条列出。

  **"实现太难"不是修改断言的理由。任何情况下都不许删除用例。**
- 产品代码里不许出现只为测试而走的分支。唯一的例外是 6.4 列出的测试钩子，而且它们只在 `WDCC_TEST_HOOKS=1` 时存在。

### 1.3 先红后绿

每个 F 项都分两步提交：

1. 先提交测试。在这个提交里，对应的用例必须失败。
2. 再提交修复。

PR 描述里要贴出修复前的失败输出（用例 ID 和失败原因）和修复后的通过输出。如果某个用例在修复前就能通过，说明它没测到问题，必须重写。

### 1.4 测试隔离（这台机器上正运行着用户的真实服务）

- **目录：** 验收套件用到的所有目录都放在 `$TMPDIR/wdcc-accept-<runId>/` 下，包括 `HOME`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`DSH_HOME`、`WDCC_DATA_DIR` 和工作区。**不许读写用户真实的 `~/.dsh`、`~/.codex`、`~/.claude`、`~/.webdcc`。**
- **端口：** 全部动态分配。不许使用 3080、3091、8787，以及部署实例正在使用的端口。
- **用户的 DSH：** 执行本 SPEC 的 Agent 就运行在用户 3080 端口的 DSH 里。在第 9 节之前，不许连接、停止或重启这个 DSH，也不许读写它的 `~/.dsh`。验收套件需要的"外部 DSH"一律由套件用临时 `DSH_HOME` 自己启动（见 6.2）。
- **进程：** 只能结束套件自己启动的进程，按启动时记录的 PID 结束。**不许用 `pkill`、`killall` 或任何按进程名结束进程的方式**，因为用户的 DSH 和 WebDCC 正在这台机器上运行。
- **配置哈希：** 套件开始和结束时，各记录一次用户真实配置的哈希：`~/.codex/config.toml`、`~/.claude/settings.json`，以及 `~/.dsh` 下的 profile 配置和 `.credentials.yaml`。两次必须一致（用例 FIN-04）。

### 1.5 沿用的规则

- 无人值守执行；每组改动一个 PR，squash 合并，不 force push。
- 不提交任何真实的 Key、token、Cookie 或服务器地址。测试用的假 Key 一律以 `sk-wdcc-test-` 开头。
- **停止条件：** 同一个用例经过 3 轮针对性修复仍然失败，并且没有其他可以先推进的独立工作时，停在当前分支，把失败的用例、证据和你的判断写进 `docs/progress.md`，然后结束。

### 1.6 立刻要做的三件事（PR 2a 的第一批提交，在任何新功能之前）

1. **清理泄漏的真实凭据副本。** 之前的 fake e2e 没有隔离家目录，F16 把用户真实的 `~/.claude` 端点和凭据导入了测试实例，所以测试数据目录里的 `secrets.json` 存着真实 Key。
   - 删除 `/tmp/wdcc-e2e*`、所有 `wdcc-*` 临时目录、`test-results/`、`playwright-report/` 和所有 trace 文件。
   - 写一个只在本机运行的脚本：从用户真实配置里读出 Key 和端点主机名（**不许打印**），在以下位置搜索，**只输出命中的次数**：git 历史（所有分支，`git log -p --all`）、当前工作区、`/tmp`。
   - 审查方已经扫描了公开仓库的所有分支，没有发现 `sk-` 开头的真实 Key，也没有非本地的地址，但仍然要以本机扫描的结果为准。
   - 命中次数都是 0：在 progress.md 里写一行"已清理，扫描命中 0"。只要有一处命中 git 历史：**停下来报告**，用户需要更换这个 Key。
2. **统一隔离，加启动守卫。**
   - 所有会启动服务端的测试入口（单测、fake e2e 的 `e2e-server.ts`、真实套件、`spawnServer`）都使用同一个 `isolatedEnv()`，同时隔离 `HOME`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`DSH_HOME`。现在的 fake e2e 漏掉了 `DSH_HOME`，等 F16 的 DSH 导入做完，它就会读到用户真实的 `~/.dsh`。
   - 服务端在 `WDCC_TEST_HOOKS=1` 时，启动前先检查这四个目录是否落在运行用户的真实家目录里。真实家目录从系统用户数据库读取（`os.userInfo().homedir`），不依赖 `HOME` 环境变量。落在里面就拒绝启动（用例 S-04）。
3. **打开 main 的分支保护。** 用 `gh api` 设置：必须通过 PR 合并、禁止直接推送、禁止 force push、禁止删除分支，并且 `enforce_admins=true`。以后误推到 main 会被 GitHub 直接拒绝。

---

## 2. 决定 D1：DSH 的运行方式——连接用户已经在运行的 DSH

### 2.1 背景与约束

- **执行本 SPEC 的 Agent 就运行在用户 3080 端口的 DSH 里。** 停掉或重启这个 DSH，执行就会中断。因此，用户的 DSH、WebDCC，以及 WebDCC 里的 DSH、Codex、Claude Code，必须能够同时运行。
- **同一个 `~/.dsh` 只能有一个 DSH 进程。** DSH 的 `dsh-storage-json` 会把 `storages/workspace.json` 整个读进内存，每次改动再把整个文件写回；代码注释写明它假定"每个文件只有一个进程在写，最后写入的为准"。如果两个进程同时运行，它们会互相覆盖工作区、归档和置顶的数据。原先"WebDCC 自己拉起一个侧车、和用户的 DSH 共用 `~/.dsh`"的做法因此不可行。

### 2.2 做法：attach 模式

WebDCC 不再拉起自己的 DSH，而是作为一个客户端，连接到用户已经在运行的 DSH Web Host。这样只有一个 DSH 进程，DSH 原版界面和 WebDCC 是它的两个客户端。

DSH 0.2.2-rc.1 本身就支持这种接入方式，下面几点是审查时读 DSH 源码（`dsh-client-connection`、`dsh-api-gateway`）确认的：
- **API 客户端接入：** 用启动 token 访问 `GET /connect?token=<启动 token>&interactions=answer`，DSH 会创建一个独立的 API operator，并返回签名 Cookie，再重定向到 `./api/remote.mux`。`interactions` 可以取 `answer`（这个客户端负责回答审批和提问）或 `none`。
- **启动 token：** 每次启动 `dsh web` 都会重新生成（实测：同一个 `DSH_HOME` 启动两次，得到的 token 不同）。
- **Cookie 的有效期：** Cookie 由 `.credentials.yaml` 里持久保存的 `client-connection/browser-session` 密钥签名，有效期按天计算，所以有可能在 DSH 重启后仍然有效。operator 在 DSH 重启后能否恢复，需要实测（【M8 核实】）。
- **审批的回答方：** 只有 owner 身份的 Peer 能回答审批；`$events/result` 必须由收到该事件的那个 Peer 回复。

### 2.3 需要实现的内容

**配置**
- `WDCC_DSH_MODE=attach|spawn`。生产环境用 `attach`。
- `WDCC_DSH_URL=http://127.0.0.1:3080`：DSH 的基础地址，不带 token。

**连接**
- WebDCC 设置页新增"DSH 连接"一节，显示连接状态和 DSH 版本，并提供输入框"粘贴 DSH 的访问链接（`http://127.0.0.1:3080/?token=…`）"。
- 用户粘贴链接后，WebDCC 用链接里的 token 调用 `/connect?interactions=answer`。拿到的 operator Cookie 保存进 `secrets.json`；token 本身不保存，也不写进日志。
- 连接断开后，按指数退避自动重连，重连时使用保存的 Cookie。如果 Cookie 被拒绝，设置页和新会话页的 DSH 卡片都显示"需要重新连接 DSH：请粘贴 DSH 当前的访问链接"，此时其他 Agent 不受影响。

**绝不触碰别人的会话**
- WebDCC 只处理自己创建的 DSH 会话（数据库里有记录的那些）。
- 对其他会话的审批和提问（例如执行本 SPEC 的 Agent 自己的会话），WebDCC **不回复、不取消、不显示**。
- 打断、回收、关闭 WebDCC 自己的会话时，只取消这个会话自己挂起的审批。
- 如果实测发现 DSH 的审批是依次分发给各个回答方的（必须有人回复"跳过"才会传给下一个客户端），在 `protocol-notes.md` 里记录证据，并改用 DSH 规定的"跳过"方式回复别人会话的审批。无论哪种情况，都必须保证用户能在原版界面里正常回答这些审批（用例 DSHX-01）。

**不改 DSH 的全局状态**
- WebDCC 不调用任何会改变 DSH 全局设置的接口。
- 【M8 核实】`/permission <preset>`（`commands/execute`，参数 `agentId` 为会话 id）只影响这一个会话，而不是改变 DSH 的全局默认设置。如果它会改全局设置，就不能用这种方式切换 DSH 的访问模式，在 `protocol-notes.md` 里记录，并按停止条件停下来报告。

**生命周期**
- attach 模式下，WebDCC 不启动、不停止、不重启 DSH 进程。DSH 不可用时，DSH 卡片灰显并写明原因。

**spawn 模式**
- 保留 spawn 模式，供服务器上没有运行 DSH 的情况使用，以及在测试中使用。
- spawn 模式拉起侧车之前，先检查同一用户下有没有其他 `dsh` 进程在使用同一个 `DSH_HOME`（读取 `/proc/<pid>/environ` 和命令行；没有设置 `DSH_HOME` 的视为 `~/.dsh`）。如果有，拒绝启动侧车，并在界面上写明原因"检测到已有 DSH 在使用 `<路径>`，请改用 attach 模式"。

**原版界面链接**
- 设置页的"打开 DSH 原版界面"直接链接到 `WDCC_DSH_URL`。用户的浏览器本来就有 DSH 的 Cookie，所以不需要带 token。

**需要核实：** 终端版的 `dsh`（不是 `dsh web`）是否也是一个独立的 DSH 进程、是否同样会覆盖注册表。结果写进 `protocol-notes.md`；如果会覆盖，在 deploy.md 里写明"不要在已经运行 `dsh web` 的同时，在同一个 `~/.dsh` 上运行终端版 `dsh`"。

**不在 M8 范围内：** 在 DSH 原版界面里新建的会话不会出现在 WebDCC 的侧边栏里，反过来，WebDCC 建的会话会出现在原版界面里（这是同一个 DSH 的正常现象）。

**配套修复：** F17。

**用例：** 7.13 的 `DSHX-*`、AG-dsh-13、NET-05。

---

## 3. P0 修复

### F1 生产构建里 Claude Code 无法启动

- **现象：** 新建 Claude Code 会话时报错 `Native CLI binary for linux-x64 not found ...`。
- **原因：** `scripts/build-server.ts` 把 `@anthropic-ai/claude-agent-sdk` 打包进了 `dist/main.js`。SDK 用 `createRequire(import.meta.url)` 查找平台包 `@anthropic-ai/claude-agent-sdk-linux-x64`，打包后变成从 `packages/server/dist/` 开始查找，而 pnpm 只把平台包链接在 SDK 自己的 `node_modules` 下面，所以找不到。`accept-claude-a1.ts` 跑的是源码，所以一直没有暴露。
- **修法：**
  - 在 `external` 里加上 `@anthropic-ai/claude-agent-sdk`，并让 `@webdcc/server` 直接依赖它。
  - 检查打包产物里有没有其他带平台子包或原生二进制的依赖被打包进去了。
  - **新建会话失败时不许留下孤儿记录**（审查时留下了两条 `native_id` 为空的会话）。二选一：失败就回滚；或者保留记录，在侧边栏标"出错"并写明原因（C8）。选了哪种写进 SPEC。
- **用例：** S-01、`AG-claude-*`、NEW-05。

### F2 DSH 会话整页崩溃

- **现象：** DSH 的一轮里只要调用了 `todo_write`，整个应用就显示 "Something went wrong!"（错误为 `Cannot read properties of undefined (reading 'filter')`），刷新后依然如此，侧边栏也一起消失。
- **原因：**
  1. `packages/adapters/dsh/src/adapter.ts` 的 `toolKind('todo_write')` 返回 `'plan'`，但生成的数据是 tool.call 的形状 `{name, input, status, output}`。
  2. `Timeline.tsx` 渲染 plan 时直接调用 `data.items.filter`。
  3. 整个前端没有错误边界。
- **修法：**
  1. `todo_write` 的工具调用映射为 `tool.call`。任务清单只由 `todo/write` 事件生成。
  2. `@webdcc/protocol` 为每种 kind 提供数据校验函数。adapter 发出事件前先校验，不合格的降级为 `unknown` 并保留 `native`；前端渲染前再校验一次，不合格的显示"这条内容无法显示 · 在轨迹中查看"。
  3. 加错误边界：每个时间线条目一层、主栏一层、停靠区一层。侧边栏永远不受会话内容的影响。
- **用例：** AG-dsh-04、ROB-01。

### F3 选的模型没有传给 Agent

- **现象：** 数据库里所有会话的 `model` 都是 NULL。用自定义 Provider 时，Codex 会话显示"GPT-5"，Claude 会话显示"默认模型"。接 DeepSeek 时，Agent 会把它自己的默认模型名发给 DeepSeek。
- **原因：** `NewSession.tsx` 里 `model` 的初始值是 `''`，`<select>` 又没有空选项，所以界面上显示的是第一个模型，但不会触发 `onChange`。Provider 只有一个模型时，用户根本没办法选中它。
- **修法：**
  - 选中 Provider 时，把 `model` 设为默认模型（按 F16 规定的默认值；没有就用第一个）。
  - 服务端 `POST /api/sessions`：非原生 Provider 没有带 `model` 时返回 400。
  - 输入框显示会话实际使用的模型。
- **用例：** NEW-02、NEW-03、`AG-*-12`。

---

## 4. P1 修复与补齐

### F4 轮次分组

- **现象：**
  - Codex 的每个会话都多出一个"运行中…"（M2 存档的 `mobile-dock.png` 里就有）。
  - DSH 运行中，用户自己发的消息气泡消失。
  - 底部的"N 轮"多算了。
- **原因：**
  - `manager.ts` 在没有当前轮次时，给每个事件分配一个新的 `ulid()`。
  - `turnId: event.turnId ?? turnId` 让原生的 turn id 优先，与旁边的注释正好相反。
  - `store.ts` 的 `getTurns()` 把没有 turnId 的流式条目归进 `'live'` 组。
  - `Timeline.tsx` 把任何没有 `turn.completed` 的组都显示成运行中。
- **修法：**
  - 服务端的 turnId 一律以 `send()` 分配的为准，原生 id 只保留在 `native` 里。
  - 轮次之外的事件 turnId 为 `null`，不构成一轮（internal 事件只进轨迹）。
  - 流式帧必须带 turnId。
  - 只有出现过 `turn.started` 且还没有 `turn.completed` 的组，才显示"运行中"。
  - "N 轮"只统计包含 `user.message` 的组。
  - 查清 DSH 用户气泡消失的具体原因，一并修好。
- **用例：** `AG-*-07`、`AG-*-10`、NET-02。

### F5 新会话显示成 DSH

- **原因：** `packages/web/src/lib/store.ts` 处理 `feed` 时，新条目的 `agent` 被写死为 `'dsh'`，忽略了 `patch.agent`。
- **修法：** 从 patch 中读取 `agent`、`workspaceId`、`createdAt`。所有按 Agent 区分的界面（标识、访问模式、`/` 菜单）都以会话记录里的 `agent` 为准。
- **用例：** `AG-*-01`、NET-05。

### F6 访问模式切换

- **现象：** 访问模式菜单点了只会关闭菜单（`Composer.tsx` 里的注释写着"访问模式切换在 M6 接入"）。Codex 的三项决定都没有实现：#1 从 `permissionProfile/list` 动态读取可选模式；#4 显示实际生效的模式；在 `turn/start` 里带上 `sandboxPolicy`。
- **修法：**
  - DSH：用 `commands/execute` 执行 `/permission <preset>`。
  - Claude Code：用 `setPermissionMode`。
  - Codex：在下一次 `turn/start` 里带上 `approvalPolicy` 和 `sandboxPolicy`；可选模式来自 `permissionProfile/list`；按钮上显示 Codex 回报的实际生效模式。
  - 每次切换都记为一个事件，在轨迹里可以看到。
- **用例：** `MODE-*`。

### F7 附件（C3）

- **现象：** 只能添加图片，而且只有 DSH 收得到：Codex 的 `buildTurnStartParams` 只发送文字，Claude 根本没有处理图片。"其他文件"没有实现。DSH 的图片格式没有核实。
- **修法：** 按 C3 实现：
  - Codex：`{type:'localImage', path}`。
  - Claude Code：base64 的 image block。
  - DSH：先核实 `session/prompt` 的 content 支持什么格式；不支持图片的话，按"其他文件"处理。
  - 其他文件：复制到 `<工作区>/.webdcc/uploads/<fileId>-<原文件名>`，把相对路径插入输入框；工作区是 git 仓库时，把 `.webdcc/` 写进 `.git/info/exclude`；单个文件上限 100 MB。
  - 核实结果写进 `protocol-notes.md`。
- **用例：** `ATT-*`。

### F8 斜杠命令（C4）

- **修法：** 按 C4 实现：
  - Claude Code：`/` 菜单的内容来自 init 消息里的 slash commands；用户选中后发送时，作为普通用户消息原样交给 SDK。
  - DSH：`/` 菜单的内容来自 DSH 的命令目录；消息的第一行是已知命令时，用 `commands/execute` 执行，不走 `session/prompt`。
  - Codex：不提供 `/` 菜单，用户输入的文字原样发送。
  - 端点白名单按 C4 修改。
- **用例：** `SL-*`。

### F9 窄屏布局（SPEC 9.12，以及 SPEC.md 第 662 行）

- **现象：** `index.css` 在宽度 ≤1024px 时直接 `.sidebar{display:none}`：没有抽屉，也没有窄栏，手机上无法切换会话；停靠区在手机上也不显示。
- **修法：**
  - 宽度 ≥768px：侧边栏收起后保留 56px 的窄栏。
  - 宽度 <768px：侧边栏变成抽屉，由会话头左侧的按钮打开。
  - 宽度 <1024px：侧边栏默认收起。
  - 手机上停靠区全屏打开，左上角有返回按钮。
- **用例：** `MOB-*`、DOCK-02。

### F10 改动卡片永远显示"0 个文件"（C2）

- **原因：** DSH 和 Claude Code 的 `file.change` 事件都发的是 `changes: []`。
- **修法：** 按 C2 的三级优先级取改动：
  1. 原生提供的 diff；
  2. `edit` 类调用，用 `old_string` / `new_string` 生成该处的 hunk；
  3. 整文件写入，按新文件计算，并注明"整文件写入，未取得原内容"。

  另外核实 DSH 的 `tool/result` 里是否带 diff 数据。
- **用例：** `AG-*-03`。

### F11 审批卡片显示原始 JSON

- **修法：** 对照 `docs/reference/dsh/` 里的审批截图：
  - 标题：工具名，加上命令（等宽字体）或文件路径。
  - 原因：DSH 取 `displayReason.zh`，没有时取 `reason`。
  - 按钮：用原生选项的文字。
  - 原始 JSON 放进可折叠的"详情"里。
  - 处理后显示"已允许一次""已拒绝""已取消"或"已在其他界面处理"，不显示 optionId。
  - 审批选项本身不做任何改动（R6）。
- **用例：** `AG-*-05`、`AG-*-06`。

### F12 Codex 事件映射

- **现象：** 对话里出现了"工具 · userMessage""未知事件 · item/reasoning/summaryPartAdded"和内容为空的"思考"卡片；`usage` 是 `{}`；`turn.started` 的 itemKey 是 `turn-unknown`。
- **修法：**
  - `userMessage` 条目归为 internal，因为我们已经有自己的 `user.message`。
  - `item/reasoning/summaryPartAdded` 是 Codex 已知的通知，应该并入 reasoning，不应该算作 unknown。
  - 对照导出的 schema，把 Codex 所有的 ServerNotification 方法都显式归类（映射成某种 kind，或者归为 internal）。新增单测：遍历 schema 里的全部方法，断言每一个都有显式归类。unknown 只留给 schema 之外真正未知的事件。A11 不变：unknown 仍然以卡片的形式出现在时间线里。
  - 空的 reasoning 不显示。
  - `usage` 从 `thread/tokenUsage/updated` 读取。
  - turnId 的处理与 F4 一起改。
  - **归类原则：原生界面会显示给用户的内容，WebDCC 也必须显示，不许归为 internal。** 具体包括：
    - `thread/goal/updated` / `thread/goal/cleared`：会话的"目标"面板，显示目标内容和状态（AG-codex-04）。
    - `turn/plan/updated`：任务面板，与 DSH 的任务清单使用同一个组件。`item/plan/*`（计划模式产生的计划条目）：计划卡片，以 Markdown 显示。这两项用单测加夹具覆盖，因为本版 Codex 默认配置下不会产生它们。
    - `turn/diff/updated`：本轮改动卡片的第一数据来源（C2 第 1 级）。直接工具路径下没有 `apply_patch`，文件是通过命令修改的，只能靠它得到改动（AG-codexd-03）。
    - `warning`、`configWarning`、`deprecationNotice`：显示为提示卡片。例如模型元数据缺失时 Codex 发出的"使用兜底元数据，可能影响效果"。
  - **code mode：** 模型通过 `exec`（JavaScript）调用嵌套工具时，Codex 照常发出 commandExecution 和 fileChange 条目，WebDCC 照常显示。`exec` 本身如果作为条目出现，显示为"脚本"步骤，可以展开查看源码。
- **用例：** AG-codex-04、AG-codex-13、`AG-codexd-*`、ROB-04。

### F14 Codex 的模型目录

- **现象：** 在界面里跑 Codex 时，假模型报 `plan wants a tool but request has no matching tool command`。A1 脚本之所以能通过，是因为它把模型固定成了 `model="gpt-5"`。
- **修法：**
  - 验收环境里，Codex 的模型按 6.2 设置：code mode 路径用 `model/list` 里的 slug，直接工具路径用 `deepseek-v4-pro`。
  - `model_catalog_json` 的说明：如果用户自己的 Codex 配置里引用了模型目录文件，F16 导入时照样带上，这属于用户的原生配置，不违反 R1。R1 禁止的是 WebDCC 自己编写目录或提示词内容。
  - 非 OpenAI 模型的 Provider 如果没有填模型目录路径，在新会话页的 Codex 选项旁提示"需要模型目录，否则工具可能不可用"。
  - 实测"模型 slug 不在目录里时，Codex 会给模型哪些工具"，写进 `protocol-notes.md`。
- **用例：** PRV-08。

### F15 其他

- 停靠区的会话标签显示 Agent 标识和会话标题。
- 对照 `docs/reference/dsh/` 打磨界面（字体、图标、间距）。放在最后做，不阻塞其他项。

### F16 本机已有的 Provider 自动导入（新需求）

**背景：** 用户已经在各 Agent 里配好了 Provider，但 WebDCC 的 Provider 列表是空的，要再手动录入一遍。"原生配置"也看不出实际用的是哪个 Provider、哪个模型。原因是 SPEC 10.1 把原生配置当成黑盒，10.4 又禁止调用 DSH 的 Provider 接口，这是把 R3（不**改**用户配置）执行过了头。只读地读取配置并复制一份，不违反 R3。

**读取来源**（读的是 WebDCC 所在机器上、服务运行用户能看到的配置）：

**Codex**
- 用 `codex app-server` 的 `config/read` 读取，不要自己解析 TOML。
- 【已实测 0.167.0】`config/read` 返回合并后的生效配置，包括：
  - 顶层的 `model`、`model_provider`；
  - `model_providers.<id>`：`name`、`base_url`、`wire_api`、`env_key`、`experimental_bearer_token`、`http_headers`、`env_http_headers`、`query_params`、`requires_openai_auth` 等；
  - `profiles.<name>`：`model_provider`、`model`、`model_catalog_json`；
  - `origins`：每个值来自哪一层配置。
- `requires_openai_auth: true` 的 provider 不导入，它就是"原生：ChatGPT 登录"。
- **Key：** 有 `experimental_bearer_token` 就复制它。只有 `env_key` 时，WebDCC 进程的环境里有这个变量就复制它的值；没有就照样导入，标"缺少 Key（本机配置读取环境变量 X）"。
- **模型：** 收集顶层和各 profile 中指向这个 provider 的 `model`。`model_catalog_json` 填进 `codexCatalogPath`。
- `http_headers` 和 `query_params` 原样保留，注入时用 `-c` 一并传入（扩展 10.3）。

**Claude Code**
- 读设置文件的 `env` 段：设置了 `CLAUDE_CONFIG_DIR` 时读 `$CLAUDE_CONFIG_DIR/settings.json`，否则读 `~/.claude/settings.json`。WebDCC 进程环境里的同名变量也要读。
- 要读的变量：`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL`。
- 没有 `ANTHROPIC_BASE_URL` 时不导入，那就是"原生：Claude 登录"。
- 用 `apiKeyHelper` 取 Key 的，照样导入，标"缺少 Key（本机用 apiKeyHelper）"。
- **注意覆盖顺序：** `settings.json` 的 `env` 可能会覆盖 SDK `options.env` 里注入的值，导致用户在 WebDCC 里选了别的 Provider，实际却仍然发到 `settings.json` 里的端点（用例 NEW-07 会测出来）。如果发生这种情况，改用 Claude Code 的命令行设置层（`--settings`，优先级高于用户设置）来注入，不许修改 `settings.json`。核实结果写进 `protocol-notes.md`。

**DSH**
- 【M8 核实】Web Host 提供 `llm/listProviders`、`llm/listConfigurableProviders`、`settings/describe`、`credentials/describe`。先用这些接口读取地址、模型和 Key 的引用。RPC 拿不到 Key 原文时，只读地读取 DSH 当前 profile 的配置和 `.credentials.yaml`。读取方式写进 `protocol-notes.md`。
- 导入 DeepSeek 官方 Provider 时，同时填上两种协议的地址：Responses 用 `https://api.deepseek.com/`，Anthropic 用 `https://api.deepseek.com/anthropic`。
- DSH 会话本身仍然使用 DSH 自己设置里的 Provider（10.4 不变）。
- **按凭据类型区分：**
  - DSH 里保存的 API Key（`dsh-llm-deepseek-api-key`）：复制。
  - DSH 用 DeepSeek **账号登录**得到的凭据（`dsh-llm-deepseek-account`）：不复制。它属于 DSH 的登录，标"DSH 使用账号登录，不能给其他 Agent 使用"。
  - DSH 从环境变量读取的 Key：WebDCC 进程的环境里有这个变量就复制，没有就标"缺少 Key（DSH 从环境变量 X 读取）"。
- 读取方式和这三种情况都写进 `protocol-notes.md`，各配一个单测夹具。

**粘贴导入**
- Provider 页可以粘贴 Codex 的 `config.toml` 片段或 Claude 的 `settings.json` 片段，按上面同样的规则解析。
- 粘贴的原文只用于解析，不保存。

**数据模型（修改 10.1）**
- Provider 新增 `source` 字段：取值为 `manual`、`codex-config`、`claude-settings`、`dsh`、`paste` 之一，并记录来源里的标识（例如 Codex 的 provider id）。
- 单个的 `baseUrl` 改为 `endpoints`，按协议分别记录地址：`{ 'openai-responses'?: url, 'anthropic-messages'?: url }`。
- **不留双轨：** 在 PR 2b 里写数据库迁移，把已有记录的 `baseUrl` 按它声明的协议转成 `endpoints`，然后从 API 和数据库中删除 `baseUrl`（用例 PRV-09）。

**导入规则**
- **时机：** 服务启动时自动扫描一次，打开 Provider 页时再扫描一次，另外提供"重新扫描"按钮。新发现的 Provider 直接导入，不弹确认框；页面顶部提示"从本机导入了 N 个 Provider"。
- **去重：** 协议地址相同（规范化时去掉末尾的 `/`）并且 Key 的哈希相同，就视为同一个 Provider，合并来源和模型。
- **只复制，不写回：**
  - 在 WebDCC 里修改 Provider，不会写回任何 Agent 的配置。
  - 本机配置后来变了，在对应的 Provider 上提示"本机配置已变化"，提供"更新"和"忽略"。
  - 用户在 WebDCC 里改过的字段，不会被自动覆盖。
- **删除：** 删除导入的 Provider 后，记住它的来源标识，以后扫描不再导入它。提供"恢复已忽略的导入"。
- **Key 的显示：** 只显示来源（例如"来自 Codex 配置 · 环境变量 DEEPSEEK_API_KEY"）和后 4 位，API 不返回原文。

**新会话页**
- **默认选择与本机一致：** 例如 Codex 配置里 `model_provider = "deepseek"`、`model = "deepseek-v4-pro"`，就默认选中导入的"DeepSeek"和"deepseek-v4-pro"。
- **原生选项写清楚：** 写成"原生：ChatGPT 登录""原生：Claude 登录""DSH 自己的设置"。未登录时灰显，并写明原因。
- **DSH 的模型下拉框：** 列出 `session/modelCatalog` 返回的模型，默认选中 DSH 当前使用的模型。
- **兼容规则沿用 10.2：** 只列出具备该 Agent 所需协议地址的 Provider。DSH 卡片下，不是来自 DSH 的 Provider 灰显，注明"DSH 使用自己设置里的 Provider"。

**白名单：** 把 DSH 的读取类端点加入 5.4.8 的白名单和 3.3 的机器检查。写入类端点仍然禁止调用。

**用例：** `PRV-*`、NEW-02、NEW-06、NEW-07。

### F17 在另一个界面处理的审批和提问要同步

- **原因：** dsh adapter 把 `approval/decided` 列在 `INTERNAL_EVENTS` 里，直接忽略了。在 DSH 原版界面里批准之后，WebDCC 的卡片和侧边栏一直显示"待批准"。
- **修法：**
  - 收到 `approval/decided`（提问对应的已回答事件以实测为准），并且该审批在 WebDCC 里还在等待时，发出 `approval.resolved`。`by` 新增取值 `'other'`。
  - 卡片显示"已在其他界面处理：已允许一次 / 已拒绝"。
  - 此后不再发送 `$events/result`。如果两边几乎同时操作，导致 DSH 返回错误，也按"已处理"显示，不报错。
- **用例：** AG-dsh-13、NET-05。

### F18 同一台机器上多个实例的 Cookie 互相覆盖

- **原因：** WebDCC 的 Cookie 名是固定的，而浏览器的 Cookie 不区分端口，所以同一主机上不同端口的两个实例会互相覆盖 Cookie，导致 WebSocket 鉴权失败。PR #11 的问题 1 中"独立实例方案失败"就是这个原因。
- **修法：** Cookie 名由请求的 Host（含端口）派生，做法与 DSH 的 `cookieName(authority)` 相同。旧名称的 Cookie 在过渡期内仍然接受，并换发新名称的 Cookie。
- **用例：** AUTH-05。

### F19 Claude Code 的任务、计划模式和工具搜索

- **任务：** `TaskCreate`、`TaskUpdate`、`TaskList`、`TaskGet`（Claude Code 2.1）和 `TodoWrite`（旧版本）都映射到任务面板。按会话维护任务列表：根据创建和更新调用，以及它们的工具结果计算当前状态。用例 AG-claude-04b。
- **计划模式：** 访问模式选"计划模式"（permissionMode `plan`）时，Claude 用 `ExitPlanMode` 提交计划。审批卡片要把计划以 Markdown 完整显示，按钮用原生选项。批准后的模式变化以 SDK 回报的为准。用例 AG-claude-15。
- **工具搜索：** Claude Code 2.1 的很多工具是延迟加载的，模型先调用 `ToolSearch`，再调用加载出来的工具（例如 `WebFetch`）。两者都显示为普通的工具步骤，`ToolSearch` 的卡片写明加载了哪些工具。用例 AG-claude-16。

---

## 5. 同步修改 SPEC.md

在相应的 PR 里一并修改：

- R3：补一句"允许只读读取各 Agent 的配置和凭据，用于导入 Provider；任何情况下都不写回"。
- 10.1：Provider 增加 `source` 字段，`baseUrl` 改为 `endpoints`。
- 10.3：Codex 注入时带上 `http_headers` 和 `query_params`。
- 10.4：允许调用 DSH 的读取类端点。
- 5.4.8 和 3.3：白名单（F8、F16）。
- 5.4.9：按 D1 改写，增加 attach 和 spawn 两种模式、spawn 模式的冲突检查，以及"只处理自己创建的会话"这条规则。
- 12.2：新增配置项 `WDCC_DSH_MODE`、`WDCC_DSH_URL`。
- 6.1：`approval.resolved.by` 增加 `'other'`。
- 11.1 和认证一节：Cookie 名按 Host（含端口）派生（F18）。
- 第 7 节新增的工具映射（F12、F19）写进 6.1 的映射表。
- C8：F1 中会话创建失败时的处理方式。
- 第 15 节：M7 门槛里"本机按生产方式运行"一项，以后只能以本文件的验收套件为证据。

---

## 6. 验收套件

### 6.1 入口

`pnpm accept:m8` 依次执行以下步骤，任何一步失败，退出码都不为 0：

1. typecheck、lint、单测、原有的 FakeAdapter e2e。
2. `pnpm build`。
3. 检查测试隔离（1.4），记录用户真实配置的哈希。
4. 运行 `playwright test -c playwright.real.config.ts`（第 1 遍）。
5. 用全新的临时目录和全新的服务进程，再运行一遍（第 2 遍）。
6. 生成报告（6.6），比对真实配置的哈希。

另外提供 `pnpm accept:m8 --ratchet`，供开发过程中的 PR 使用（见第 8 节）。

### 6.2 环境（globalSetup）

**工作区 fixture**
- 路径为 `ws/sample-repo`。执行 `git init`，放入 `README.md`（至少 5 行）、`SPEC.md`、`src/hello.ts`、`AGENTS.md` 和 `CLAUDE.md`，然后做一次初始提交。
- `AGENTS.md` 和 `CLAUDE.md` 里各写一句带唯一标记的约定，例如 `WDCC-AGENTS-MARKER-<runId>`，供 NAT 用例检查。
- 每个用例开始前执行 `git reset --hard && git clean -xfd`，把工作区恢复原样。

**本机配置 fixture**（它同时是 F16 的导入来源和各 Agent 的"原生配置"）

`CODEX_HOME/config.toml`：

```toml
model = "<SLUG_A>"
model_provider = "mockr"

[model_providers.mockr]
name = "Mock Responses"
base_url = "http://127.0.0.1:<P_RESP>/v1"
wire_api = "responses"
env_key = "WDCC_TEST_MOCKR_KEY"

[model_providers.mockr2]
name = "Mock Responses 2"
base_url = "http://127.0.0.1:<P_RESP>/v2"
wire_api = "responses"
env_key = "WDCC_TEST_MOCKR2_KEY_MISSING"

[profiles.alt]
model_provider = "mockr"
model = "<SLUG_B>"

[profiles.ds]
model_provider = "mockr"
model = "deepseek-v4-pro"
```

- **`<SLUG_A>`、`<SLUG_B>`（code mode 路径）：** Codex 0.167.0 `model/list` 返回的两个 slug，例如 `gpt-6-sol`。审查方实测，列表里的模型全部走 code mode：
  - 请求里的 `tools` 为空；
  - 工具放在 `input[]` 的 `additional_tools` 中，以 `functions` 命名空间下的自定义工具 `exec` 的形式提供；
  - 模型写 JavaScript，调用 `tools.exec_command`、`tools.apply_patch`、`tools.create_goal` 等嵌套工具。

  这是用户用 GPT 模型（ChatGPT 登录）时 Codex 的真实路径。
- **`deepseek-v4-pro`（直接工具路径）：** 不在 Codex 目录里，Codex 使用兜底元数据，并警告"可能影响效果"。工具为 `exec_command`、`write_stdin`、`view_image`、`request_user_input`、`create_goal`、`update_goal`、`get_goal`、`web_search`、`multi_agent_v1`，没有 `apply_patch`，也没有 `update_plan`。审查方实测，这个工具集与 `gpt-5` 完全相同。这是用户通过 Codex 使用 DeepSeek 时的真实路径。
- 实际选用的 slug 和抓到的工具清单写进 `protocol-notes.md`。
- **独立实例：** PRV 和 NEW 用例各自启动服务实例。每个实例使用复制出来的 `CODEX_HOME` 和 `CLAUDE_CONFIG_DIR`、独立的数据目录，以及独立的浏览器上下文。用例结束时先关闭浏览器上下文，再停止服务实例（见 F18）。
- mock-responses 同时接受 `/v1` 和 `/v2` 两个前缀。

`CLAUDE_CONFIG_DIR/settings.json` 的 `env` 段：
- `ANTHROPIC_BASE_URL=http://127.0.0.1:<P_ANTH_CLAUDE>`
- `ANTHROPIC_AUTH_TOKEN=sk-wdcc-test-claude-<runId>`
- `ANTHROPIC_MODEL=mock-claude-a`

DSH（模拟用户自己在运行的那个 DSH）：
- 套件自己用临时的 `DSH_HOME` 启动一个 `dsh web --no-open --port <P_DSH>`，称为"外部 DSH"，并从它的 stdout 读取启动链接。
- 外部 DSH 通过 `DEEPSEEK_BASE_URL=http://127.0.0.1:<P_ANTH_DSH>` 和 `DEEPSEEK_API_KEY=sk-wdcc-test-dsh-<runId>` 指向 mock（SPEC 10.4 允许在测试中这样做）。
- 套件准备环境时，再通过外部 DSH 自己的设置界面或 RPC，往它的凭据存储里保存一个 Key `sk-wdcc-test-dshcred-<runId>`，用来覆盖 F16 读取"DSH 保存的 Key"这条路径（PRV-01）。只操作临时的外部 DSH。
- 主服务实例以 attach 模式连接外部 DSH（`WDCC_DSH_MODE=attach`、`WDCC_DSH_URL=http://127.0.0.1:<P_DSH>`）。套件在设置页粘贴启动链接，完成首次连接，这一步本身也是用例 DSHX-00。
- 套件用浏览器打开外部 DSH 的原版界面（启动链接），在里面创建一个"外部会话"，代表用户自己（以及执行本 SPEC 的 Agent）在 DSH 里的会话。DSHX 用例围绕这个会话检查 WebDCC 不会干扰它。
- spawn 模式只在 DSHX-06、DSHX-07 中，用单独的服务实例测试。

**假模型：** 启动 3 个实例，分别是 mock-responses（给 Codex）、mock-anthropic（给 Claude Code）、mock-anthropic（给 DSH）。分开启动，方便分别断言各自收到的请求。

**服务端**
- 启动命令：`node packages/server/dist/main.js`。
- 环境变量：
  - 目录：`HOME`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`DSH_HOME`、`WDCC_DATA_DIR` 全部指向临时目录。
  - 端口：`WDCC_HOST=127.0.0.1`；`WDCC_PORT` 动态分配。
  - DSH：`WDCC_DSH_MODE=attach`，`WDCC_DSH_URL` 指向下面的"外部 DSH"。
  - 其他：`WDCC_TOKEN` 随机生成；`WDCC_TEST_HOOKS=1`；`WDCC_TEST_MOCKR_KEY=sk-wdcc-test-mockr-<runId>`；上面列出的 DSH 环境变量。
- `PATH` 里只放锁定版本的 `codex`、`claude`、`dsh`。
- stdout 和 stderr 写入 `run/server.log`。

### 6.3 假模型需要扩展的能力

- **请求记录：**
  - `GET /__requests` 按顺序返回收到的全部请求，包括路径、请求头（测试 Key 原样保留）和请求体。
  - `POST /__reset` 清空记录。
- **指定计划：** `POST /__plan {name}` 选用 `plans/<name>.json`。每个用例开始时都要设定一次。
- **模板变量：** 回答文本里支持以下变量，由 mock 根据收到的请求计算后填入：
  - `{{userMessageCount}}`：历史用户消息条数；
  - `{{imageCount}}`：图片块的数量；
  - `{{model}}`：请求里的模型名。
- **辅助请求：** 完全没有 tools 的请求（例如生成标题）返回一段固定的短文本，不推进计划。
- **工具不匹配：** 计划步骤需要的工具在请求里找不到时，返回 **HTTP 500**，并在 `/__requests` 里标记。不允许悄悄结束这一轮。**计划里不许有 optional 步骤。**
- **Codex code mode：** 如果请求的 `input` 里有 `additional_tools`，并且其中包含 `functions` 命名空间下的 `exec`，mock 就用一个 `custom_tool_call`（`name: "exec"`，`input` 为 JavaScript 源码）完成这一步。例如：
  - 执行命令：`const r = await tools.exec_command({cmd: "ls"}); text(JSON.stringify(r));`
  - 写文件：`await tools.apply_patch("*** Begin Patch\n*** Add File: notes.txt\n+…\n*** End Patch\n");`

  下一个请求里出现 `custom_tool_call_output` 时，进入计划的下一步。审查方已用 `codex exec --json` 实测过这种方式：一次 `exec` 里的 `exec_command` 和 `apply_patch` 分别产生了 `command_execution` 和 `file_change` 条目，文件也确实写入了。
- **各 Agent 使用的原生工具：** 计划里的每一步，按下表解析成该 Agent 的原生工具。"—"表示该 Agent 的计划变体不包含这一步。

  | 步骤 | DSH | Claude Code | Codex code mode | Codex 直接工具 |
  |---|---|---|---|---|
  | 列目录 / 执行命令 | `bash` | `Bash` | `tools.exec_command` | `exec_command` |
  | 读文件 | `read` | `Read` | `tools.exec_command`（`cat`） | `exec_command`（`cat`） |
  | 写新文件 | `write` | `Write` | `tools.apply_patch`（Add File） | `exec_command`（heredoc） |
  | 改一行 | `edit` | `Edit` | `tools.apply_patch`（Update File） | `exec_command`（`sed -i`） |
  | 任务 / 目标 | `todo_write` | 默认 —；04b 实例用 `TaskCreate` ×2 + `TaskUpdate` | `tools.create_goal` + `tools.update_goal` | `create_goal` + `update_goal` |
  | 提问 | DSH 的提问工具（名称以实测为准） | `AskUserQuestion` | `tools.request_user_input` | `request_user_input` |
  | 需要审批的命令 | `bash` + 提权参数（5.4.5） | `Bash`（默认模式下写工作区外） | `tools.exec_command` + 提权参数（以实测为准） | `exec_command` + 提权参数（以实测为准） |
- **新增计划**（放在 `packages/testing/mock-models/plans/`）：
  - `full`：依次执行：
    1. 列出目录；
    2. 读 `README.md`；
    3. 写入新文件 `notes.txt`（2 行）；
    4. 修改 `README.md` 中的一行；
    5. 更新任务清单（2 项，1 项已完成、1 项进行中）；
    6. 给出最终回答。

    文本按每块 20 个字、每块间隔 80ms 流式输出。
  - `approval`：执行一条需要审批的命令（写入工作区之外的 `$TMP/approval-<runId>.txt`；DSH 按 5.4.5 显式请求提权），然后给出最终回答。
  - `slow`：一段 60 块的长回答，每块间隔 200ms。
  - `question`（三个 Agent 都有）：调用该 Agent 的提问工具，带 2 个选项。
  - `plan-mode`（Claude Code）：调用 `ExitPlanMode`，提交一份 Markdown 计划。
  - `tool-search`（Claude Code）：先调用 `ToolSearch` 加载 `WebFetch`，再调用 `WebFetch` 访问 mock 提供的一个本地地址。
  - `echo-context`：最终回答为"历史用户消息 {{userMessageCount}} 条"。
  - `image`：最终回答为"收到图片 {{imageCount}} 张"。

### 6.4 测试钩子

这些钩子只在 `WDCC_TEST_HOOKS=1` 时存在，否则返回 404（由用例 S-03 断言）。

| 钩子 | 作用 | 用于 |
|---|---|---|
| `POST /api/__test/inject-event {sessionId, events: [...]}` | 原样写入若干条事件（一次最多 1,000 条），包括事件自带的 turnId（可以是 null），不许替换成特殊值。用例自己构造真实形状的轮次：`user.message`、`turn.started`、若干条目、`turn.completed` | ROB-01、ROB-04、NET-07 |
| `POST /api/__test/dispose {sessionId}` | 立即回收该会话的 Agent 进程 | `AG-*-11` |
| `GET /api/__test/processes` | 列出 WebDCC 启动的 Agent 进程及其 PID 和环境中的目录变量 | S-02、ROB-02、ROB-03 |

### 6.5 全局断言

这些断言写在 Playwright fixture 里，每个用例都会自动执行，用例不能关闭它们：

- `pageerror` 为 0，`console.error` 为 0。
- 没有 HTTP 5xx 响应（mock 的 500 不算，它不是发给浏览器的）。
- 所有 HTTP 响应体和 WebSocket 帧里，都不出现以 `sk-wdcc-test-` 开头的字符串。
- 用例结束时，如果会话的状态不是"运行中"，页面上就不能有"运行中…"。
- 每个用例结束时截图，保存为 `shots/<ID>-end.jpg`。关键步骤另外截图。

### 6.6 报告与用例清单

- 每个用例的标题都以 ID 开头，例如 `AG-codex-05 审批：允许一次`。
- 用例 ID 从 `docs/specs/SPEC-M8.md` 第 7 节表格的第一列解析，不另外维护清单。ID 里的大括号按 shell 规则展开，例如 `AG-{dsh,codex,claude}-01` 展开为 3 个 ID。
- 自定义报告器：实际执行的 ID 集合必须与解析出的集合完全相同，而且每一个都通过，否则报告器判失败。
- 第 7 节的用例行不许修改。唯一的例外是 1.2 允许的、有证据的断言修改，并且要在 PR 描述里单独列出。
- `report.json` 包含：commit SHA、开始和结束时间、Node 与三个 Agent 的版本、两遍的结果、每个用例的耗时、截图路径和失败信息。
- `index.html`：按用例分组的截图总览，在本地打开即可查看，供用户检查界面。
- 截图格式为 JPEG，质量 70，deviceScaleFactor 为 1。`docs/acceptance/M8/` 总大小不超过 40 MB。
- 汇总行格式：`M8 ACCEPTANCE: <通过数>/<总数> passed ×2 @ <commit>`。

---

## 7. 用例清单

- **视口：** 默认 1440×900。MOB-01 至 MOB-03、DOCK-02 和 A12 的截图另用 390×844；MOB-04 用 900×800。
- **Agent 写法：** `<a>` 表示 dsh、codex、claude 三者之一。
- **默认 Provider：** 没有特别说明时，Codex 和 Claude Code 使用 NEW-02 的默认选择，DSH 使用它自己的设置。
- **审批：** 除 05、06 和 MODE 用例外，fixture 会自动点击"允许一次"，规则如下：
  - 用条件等待实现，只点击 `data-state="pending"` 的审批卡片。卡片必须带有 `data-state` 属性，取值为 `pending` 或 `resolved`。
  - 每次点击都记录工具名。
  - 每个用例结束时，实际发生的审批列表（工具名和次数）必须**完全等于**该 Agent 在该访问模式下执行该计划时的预期列表，多一个、少一个都算失败。
  - 预期列表来自原生行为的实测，写成 `protocol-notes.md` 里的一张表（Agent × 访问模式 × 计划）。
- **执行顺序（7.4）：** 每个 Agent 的 01、02、03、04、07、08、10、11、12 依次在同一个会话里执行；05、06、09 和各 Agent 的 13 各自新建会话。

### 7.1 环境与认证

| ID | 步骤 | 断言 |
|---|---|---|
| S-01 | 调用 `GET /api/meta` | 三个 Agent 都是 `installed: true`、`adapterKind: 'real'`，版本等于锁定版本 |
| S-02 | 调用 `GET /api/__test/processes` | 服务端和各 Agent 进程的 `HOME`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`DSH_HOME` 都在临时目录里；所用端口不是 3080、3091、8787 |
| S-03 | 不设 `WDCC_TEST_HOOKS`，另外启动一个服务实例 | 该实例上 `/api/__test/*` 全部返回 404 |
| S-04 | 设置 `WDCC_TEST_HOOKS=1`，但让 `CODEX_HOME`（以及另外三个目录，分别测一次）指向运行用户的真实家目录，然后启动服务 | 服务在扫描任何配置之前就退出，报"测试模式下不允许使用真实家目录"，服务日志里没有任何导入扫描的记录；单测、fake e2e、真实套件和 `spawnServer` 都调用同一个 `isolatedEnv()`（用代码检查断言） |
| AUTH-01 | 打开 `/?token=错误值` | 不设置 Cookie，页面显示未授权；`/api/sessions` 返回 401 |
| AUTH-02 | 打开 `/?token=正确值` | 跳转到 `/`，地址栏里不再有 token；Cookie 带 HttpOnly |
| AUTH-03 | 用一个不带 Cookie 的新浏览器上下文打开 `/s/<已有会话>` 和 `/files/<已有文件>` | 都返回未授权，不泄露任何会话内容 |
| AUTH-04 | 复制一份数据目录，另外启动一个服务实例；登录后，修改该实例的 `WDCC_TOKEN` 并重启它 | 旧的 Cookie 失效（A9）；主服务实例不受影响 |
| AUTH-05 | 在**同一个**浏览器上下文里，分别登录同一主机上不同端口的两个实例，然后交替操作两个实例的页面 | 两个实例都保持登录，WebSocket 都正常，控制台没有错误（F18） |

### 7.2 Provider

| ID | 步骤 | 断言 |
|---|---|---|
| PRV-01 | 首次打开 Provider 页，事先不做任何手动操作 | 列出以下几项：`mockr`（来源"Codex 配置"，Key 后 4 位与 `WDCC_TEST_MOCKR_KEY` 一致）；`mockr2`（"缺少 Key"，原因里写出变量名 `WDCC_TEST_MOCKR2_KEY_MISSING`）；Claude 设置中的端点（来源"Claude 设置"）；DSH 的 Provider（来源"DSH"，Key 后 4 位与 `sk-wdcc-test-dshcred-<runId>` 一致）。页面顶部提示"从本机导入了 N 个 Provider"，N 与列表一致 |
| PRV-02 | 重启服务，再打开 Provider 页 | Provider 的数量和内容都没有变化，没有重复 |
| PRV-03 | 删除 `mockr2` → 重启服务 → 点"恢复已忽略的导入" | 重启后 `mockr2` 没有回来；点恢复后它重新出现 |
| PRV-04 | 在 WebDCC 里把 `mockr` 改名为"我的 Mock" → 修改临时 `config.toml` 里 `profiles.alt.model` → 点"重新扫描" → 点"更新" | 显示"本机配置已变化"；更新后模型列表包含新的模型；名称仍然是"我的 Mock" |
| PRV-05 | 粘贴一段 `config.toml`，里面带注释 `# WDCC-PASTE-MARKER-<runId>`，然后导入 | 导入得到的 Provider 正确；在数据目录（包括 SQLite 文件）里搜索不到这个标记 |
| PRV-06 | 用表单手动新增一个 Provider：依次点击并填写名称、两种协议的地址、Key（`sk-wdcc-test-manual-<runId>`）和模型 | 列表里出现这个 Provider，来源为"手动"；全局断言确认之后所有响应里都不含这个 Key |
| PRV-07 | 给 `mockr2` 补填 Key → 用 `mockr2` 新建一个 Codex 会话，跑 `full` | mock 收到的请求里，`Authorization` 是补填的 Key，路径前缀为 `/v2` |
| PRV-09 | 用 M7 / PR1 格式的数据目录启动新版本（仓库里保存一份脱敏的旧版数据目录作为夹具） | Provider 被迁移为 `endpoints`；API 响应和数据库里都不再有 `baseUrl`；旧会话能打开，并能继续对话 |
| PRV-08 | 新增一个模型名不在 Codex 目录里、也没有填模型目录路径的 Provider，然后在新会话页选择 Codex | Codex 选项旁显示"需要模型目录"的提示 |

### 7.3 新会话

| ID | 步骤 | 断言 |
|---|---|---|
| NEW-01 | 打开新会话页；另外启动一个 `PATH` 中没有 `codex` 的服务实例，打开它的新会话页 | 正常实例：三张卡片都可选，并显示版本号。无 codex 的实例：Codex 卡片灰显，写着"服务器上没有安装 Codex CLI" |
| NEW-02 | 依次选择 Codex 和 Claude Code，不改动任何选项，直接发送 `full` | Codex 默认选中 `mockr` 和 `<SLUG_A>`，Claude 默认选中"Claude 设置"那一项和 `mock-claude-a`；会话记录里的 `model`、mock 收到的请求里的 `model`，都等于默认值 |
| NEW-03 | 选择一个只有 1 个模型的 Provider，不碰模型下拉框直接发送；再新建一个会话，选择第 2 个模型后发送 | 第一个会话的 `model` 等于唯一的那个模型；第二个会话的 `model` 等于第 2 个模型 |
| NEW-04 | 在每张 Agent 卡片下展开 Provider 列表 | 协议不兼容的 Provider 灰显并写明原因；DSH 卡片下，不是来自 DSH 的 Provider 灰显，注明"DSH 使用自己设置里的 Provider" |
| NEW-05 | 在 NEW-01 那个无 codex 的实例上，直接通过 API 创建一个 Codex 会话 | 返回错误并带原因；`/api/sessions` 和侧边栏里都没有留下记录（如果 F1 选择的是保留记录，则显示为"出错"并带原因） |
| NEW-06 | 选择 DSH，打开模型下拉框；分别查看 Codex、Claude 的原生登录选项 | DSH 的下拉框列出 `session/modelCatalog` 返回的模型，默认选中 DSH 当前使用的模型；"原生：ChatGPT 登录"和"原生：Claude 登录"在未登录的测试环境里灰显，并写明"未登录" |
| NEW-07 | 新建 Claude 会话，选择 PRV-06 手动新增的 Provider（不是默认的"Claude 设置"那一项），发送 `full` | mock 收到的 `Authorization` 是手动 Provider 的 Key，不是 `settings.json` 里的 Key。也就是说，`settings.json` 的 `env` 没有覆盖 WebDCC 注入的值 |

### 7.4 三个 Agent 的核心流程

| ID | 步骤 | 断言 |
|---|---|---|
| AG-{dsh,codex,claude}-01 | 新建会话，发送 `full` | 地址变为 `/s/<id>`；**不刷新页面**，侧边栏和会话头的 Agent 标识就是正确的（DS、CX、CC）；访问模式按钮显示的是该 Agent 自己的模式名 |
| AG-{dsh,codex,claude}-02 | 同上一轮，观察流式输出 | 发送后 5 秒内出现第一个字；完成之前，至少 3 次观察到助手文本的长度在增加 |
| AG-{dsh,codex,claude}-03 | 展开这一轮，点改动卡片中的 `README.md` | 步骤依次为列目录、读取 `README.md`、写入、修改、任务清单；改动卡片显示"2 个文件"，其中 `notes.txt` 为 `+2 -0` 并标"新文件"或"整文件写入"，`README.md` 为 `+1 -1`；停靠区的 diff 能看到改动前后的那一行；工作区里两个文件的内容与预期一致 |
| AG-dsh-04 | 查看任务面板 | 显示 2 项，1 项已完成、1 项进行中；页面没有错误（F2 的回归测试） |
| AG-codex-04 | 查看会话的"目标" | 显示 Codex 的目标：内容与计划中 `create_goal` 的参数一致，状态与 `update_goal` 的参数一致（来自 `thread/goal/updated`）；页面没有错误 |
| AG-claude-04 | 查看这一轮 | 不出现任务面板，也没有错误卡片。这是 Claude Code 2.1.322 在第三方端点下的原生行为：审查方在干净环境里抓取了交互式 `claude` 和 `claude -p` 的请求，工具清单相同，都没有 TodoWrite 或 Task* |
| AG-claude-04b | 另外启动一个服务实例，它的临时 `settings.json` 的 `env` 里加上 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`（审查方环境中，这个变量会让 `TaskCreate` 和 `TaskUpdate` 出现；以实测为准）；新建 Claude 会话，发送 `full` | Claude 的请求里出现了 `TaskCreate` 和 `TaskUpdate`；任务面板显示 2 项，1 项已完成、1 项进行中 |
| AG-{dsh,codex,claude}-05 | 新建会话，发送 `approval`，点"允许一次" | 审批卡片的标题包含命令原文；原因是中文（DSH 取 `displayReason.zh`）；按钮文字与原生选项一致；正文里没有原始 JSON（JSON 在"详情"里折叠）；等待审批时侧边栏显示"待批准"；点击后卡片显示"已允许一次"，命令真的执行了（目标文件存在） |
| AG-{dsh,codex,claude}-06 | 新建会话，发送 `approval`，点"拒绝" | 卡片显示"已拒绝"；目标文件不存在；mock 收到的下一个请求里带有"被拒绝"的工具结果；这一轮正常结束 |
| AG-{dsh,codex,claude}-07 | 在 01 的会话里，等这一轮结束 | 轮头显示"已完成，用时 …"；整个时间线里没有"运行中…"；用户气泡位于这一轮的顶部；底栏显示"1 轮" |
| AG-{dsh,codex,claude}-08 | 刷新页面；再用一个新的浏览器上下文打开同一个地址 | 刷新前后，时间线的文本完全一致；新上下文里的文本和 Agent 标识也一致 |
| AG-{dsh,codex,claude}-09 | 发送 `slow`，在流式输出中点"停止"；然后发送 `approval`，在审批等待中点"停止"；最后发送一条新消息 | 3 秒内显示"已中断"，文本不再增长；挂起的审批卡片显示"已取消"（DSH 收到 `cancelled`，`session/list` 里没有挂起的轮次）；最后那条消息正常完成 |
| AG-{dsh,codex,claude}-10 | 在 01 的会话里再发送一次 `full` | 出现第二轮，底栏显示"2 轮"，第一轮自动收起 |
| AG-{dsh,codex,claude}-11 | 调用 `/api/__test/dispose` → 发送 `echo-context` | dispose 之后，`/api/__test/processes` 里已经没有这个会话的进程（DSH 则是这个会话已取消关注）；回答为"历史用户消息 3 条" |
| AG-{dsh,codex,claude}-12 | 在输入框的模型菜单里换成同一 Provider 下的另一个模型（DSH 用它目录里的另一个模型），然后发送 | mock 收到的下一个请求里，`model` 是新选的模型 |
| AG-codexd-{01,03,05,09,11} | 与 AG-codex 的同号用例相同，只是新会话里选择模型 `deepseek-v4-pro`（直接工具路径） | 与同号用例的断言相同。其中 03：这条路径没有 `apply_patch`，文件是通过命令修改的，改动卡片的数据来自 `turn/diff/updated`，仍然必须显示 2 个文件，分别为 `+2 -0` 和 `+1 -1`；时间线里还要出现 Codex 的"兜底元数据"警告提示卡片 |
| AG-codex-13 | 查看 01 的会话 | 对话里没有"userMessage"、没有 `summaryPartAdded` 的未知事件卡片、没有内容为空的思考卡片；底栏的 token 用量不为 0 |
| AG-codex-14 | 新建 Codex 会话，发送 `question`（Codex 用 `request_user_input` 提问） | 出现提问卡片，两个选项的文字正确；选第 2 项提交后，mock 收到的工具结果里包含第 2 个选项 |
| AG-dsh-14 | 新建 DSH 会话，发送 `question`（DSH 用自己的提问工具） | 出现提问卡片，两个选项的文字正确；选第 2 项提交后，mock 收到的工具结果里包含第 2 个选项 |
| AG-claude-15 | 新建 Claude 会话，把访问模式切换为"计划模式"，发送 `plan-mode` | 审批卡片里以 Markdown 完整显示计划，按钮用原生选项的文字；批准后这一轮继续执行，访问模式按钮显示 SDK 回报的新模式 |
| AG-claude-16 | 新建 Claude 会话，发送 `tool-search` | 先出现一个 `ToolSearch` 步骤，卡片写明加载了 `WebFetch`；接着出现一个 `WebFetch` 步骤，显示目标地址和结果；这一轮正常完成 |
| AG-claude-13 | 新建会话，发送 `question`，选第 2 个选项后提交 | 出现提问卡片，两个选项的文字正确；mock 收到的工具结果里包含第 2 个选项 |
| AG-dsh-13 | 在 WebDCC 的 DSH 会话里发送 `approval`，然后在外部 DSH 的原版界面里批准它；再发送一次 `approval`，这次在 WebDCC 里批准 | 第一次：WebDCC 的卡片在 2 秒内显示"已在其他界面处理：已允许一次"，这一轮继续执行并完成。第二次：原版界面上的审批在 2 秒内消失 |

### 7.5 访问模式

| ID | 步骤 | 断言 |
|---|---|---|
| MODE-{dsh,codex,claude}-01 | 打开访问模式菜单 | DSH 列出 4 个 preset；Claude 列出 SDK 的 permissionMode 取值；Codex 列出的选项与直接调用 app-server `permissionProfile/list` 的结果一致。以 root 运行时，Claude 的 `bypassPermissions` 一项灰显，写明"以 root 运行时 Claude Code 不允许此模式"；以普通用户运行时，这一项可以选择 |
| MODE-{dsh,codex,claude}-02 | 切换到只读，发送 `full`，遇到审批点"拒绝" | 写文件被拒绝，或者触发审批（审批被拒绝）；工作区里的文件没有变化；按钮显示 Agent 回报的当前模式；轨迹里有这次切换的事件 |
| MODE-{dsh,codex,claude}-03 | 切换到不需要审批的可写模式，发送 `full` | 写文件成功，并且没有出现审批卡片 |

### 7.6 附件

| ID | 步骤 | 断言 |
|---|---|---|
| ATT-{dsh,codex,claude}-01 | 用"添加"选择一张 PNG，发送 `image` | mock 收到 1 个图片块（Codex 为 Responses 的 `input_image`，Claude 为 `image` block）。DSH 按核实结果：支持图片就是 1 个图片块；不支持的话，消息里有这张图片在 `.webdcc/uploads/` 下的相对路径。支持图片时，回答为"收到图片 1 张" |
| ATT-02 | 选择一个 `.txt` 文件 | 工作区里出现 `.webdcc/uploads/<fileId>-<原文件名>`，内容一致；输入框里出现它的相对路径，并且可以编辑；`.git/info/exclude` 里有 `.webdcc/`；`git status` 不显示 `.webdcc` |
| ATT-03 | 把上传限速到 1 MB/s，上传一个 20 MB 的文件，传到一半时断网 10 秒，再恢复 | 从断点继续上传；最终 sha256 一致；服务端没有重复的分片（A6f） |
| ATT-04 | 上传一个大于 100 MB 的文件（用稀疏文件生成） | 被拒绝，并显示提示 |
| ATT-05 | 刷新页面、重启服务、换一个浏览器上下文，分别打开 `/files/{id}` | 都能打开；响应头带 `immutable` 和 ETag（A4） |

### 7.7 斜杠命令、@ 与交接

| ID | 步骤 | 断言 |
|---|---|---|
| SL-01 | 在 Claude 会话里输入 `/`，选中一条命令 | 菜单列出 init 消息里的 slash commands，与 SDK 报告的一致；选中后命令插入到输入框 |
| SL-02 | 在 DSH 会话里输入 `/`；然后发送 `/permission read-only` | 菜单列出 DSH 的命令目录；DSH 的 mock 没有收到这条消息；访问模式按钮变为只读 |
| SL-03 | 在 Codex 会话里输入 `/foo bar` 并发送 | 没有弹出菜单；mock 收到的用户消息文本就是 `/foo bar` |
| HO-01 | 输入 `@READ`，选择 `README.md` | 菜单里出现 `README.md`；选中后路径插入到输入框 |
| HO-02 | 输入 `@`，选择同一工作区里的另一个会话 | 菜单里出现该会话；选中后会话引用插入到输入框 |
| HO-03 | 在 Codex 会话的最终回答上点"带到…"，选一个 Claude 会话，然后点发送 | Claude 会话的输入框里预先填好了内容，与来源原文逐字节一致，并且可以编辑；点发送之前，mock 没有收到任何新请求（A8）；点发送后正常完成 |

### 7.8 停靠区与窄屏

| ID | 步骤 | 断言 |
|---|---|---|
| DOCK-01 | 打开 `/s/A+B`，点"移到主栏"，然后刷新；接着在浏览器里后退、前进 | 主栏显示 A、停靠区显示 B，停靠区标签有 B 的 Agent 标识和标题；移到主栏后地址变为 `/s/B+A`；刷新后布局还原；后退、前进时布局正确还原（A3） |
| DOCK-02 | 在 390×844 下，从会话里打开停靠区，再点返回 | 停靠区全屏显示；左上角的"返回"回到主栏 |
| DOCK-03 | 在改动卡片上点一个文件；切到文件标签，打开 `README.md`；刷新；再打开 `/s/A?dock=diff:F` 和 `#e-{seq}` | 先显示 diff 标签，再显示文件内容；刷新后仍然是同一个标签；直接打开的地址能还原相同的布局和滚动位置 |
| MOB-01 | 在 390×844 下，点会话头左侧的按钮，在抽屉里选另一个会话 | 抽屉打开；切换后抽屉关闭，地址随之变化 |
| MOB-02 | 在 390×844 下，从抽屉里点"新会话"，新建一个 Codex 会话并跑完一轮 | 正常完成；输入框固定在底部，底边距离视口底边不超过 24px |
| MOB-03 | 在 390×844 下，按 A12 的清单截图 | 截图覆盖：侧边栏抽屉、运行中的轮次、已完成的轮次（收起和展开）、改动卡片、审批卡片、任务面板、`@` 弹窗、停靠区（会话标签和 diff 标签）、新会话页 |
| MOB-04 | 在 900×800 下，展开侧边栏，然后打开停靠区 | 侧边栏默认收起为 56px 的窄栏；打开停靠区时，侧边栏自动收起 |
| UI-01 | 在 1440×900 下，按 A12 的清单截图 | 截图覆盖内容同 MOB-03，放进 index.html，标"待用户确认" |

### 7.9 弱网、同步与性能

| ID | 步骤 | 断言 |
|---|---|---|
| NET-01 | 模拟往返 2 秒、带宽 50 KB/s，发送 `slow` | 流式输出持续可见；在此期间点击展开、切换标签等操作，都在 1 秒内有响应（A6a） |
| NET-02 | `slow` 流式输出中断网 30 秒，再恢复 | 显示离线提示；恢复后显示补齐了多少条；最终时间线与 `GET /api/sessions/:id/events` 逐条一致，无重复、无缺失（A6b） |
| NET-03 | 断网时发送一条消息，然后恢复网络 | 断网期间气泡显示"待发送"；恢复后自动送达，服务端只有 1 条带该 clientCommandId 的 `user.message`（A6c） |
| NET-04 | 发送 `approval`，在等待审批时断网，点"允许一次"，再恢复；另起一个用例重复，但断网期间先在另一个标签里点"拒绝" | 第一种情况：只生效一次。第二种情况：界面显示实际结果"已拒绝"（A6d） |
| NET-05 | 用两个标签页打开同一个会话：在 A 里批准审批，在 A 里改名，在 A 里新建一个 Claude 会话；再让一个 DSH 审批在原版界面里被处理 | 2 秒内，B 里的卡片、标题、侧边栏都同步了；B 的侧边栏里新会话的标识是 CC；B 里的 DSH 审批卡片显示"已在其他界面处理" |
| NET-06 | 一轮完成后，重启服务进程 | 页面不刷新，自动重新连接，时间线没有变化；再发送消息能正常完成 |
| NET-07 | 用 inject-event 造一个有 5,000 条事件的会话。先在已缓存的情况下，从另一个会话切换过去；再在一个新的上下文里，模拟 RTT 100ms 直接打开它 | 已缓存：首屏 ≤ 150 ms。未缓存：第一个请求只取 ≤ 200 条事件，首屏 ≤ 1 秒。实测数值写进报告（A5） |
| NET-08 | 打开一个会话后断网，刷新页面（`http://127.0.0.1` 属于安全上下文） | 应用外壳能打开，已缓存的会话可以阅读，顶部显示离线状态（A6e） |
| NOTIF-01 | 在页面中注入脚本，记录 Notification 的调用；然后让后台会话 A 完成，让后台会话 B 进入等待审批 | 侧边栏状态正确；页面标题上出现未读数；通知被调用了 2 次；没有任何消息被自动发给 Agent（A13） |

### 7.10 会话管理

| ID | 步骤 | 断言 |
|---|---|---|
| SES-01 | 新建一个 DSH 会话；手动改名；再触发一次原生标题事件 | 一开始，标题取原生标题或者第一行的前 40 个字；改名之后，原生标题事件不再覆盖用户改的名字（C1） |
| SES-02 | 置顶一个会话，归档另一个，然后刷新 | 侧边栏的顺序和归档区都正确，刷新后保持不变 |
| SES-03 | 在"···"菜单里点"导出" | 下载的 JSONL 文件行数等于该会话的事件数，每一行都可以解析（C6） |
| SES-04 | 打开轨迹标签，在搜索框里输入一种事件类型 | 能看到 internal 和 unknown 事件；搜索过滤生效 |

### 7.11 原装检查

| ID | 步骤 | 断言 |
|---|---|---|
| NAT-{dsh,codex,claude}-01 | 在同一个工作区里，使用相同的访问模式，分别通过 WebDCC 和直接运行该 Agent，向同一个 mock 发一条消息。直接运行的方式：Codex 用 `codex exec`；Claude Code 用 `claude -p`；DSH 另外复制一份临时 `DSH_HOME`，单独运行一个 `dsh web`，通过它自己的 RPC 新建会话并发送（不许与外部 DSH 共用同一个 `DSH_HOME`） | 两边的请求里，工具名的集合完全一致；系统提示词在去掉日期、路径和各种 ID 之后完全一致；请求里包含 `AGENTS.md` / `CLAUDE.md` 中的标记（R1、R2、A2）。如果两种运行方式本身就有差异，按 1.2 记录证据 |
| NAT-02 | 在用例 NAT-{dsh,codex,claude}-01 执行前后，对临时目录里的配置文件计算哈希 | 前后一致（R3） |

### 7.12 健壮性

| ID | 步骤 | 断言 |
|---|---|---|
| ROB-01 | 用 inject-event 写入一条 `kind: 'plan'`、但 data 是 tool.call 形状的事件，然后刷新页面 | 只有这一条显示"这条内容无法显示"；同一轮的其他条目、侧边栏和输入框都正常；刷新后依然如此 |
| ROB-02 | 在 Codex 会话的流式输出中，结束它的进程（PID 从 `/api/__test/processes` 获取），然后再发一条消息 | 时间线里出现错误卡片，写明原因；侧边栏显示"出错"；再次发送时自动重新启动，并正常完成 |
| ROB-03 | 结束外部 DSH 进程；然后由套件重新启动它 | DSH 结束期间，WebDCC 的 DSH 卡片灰显并写明"DSH 未运行"，其他 Agent 正常可用，WebDCC 没有尝试自己启动 DSH；外部 DSH 重新启动后，WebDCC 按 DSHX-03 核实的方式恢复连接，已有的 DSH 会话可以继续对话 |
| ROB-04 | 注入一个 Codex schema 之外的原生事件 | 它以 unknown 卡片的形式出现在时间线里（A11） |

### 7.13 DSH 连接方式（D1）

| ID | 步骤 | 断言 |
|---|---|---|
| DSHX-00 | 主服务实例启动后，打开设置页，粘贴外部 DSH 的启动链接 | 连接状态变为"已连接"，并显示 DSH 版本；`secrets.json` 之外的任何文件和日志里都没有这个 token |
| DSHX-01 | 在外部会话里让 DSH 发起一个审批（用 `approval` 计划），等待 15 秒；然后在原版界面里批准它 | 这 15 秒里，审批始终处于待处理状态（WebDCC 没有回复，也没有取消）；WebDCC 的侧边栏和时间线里都看不到这个外部会话或它的审批；在原版界面批准后，外部会话正常完成 |
| DSHX-02 | 外部会话在流式输出 `slow` 的过程中，重启 WebDCC 服务进程 | 外部会话不受影响，正常完成；WebDCC 重启后不用重新粘贴链接，就自动恢复连接 |
| DSHX-03 | 重启外部 DSH（它会生成新的启动 token） | 预期：WebDCC 用保存的 Cookie 自动重新连接，WebDCC 里已有的 DSH 会话可以继续对话，历史完整。如果实测 operator 在 DSH 重启后无法恢复，按 1.2 记录证据，把断言改为：设置页和 DSH 卡片显示"需要重新连接 DSH"，粘贴新链接后恢复，已有会话可以继续，历史完整 |
| DSHX-04 | 外部会话的访问模式设为"工作区内修改"，然后在 WebDCC 里把自己的 DSH 会话切换为只读 | 外部会话的访问模式不变；外部 DSH 的 profile 配置文件哈希不变 |
| DSHX-05 | 外部会话有一个待处理的审批时，在 WebDCC 里打断自己的 DSH 会话、调用 dispose 回收它、关闭页面 | 外部会话的审批始终保持待处理，之后在原版界面里仍然可以正常批准 |
| DSHX-06 | 另外启动一个 spawn 模式的服务实例，让它的 `DSH_HOME` 等于外部 DSH 正在使用的目录 | 它拒绝拉起侧车，DSH 卡片写明"检测到已有 DSH 在使用 <路径>，请改用 attach 模式"；外部 DSH 的 `storages/workspace.json` 不变 |
| DSHX-07 | 另外启动一个 spawn 模式的服务实例，让它使用全新的临时 `DSH_HOME`，在其中新建一个 DSH 会话并发送 `full`；然后结束它拉起的侧车进程，再发一条消息 | 第一轮正常完成（spawn 模式仍然可用）；侧车被结束后自动重启（指数退避），再发的消息正常完成 |
| DSHX-08 | 在 attach 模式下，通过 WebDCC 添加一个新的工作区，并新建会话；然后在原版界面里查看工作区列表 | 原版界面里同时有外部会话所在的工作区和 WebDCC 新增的工作区；外部 DSH 的 `storages/workspace.json` 里两者都在，没有互相覆盖 |

### 7.14 收尾

这几项在报告阶段执行，不是浏览器用例，但同样有 ID，必须通过。

| ID | 步骤 | 断言 |
|---|---|---|
| FIN-01 | 汇总两遍的结果 | 两遍全部通过 |
| FIN-02 | 在 `run/server.log` 和数据目录（`secrets.json` 除外）中搜索 `sk-wdcc-test-` | 搜不到 |
| FIN-03 | 套件在每个用例结束后，对测试用的 `config.toml`、`settings.json` 和 DSH 配置文件计算哈希；套件自己修改这些文件时（例如 PRV-04），同时更新预期的哈希 | 实际哈希始终等于预期哈希，即 WebDCC 从来没有写过这些文件（R3） |
| FIN-04 | 计算用户真实配置的哈希 | 与套件开始时一致（1.4） |

---

## 8. 执行顺序与 PR

**棘轮规则：**
- 每个 PR 都运行 `pnpm accept:m8 --ratchet`，并把 `docs/acceptance/M8/status.json` 提交进去。status.json 记录每个 ID 的状态：`passed`、`failed` 或 `not-implemented`。
- 从 PR 2a 起，第 7 节的全部 ID 都必须有对应的测试。还没实现的，用例体里显式 `throw new Error('NOT IMPLEMENTED: <ID>')`（这算失败，不算跳过）。
- `--ratchet` 模式下：`passed` 的集合只能增加，已实现（`passed` 加 `failed`）的集合也只能增加。**之前通过的用例变成失败，PR 不许合并。**
- PR 描述里贴出本次由失败变为通过的 ID 列表，以及 1.3 要求的修复前失败输出。

**PR 顺序：**
1. **PR 1：** 验收套件的框架（6.1–6.6，包括 mock 的扩展和测试钩子），把第 7 节的全部用例都写出来（这时大部分预期会失败）；同时修 F1、F2、F3。合并时，S、AUTH，以及三个 Agent 的 01、02、04 必须通过。
2. **PR 2a（基础，先做）：** 1.6 的三件事；第 7 节全部 ID 落成测试，未实现的显式失败；status.json 和报告入库；F18，以及 PRV / NEW 用例使用独立实例；`spawnServer` 改为可移植；`inject-event` 原样写入；按第 7 节开头的规则实现自动批准；mock 的 code mode 和各 Agent 的计划变体（6.3）。
3. **PR 2b：** D1（attach 模式、spawn 模式的冲突检查、设置页的"DSH 连接"一节）和 F16（包括 DSH 导入和 `endpoints` 迁移）。
4. **PR 3：** F4、F5、F12（包括目标、计划、diff、警告的映射和 code mode）、F17、F19。
5. **PR 4：** F6。
6. **PR 5：** F7、F8。
7. **PR 6：** F9、F10、F11、F14、F15。
8. **PR 7：** 剩余的失败用例。最后在干净检出上跑 `pnpm accept:m8`（严格模式，2 遍），生成报告，更新 `docs/progress.md`。

---

## 9. 部署与真实模型冒烟（M8 的最后一步）

0. **临时部署（现在就做，不等 M8 完成）：**
   - 记录当前部署的版本和启动方式，备份数据目录 `WDCC_DATA_DIR`（完整复制一份，留作回退）。
   - 把当前 main 构建后部署到 :80，`WDCC_ENABLE_DSH=0`，只重启 WebDCC。
   - 部署后用浏览器确认：新建 Codex 会话和 Claude Code 会话都能正常完成一轮（用户本机已有的配置或登录）；M7 时期的旧会话能打开。
   - 结果写进 progress.md。之后每合并一个 PR，就按同样的步骤重新部署一次（先备份），让用户一直用上最新的修复。
1. **部署前：** 在 `docs/progress.md` 记录当前部署的版本和启动方式，并备份数据目录，以便回退。
2. **按 D1 部署（attach 模式）：**
   - **不许停止或重启用户 3080 端口的 DSH。** 执行本 SPEC 的 Agent 就运行在它里面。
   - 只有 7.13 的 `DSHX-*` 用例全部通过后，才允许让 WebDCC 连接用户的 DSH。
   - 设置 `WDCC_ENABLE_DSH=1`、`WDCC_DSH_MODE=attach`、`WDCC_DSH_URL=http://127.0.0.1:3080`，然后只重启 WebDCC。
   - 首次连接需要 DSH 的访问链接 `http://127.0.0.1:3080/?token=…`，**由用户自己在 WebDCC 设置页粘贴**。不要向用户索取这个链接，也不要让用户把它发给你。在汇报里写明"请在 WebDCC 设置页粘贴 DSH 访问链接"；用户粘贴之后，再执行 DSH 的真实模型冒烟。
   - 连接后，确认执行本 SPEC 的这个会话仍然正常：它的审批仍由原版界面处理，WebDCC 里看不到它。
3. **真实模型冒烟：** `pnpm accept:live`，对部署好的实例运行：
   - **工作区：** 新建一个专用目录 `~/webdcc-smoke`（执行 `git init`），在部署的实例里把它添加为工作区。不许用用户的任何项目目录。
   - **每个 Agent 跑一轮：** 使用 F16 导入的真实 Provider（DSH 用它自己的设置），访问模式为只读，消息为"列出当前目录下的文件名，不要修改任何文件"。断言这一轮正常完成、没有页面错误、截图。
   - **跑完后：** 把这几个冒烟会话归档。
   - **费用控制：** 每个 Agent 只运行这一次，不重试，不放进循环。
   - **Key 的来源：** 部署实例从用户本机的配置导入（F16），用户的 `~/.claude` 里就有真实的端点和凭据；Codex 用用户本机的配置或登录；DSH 在 attach 之后直接使用。**不许以"环境里没有 Key"为由跳过。** 只有当部署实例的新会话页上，某个 Agent 确实没有任何可用的 Provider 或登录时，才把它标为"待真实模型验证"，并附上新会话页的截图作为证据。
   - 脚本不许打印部署实例的 token。
4. **生成报告：** 运行结果写进 `docs/acceptance/M8/live.json` 和 `docs/acceptance-report.md`。

---

## 10. 最终汇报（只写这些，不要写成功总结）

1. 报告器输出的汇总行，原样照抄。
2. `docs/acceptance/M8/index.html` 的路径。
3. "修改的断言"清单（逐条写出证据所在位置）。没有就写"无"。
4. 真实模型冒烟的结果，每个 Agent 一行。
5. 部署后的状态：WebDCC 的地址和端口（不含 token）；WebDCC 和 3080 上的 DSH 的连接状态；执行本 SPEC 的 DSH 会话在部署后是否一直正常。
6. 停止条件触发过没有。触发过的话，写明是哪个用例、证据是什么。
