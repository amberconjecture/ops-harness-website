# ClickHouse 单库切换与补数

> 本页保留旧布局的切换记录。2026-10-20 类型化版本请使用 [新的升级与清理手册](tracking-typed-migration.md)；不要按本页向旧库执行新版本 init。

适用状态：生产已回退到 `common/main`，继续写 `analytics.sqlite`；此前数据已迁入 ClickHouse。此分支从 `common/main` 开发，服务只读写 ClickHouse。无需重新执行旧版 snapshot / migrate / verify / handoff 流程。

## 1. 准备代码和配置

使用 Node.js 24、pnpm 11.19.0，运行 `pnpm install --frozen-lockfile`、`pnpm check`、`pnpm build`。生产旧进程可在准备期间继续运行。

在实际使用的完整 `website.json` 中加入或整体替换 `analytics`，其他官网配置保留：

```json
"analyticsDirectory": "../.runtime/website-analytics",
"analytics": {
  "clickhouse": {
    "url": "http://127.0.0.1:8123",
    "database": "website_analytics_dual",
    "adminUser": "analytics_admin",
    "adminPasswordEnv": "CH_ADMIN_PASSWORD",
    "writerUser": "analytics_writer",
    "writerPasswordEnv": "CH_WRITER_PASSWORD",
    "readerUser": "analytics_reader",
    "readerPasswordEnv": "CH_READER_PASSWORD",
    "requestTimeoutMs": 30000
  },
  "queryTimeoutMs": 60000,
  "writeTimeoutMs": 120000,
  "maxQueuedRequests": 64
}
```

`database` 必须填**已经迁移过的目标库**，不要仅因示例名称创建另一份空库。若之前迁入 `website_analytics_primary`，填该名称。`analyticsDirectory` 仍相对配置文件所在目录解析，只保存锁及待提交恢复记录，不打开其中的旧 SQLite。配置不再接受 `writeBackend`、`readBackend`、`dual`、`query.fallbackToSqlite` 或 `clickhousePrimary` 等旧切换选项。

密码由部署环境注入 `CH_ADMIN_PASSWORD`、`CH_WRITER_PASSWORD`、`CH_READER_PASSWORD`；不写进配置、命令参数或 Git。初始化用 admin，补数和服务用 writer/reader。现有 `SELECT, INSERT ON <database>.*` 和 `SELECT ON <database>.*` 授权覆盖新增表；只有逐表授权的部署需要补上 `tracking_runtime`、`tracking_commits`、`published_watermarks`。

本地默认连接 loopback。远程连接使用有效证书的 HTTPS，不关闭 TLS 验证。已有 ClickHouse 沿用原数据目录；新建环境可使用 [Compose](../../deploy/clickhouse/compose.yaml)（26.3.52.9）及环境密码。不要用示例 Compose 替换现有实例或数据盘。

## 2. 停旧进程，初始化，补数

先停止生产官网及其自动重启，确认没有其他官网实例或旧迁移工具写同一个 ClickHouse 库。保留旧 SQLite 及 WAL/SHM；脚本不会修改、清空或升级它。若要复制源文件，在停服后复制整套，或先用 SQLite 官方备份生成一致副本，不只复制正在写入的主文件。

以下 Bash 示例中的路径须换成实际路径，命令在新分支的项目根目录执行；每条成功后再执行下一条：

```bash
export DSH_OPS_WEBSITE_CONFIG=/srv/website/config/website.json

# 一次性创建新运行控制表，并采用旧库已发布数据；可重复执行。
pnpm tracking init

# 将示例时间替换为本次补数的起点；必须包含时区，包含起点本身。
pnpm tracking backfill \
  --sqlite /srv/website/.runtime/website-analytics/analytics.sqlite \
  --since '2026-10-18T10:00:00+08:00' \
  --batch-size 500 \
  --timeout-ms 300000

# 补数完成后，用原有进程管理器启动此分支的构建产物。
pnpm start
```

通过 PM2/systemd 管理时，最后一步使用原有管理器启动，避免额外启动第二个进程。配置也可显式传 `--config /path/website.json`。Windows 使用相同 CLI 和绝对路径，只需按 PowerShell 语法设置环境变量。`pnpm tracking --help` 可查看参数。

初始化不做全量重导，不要求完成旧版 authority、checkpoint、backup 或 outbox 验收。旧未完成写入保留但不会进入新统计。既有 epoch 和业务表不重建，不覆盖已发布版本；新增或变化值以更高版本写入。

### 内存与超时

`pnpm tracking` 默认通过 `node --max-old-space-size=16384 --import tsx` 启动，V8 老生代堆上限为 **16 GiB**，同时适用于 `init` 与 `backfill`。这不是启动时预分配 16 GiB，也不是进程 RSS 上限；SQLite 原生内存、Buffer、操作系统和 ClickHouse 还需要额外内存。补数保持单批默认 500 行、顺序处理，只跨批保存确实发生变化的用户 ID 映射。

若直接执行编译产物，应显式带上内存参数（直接 `node dist/...` 不经过 package 脚本）：

```bash
node --max-old-space-size=16384 dist/scripts/tracking/cli.js backfill \
  --sqlite "$SQLITE_SOURCE" \
  --since '2026-10-18T10:00:00+08:00' \
  --batch-size 500 \
  --timeout-ms 300000
```

`init` 和 `backfill` 的 `--timeout-ms` 默认 **300000（5 分钟）**，允许 1000–300000 毫秒。它在当前 CLI 进程中同时覆盖 `analytics.clickhouse.requestTimeoutMs` 和 `analytics.queryTimeoutMs`，不修改配置文件或官网服务的默认值。启动日志 `step: starting` 会显示实际 `heapLimitMiB`、`requestTimeoutMs`、`queryTimeoutMs`；V8 总堆上限含年轻代，因此显示值可能略高于 16384 MiB。

| 操作 | 原来实际生效的默认超时 | 现在离线 CLI 默认 |
| --- | --- | --- |
| 初始化 DDL、运行状态读取、旧版本读取 | 单次 HTTP 请求 30 秒 | 单次 5 分钟 |
| 按主键查询目标行、用户映射、关联事实 | 单次查询 60 秒 | 单次 5 分钟 |
| 提交日志、实体版本、水位写入及恢复 | 每次 INSERT 30 秒 | 每次 INSERT 5 分钟 |
| 整次补数、单批整体、本地 SQLite 扫描 | 没有总时限 | 没有总时限 |

原 `writeTimeoutMs=120000` 是在线 Worker 调用/排队相关预算，补数直接调用 backend，不受它限制；只增大这个值不能解决补数的 HTTP 超时。每批包含多个读写请求，整批时间可能超过 5 分钟；允许的一次读取重试仍共享该次查询的预算。

离线补数面对大历史版本表、磁盘刷写和合并，30/60 秒偏紧，5 分钟是当前默认预算，不代表已测得生产请求耗时。脚本不绕过 ClickHouse 用户的 `max_execution_time` 或网关超时；若经过代理，代理需允许相应等待时间。本机 Node.js 24 内置 HTTP 客户端也有约 5 分钟的默认响应头/响应体空闲等待，CLI 不开放更大的请求预算。

仍超时时，先依据错误中的 `queryId`、`phase`、`requestElapsedMs` 排查，并可将 `--batch-size` 降到 100，减少单批大小。写入超时后服务端是否已经完成并不确定，保留待提交文件并在停服状态重跑同一命令，不因超时跳过整批。Node 堆扩大也不会改变 ClickHouse 自身的内存限制。

参数单位及堆内存语义见 [Node.js 文档](https://nodejs.org/docs/latest/api/cli.html#--max-old-space-sizesize-in-mib)；连接断开后请求可能继续执行，见 [ClickHouse HTTP 文档](https://clickhouse.com/docs/interfaces/http)。

### 按时间选择源数据

`--since` 为必填参数，表示**指定时间及之后**（`>=`）。使用带时区的 ISO 时间，例如北京时间 `2026-10-18T10:00:00+08:00` 等价于 `2026-10-18T02:00:00Z`；不接受只有日期或不带时区的时间。参数在连接 ClickHouse 前校验，结束日志输出规范化后的 UTC `since`。

SQLite 的 11 张业务表没有统一的创建/更新时间，具体规则如下：

| 源表 | 可用时间 | 补数选择规则 |
| --- | --- | --- |
| `users` | 可为空的 `profile_updated_at`；无创建时间 | 资料更新时间达到起点，或被本次选中的事实、身份会话、日汇总引用的用户。保留已有员工 ID 映射和较新的目标资料 |
| `user_identities` | 无 | 跟随本次选中的用户，不全量补 |
| `installations` | `last_seen` | 最近接收时间达到起点 |
| `identity_sessions` | `valid_from`、`expires_at` | 按 `valid_from` 选，过期时间只用于保留期判断 |
| `event_dedup` | `received_at` | 按服务器接收时间选 |
| `operations` | `accepted` / `terminal` JSON 内的 `occurredAt`；无独立更新时间列 | 任一事件达到起点即选整条上下文；优先按事件 ID 找到接收时间，找不到再用 JSON 内发生时间 |
| `activity_facts` | `occurred_at`、`day`；无更新时间 | 优先关联同租户、同事件 ID 的 `event_dedup.received_at`，其次 `tracking_events.received_at`，缺失时回退到 `occurred_at`；同时带上本次操作上下文关联的事实，补齐旧 pending 状态的变化 |
| `runtime_facts` | 无 | 按租户和事件 ID 跟随选中的 `activity_facts`，不全量补 |
| `tracking_events` | `received_at` | 按服务器接收时间选 |
| `user_day` | `day`，只有北京时间日期 | 补指定时间所在日期及之后的日汇总，**起点当天包含整天**，无法精确到时分秒；当前统计 API 不依赖这张旧缓存表 |
| `ingestion_health` | 无，仅累计计数 | 跳过，报告 `skipReason: NO_TIME_COLUMN`，保留 ClickHouse 原有计数 |

`schema_version` 是 SQLite 内部版本记录，不迁移。上述用户、身份、操作上下文等关联记录可能早于起点，它们用于保持本次新增记录的归属和状态；不是把无时间表重新全量复制。原始事件和去重数据严格按接收时间筛选。迟到上报不会仅因事件发生在起点之前而被漏掉；接收记录已清理时只能按剩余的发生时间判断。

筛选在 SQLite 查询中完成，只将选中行分批送到 ClickHouse 比较、写入，不创建源库索引、不修改源库，也不增加全表对账。时间筛选仍叠加原有数据保留期。

## 3. 看补数结果并验收

每批输出表名及 `read`、`written`、`unchanged`、`skipped`；`read` 仅统计通过时间/关联筛选的行，不统计起点之前或无法确定时间而被排除的行。结束输出 `step: complete`、`since` 和各表汇总。选中后的无效行、已过保留期数据和无对应事实的 runtime 行会跳过，缺少源表输出 `missingTable`。不要求全表行数一致、逐行摘要或外键完全匹配，能补多少补多少。原始事件保留 90 天，去重及上下文 120 天，事实 400 天；过期数据不会因为补数重新延长保留期。

脚本在指定时间范围及关联数据中按主键只写缺失/变化行，所以可以在**新服务开始接收数据前**使用相同 `--since` 重复执行，也可提前起点补更早的遗漏。补数期间始终保持旧、新 writer 停止。不要在新服务已写入后用旧快照反复覆盖当前安装/操作状态。

启动后确认工作助手正常上报、请求得到 accepted/duplicate ACK，管理员“运营统计”在生产或全部环境可查询。用户归属、匿名统计、Token 和 Skill 口径与旧服务相同。新分支启动时不加载 `node:sqlite`，不会新建或更新旧 `analytics.sqlite`。

## 中断处理

- **没有 `step: starting` 就退出**：失败发生在参数解析或配置读取/校验阶段，尚未连接 ClickHouse。错误日志带 `stage`，配置错误另带实际 `configPath`；`WEBSITE_CONFIG_INVALID` 的 `issues` 只列字段名、校验类别及不支持的字段名，不打印字段值。请用 `pnpm tracking init --config /实际路径/website.json` 明确选择完整配置。
- `WEBSITE_CONFIG_ENOENT` / `WEBSITE_CONFIG_ENOTDIR`：核对日志中的配置路径；`WEBSITE_CONFIG_EISDIR` 表示传了目录而非文件；`WEBSITE_CONFIG_EACCES` / `WEBSITE_CONFIG_EPERM` 表示当前 Linux 用户无权读取。
- `WEBSITE_CONFIG_INVALID_JSON`：修正 JSON 语法，不使用注释或尾逗号。`WEBSITE_CONFIG_INVALID`：按 `issues.field` 修正字段；`unrecognized_keys` 的 `keys` 需移除或按本手册迁移，尤其是旧 `analytics.writeBackend` / `readBackend` / `dual` / `query` / `clickhousePrimary`。不要删除现有 ClickHouse 连接配置；密码只填环境变量名，超时应为数字。
- `WEBSITE_CONFIG_LEGACY_ENV`：改用 `DSH_OPS_WEBSITE_CONFIG` 或 `--config`，不能仅设置旧 `DSH_OPS_RELEASE_CONFIG` / `DSH_OPS_WEBSITE_CONTENT_CONFIG`。`WEBSITE_CONFIG_LOAD_FAILED` 是尚未归类的配置异常，需要保留日志中的阶段和路径继续定位。
- 网络或 ClickHouse 写入失败：解决连接/权限问题后重跑同一命令。每批先恢复未完成提交，再继续补数；不要删除 `clickhouse-pending.json`。
- `SINCE_REQUIRED` / `SINCE_MUST_BE_ISO_TIMESTAMP_WITH_TIMEZONE`：补上带 `Z` 或 `+08:00` 等明确时区的 `--since` 时间。
- `TRACKING_TIMEOUT_MUST_BE_1000_TO_300000_MS`：`--timeout-ms` 必须为 1000–300000 范围内的整数毫秒。
- `ANALYTICS_NOT_INITIALIZED_RUN_TRACKING_INIT` 或表不存在：核对目标库，停写后执行 `pnpm tracking init`。
- `ANALYTICS_LOCKED`：先确认旧进程已停止且没有远端在途写入，再检查 `.tracking.lock`。服务和 CLI 正常退出会释放锁；崩溃遗留锁不自动抢占。
- `ANALYTICS_PENDING_TARGET_MISMATCH`：当前 runtime 目录中有另一连接/数据库/epoch 的待提交记录。恢复原配置完成该批；不要直接丢掉记录或混用目录。
- `ANALYTICS_PENDING_EXPIRED`：待提交超过七天，停止重试，检查 CH 与旧源后人工决定恢复方式。
- HTTP 错误只输出状态及 ClickHouse 数字错误码，不打印服务端 SQL/行内容；按 queryId 在受控服务日志中定位。补数不会自动跳过连接失败的整批并宣告成功。

新服务运行后，以 ClickHouse 为数据来源。旧 SQLite 不再追平；此分支不提供回 SQLite 开关。备份 ClickHouse 数据和 `.runtime` 中的待提交记录，备份恢复需确保只有一个 writer。

## 开发与 CI 验证

```bash
CH_TEST_URL=http://127.0.0.1:18123 \
CH_TEST_USER=analytics_admin \
CH_TEST_PASSWORD="$CH_ADMIN_PASSWORD" pnpm check
pnpm build
```

测试只创建和删除 `website_test_<uuid>` 隔离数据库，账号需有该测试库的创建/删除权限。未设置 `CH_TEST_URL` 时，真实数据库测试明确标为跳过；CI 固定启动隔离 ClickHouse 并执行它们。测试覆盖写入与查询、员工资料、乱序终态、重试、中断恢复、旧版本表接管和重复补数；不向生产库写入测试事件。

HTTP 同步插入及响应规则参考 [ClickHouse HTTP 文档](https://clickhouse.com/docs/interfaces/http)；版本去重查询参考 [ReplacingMergeTree 文档](https://clickhouse.com/docs/engines/table-engines/mergetree-family/replacingmergetree)。

## 数据库 DDL 管理

ClickHouse 当前 schema 与编号 migration 统一保存在 [`db/clickhouse`](../../db/README.md)，MySQL 使用独立预留目录。初始化直接读取版本化 SQL，构建同步到 `dist/db`；执行顺序及现有接管行为不变。新增 migration 须同时补充已有库升级路径，不能仅添加 SQL 文件。
