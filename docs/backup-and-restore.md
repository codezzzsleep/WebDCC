# 加密备份与隔离恢复

NP-47 的工具保存 WebDCC 已持久化的数据，恢复到一个新的隔离目录。它不切换部署、不重启服务，也不覆盖已有数据库。以下命令在安装了项目依赖的源码检出目录执行；`scripts/backup.ts` 目前不是发布包中的独立可执行文件。

## 保存范围

加密 manifest 记录 schema 版本、表计数、每个文件的路径、大小和 SHA-256，以及配置一致性边界和不包含的范围。

| 数据 | 处理方式 |
| --- | --- |
| `webdcc.db` | SQLite 在线快照，保留 sessionId、URL 所依赖的身份、events、命令结果、原生输入 UUID、队列状态和原生 session 关联；不改写源数据库。 |
| `files/` | 仅包含快照 `files` 表引用的 CAS 对象；校验大小与 SHA-256，包含空文件。 |
| `uploads/` | 包含快照记录为已接收的上传分片。缺失或大小错误的分片使备份失败，不能生成只有元数据的“可恢复上传”。 |
| `secrets.json`、`provider-ignored.json`、`dsh-connection.json` | 如存在则显式包含并加密；如不存在则记录缺失。验证 JSON 和连接字段，保留未知字段及显式清空的 DSH 连接。 |
| workspace 工作树、原生 home/历史/MCP/plugins/config/OAuth、外部 DSH Host 状态 | 不复制；由操作者按各自工具的存储规则另行备份。 |
| 服务环境、服务 token、备份密钥、浏览器缓存及尚未被服务器接受的 outbox | 不复制。 |
| 活进程、PTY、仅驻内存的敏感回答、原存储策略已省略或脱敏的内容、未引用垃圾、可选诊断文件 | 无法通过此备份恢复。 |

只恢复 WebDCC 数据目录不能保证原生会话可以继续运行。恢复后需要核实外部 workspace、原生配置/凭据及 Host 是否仍可用，无法核实的范围不能声称完整恢复。

## 密钥与格式

每个对象和 manifest 都使用 AES-256-GCM 加密及认证。公开的 `backup.json` 只包含格式、版本、算法和 archive ID，没有会话内容、文件清单、凭据或密钥。对象名称使用随机 UUID。

密钥必须是独立的随机 32 字节，不得从服务 token 派生。用单独的 `keygen` 操作生成 0600 文件，工具拒绝覆盖已有密钥。密钥丢失无法恢复；密钥应另行保存，不放入备份目录。CLI 只从已打开的文件描述符读取密钥，不接受 argv 或环境变量中的密钥内容，也不会输出它。

```bash
node --import=tsx scripts/backup.ts keygen --out /secure/webdcc.key
```

`/secure` 需要事先存在并具有合适的权限。示例路径由操作者替换，不能直接指向正在运行的恢复目录。

## 创建与验证

CLI 要求操作者明确指定源目录和 `--offline`：操作者必须先保证 Provider/DSH 持久设置、CAS 和上传目录的外部写入及清理停止，并保持到备份完成。该标记是操作者的声明，不代表工具已探测到所有写者停机。SQLite 在线快照可与事务写入共存，但不能把跨文件的一致性归因于 SQLite。

服务内调用 `createEncryptedBackup` 时，`withMetadataSnapshot` 必须冻结所有 Provider/DSH 配置写者；单个 JS 进程锁不能阻止外部写者。工具比较快照前后的配置内容，发现变化会取消备份；该检查无法替代写入边界。

```bash
node --import=tsx scripts/backup.ts create --data-dir /isolated/source-data --out /secure/webdcc-backup --key-fd 3 --offline 3</secure/webdcc.key
node --import=tsx scripts/backup.ts inspect --backup /secure/webdcc-backup --key-fd 3 3</secure/webdcc.key
```

直接使用 `node --import=tsx`，通过额外 FD 传入密钥；会创建子进程的包装工具可能丢弃该 FD。普通密钥文件不得允许其他用户读取。原始 32 字节不能替换为 hex 或 Base64 文本。

创建过程在私有暂存目录生成密文，验证所有对象、SQLite 完整性与外键、表计数、CAS/上传引用及配置格式后才发布。输出目录须不存在，且不能位于源数据目录内。读写失败、缺失文件、错误 hash、配置变化、取消或磁盘同步失败都使操作失败。所有文件和发布目录必须成功 fsync，未完整验证的目录不会被作为成功产物返回。

默认上限为总明文 16 GiB、100,000 个条目、64 MiB manifest；配置读取上限为每文件 4 MiB。库调用可设置正的安全整数上限。元数据读取即使在 stat 后增长也最多读取上限加一字节，不会以无界 `readFile` 绕过限制。

## 恢复与升级

```bash
node --import=tsx scripts/backup.ts restore --backup /secure/webdcc-backup --out /isolated/restored-data --key-fd 3 3</secure/webdcc.key
```

恢复目标必须不存在或为空，且不能与备份目录重叠；现有目录内容不会被覆盖。工具在权限 0700 的隔离暂存目录解密，文件权限为 0600；解密后进行与检查操作相同的内容校验。发布前先持久化文件，再从下到上持久化 CAS/上传等子目录，最后原子 rename 并 fsync 父目录。错密钥、篡改、未知 schema、损坏配置或引用不一致会拒绝发布，暂存内容清理后返回失败。

旧版本恢复默认保留旧 schema。显式 `--upgrade` 会在隔离副本上调用现有 schema 迁移并校验与 checkpoint；失败不发布副本，也不改写源库或备份。

```bash
node --import=tsx scripts/backup.ts restore --backup /secure/webdcc-backup --out /isolated/upgraded-data --key-fd 3 --upgrade 3</secure/webdcc.key
```

备份中的队列字段、正文、命令身份和原生输入身份保持原样。其中派生的 CAS 绝对路径可能指向旧数据目录。运行时在向 native 提交队列附件前必须按 `fileId` 从当前 FileStore 解析路径、校验 MIME/hash，并确认授权；恢复工具不能猜测外部路径或改写输入语义。已经提交但结果不明确的 native 输入仍需对账，不能因恢复操作自动重放。

恢复后的部署切换是独立的运维操作。本工具没有自动启动或自动重放功能。错误提示若指出“发布持久性未确认，需要人工验证目录”，代表发布后的清理也失败，应核验指定目录的状态，不把失败返回当成成功恢复。

## 隔离验证

```bash
pnpm exec vitest run packages/server/test/backup.spec.ts
pnpm exec eslint packages/server/src/backup.ts packages/server/test/backup.spec.ts scripts/backup.ts
```

测试使用临时数据库与虚构凭据，覆盖在线事务快照、旧 schema 升级、session/events/命令结果/native 输入身份、CAS hash/空文件、已接收分片继续上传、CLI 密钥 FD、敏感内容加密、错密钥/篡改/缺失文件、路径逃逸、配置语义及增长上限、容量限制、取消、文件描述符清理和磁盘同步故障。它们不读取或备份生产数据库。
