# 类型化运营数据库升级与清理

2026-10-20 已实施，替代旧 key/payload 在线后端。目标为 10 张业务表、76 列和 10 个当前视图，DDL 在 [db/clickhouse/schema.sql](../../db/clickhouse/schema.sql)，决定见 [ADR 0027](../adr/0027-typed-tracking-schema.md)。只支持单节点、单官网 writer；不引入 SQLite 在线后端。

## 不停机升级：全量、多次增量、切换

旧官网在整个复制与追平期间继续提供服务，迁移命令只读旧库。目标使用同一 ClickHouse 连接地址下的独立新数据库和本地目录。旧库、目标库各自只有一个 writer；新官网与迁移 CLI 不得同时写目标库。无需修改旧官网、双写或增加数据库控制表。

不停机切换需要部署侧能同时运行新旧两个官网实例，并由已有网关切换流量；仅在一个端口先停止旧进程再启动新进程会产生服务中断。以下步骤假设已有 HTTPS 网关，新实例仅监听另一个 loopback 端口。本命令不修改网关或部署生产实例。

### 1. 准备新构建与独立配置，保持旧实例运行

在独立发布目录使用 Node.js 24、pnpm 11.19.0 执行 `pnpm install --frozen-lockfile`、`pnpm build`。不要覆盖运行中旧实例的构建或配置。保留旧构建、配置、analyticsDirectory 和数据库备份；旧库自己的 TTL 仍会自然清理，保留旧库不能替代备份。

复制完整配置为 `/srv/website/config/website.next.json`，调整：

- `analytics.clickhouse.database`：全新库，例如 `website_analytics_typed`。
- `analyticsDirectory`：全新目录，例如 `../.runtime/website-analytics-typed`。
- `host` / `port`：`127.0.0.1` 和未占用的新端口，例如 `4319`。

保留原 `websiteUrl`、采集开关、凭据环境变量名和其他官网设置。路径相对于配置文件所在目录解析，确保内容及发布目录仍指向正确位置。先不要给新实例分配业务流量，也不要启动它。源数据库以下以 `website_analytics_dual` 举例，必须替换为真实旧库名。

若账号由仓库 `deploy/clickhouse/users.xml` 管理，先部署更新后的 XML 并在线重新加载账号配置，保留原账号、密码和旧库权限；新配置已包含 `website_analytics_typed`。自定义目标库名需要同步修改 XML 授权。不要为了权限变更重启正在提供服务的旧官网或 ClickHouse。

密码通过环境注入，不写入命令或配置文件。CLI 需要 admin、writer、reader 三组凭据：admin 读源库、建目标库并检查授权；SQL 管理的账号可自动补充授权，XML 管理的账号须提前更新。writer 需要目标库 SELECT / INSERT / ALTER DELETE，以及 `system.processes`、`system.mutations` 的 SELECT；reader 需要目标库 SELECT。运行官网只使用 writer/reader，不使用 admin 密码。

### 2. 首轮全量复制

在新构建目录执行，不需要先 init 或手工建表：

```bash
pnpm tracking upgrade \
  --config /srv/website/config/website.next.json \
  --source-database website_analytics_dual
```

首轮捕获已发布水位 W1 和 ClickHouse 服务器时间 T1，复制每个业务键在 W1 的最新状态。期间旧库新增、更新、删除正常继续，下轮追平再处理。成功报告 `mode=baseline`、`phase=ready`；此时新官网仍禁止启动。

读取按键分页：先利用排序键确定本页边界，再聚合该范围内的全部已发布版本，不把同一键的历史版本拆开取最新值。每页完整读完源响应后才写目标库，目标写入耗时不会占用源读取请求的超时预算。

全量中断后继续使用原目标库、原 analyticsDirectory 和原命令。即使断点已超过旧源 TTL 宽限期，也不清库、不重置游标或修改原观察时间；每次命令最多输出一条 `warning=ANALYTICS_UPGRADE_BASELINE_RETENTION_ELAPSED` 并继续复制。无需额外参数。旧源 TTL 已清掉的记录可能无法补回，详见下方数据边界。

### 3. 多次执行同一命令增量追平

```bash
pnpm tracking upgrade \
  --config /srv/website/config/website.next.json \
  --source-database website_analytics_dual
```

可以反复执行。每轮固定新的水位，只读取上次水位之后的 `tracking_commits`，同步新增、更新和删除。它利用旧日志的 `(source_epoch,seq)` 排序键，不再扫描十张实体表的全部历史。批内重复更新合并，遇到删除先完成前一批，避免“删父记录再重建”复活旧 runtime。

增量写入前按业务键批量读取目标 FINAL 当前值，逐行比较全部类型化字段；完全相同的行计入 `unchanged`，不再 INSERT，真实变化仍写入完整行，包括显式 NULL。删除仍执行并保持级联顺序。即使一批全部相同，也会保存已处理提交序号并正常结束；失败批次恢复后重读日志时也会跳过已经恢复为相同内容的行。此优化不会清理原表已有的物理重复，真实更新和不确定写入的恢复仍可能保留多个版本，业务查询继续使用 `*_current` / FINAL。

增量也先读完一页再写入，每页至多 32 个提交序号（batch-size 更小时随之缩小）。一个原提交完整处理；同序号有不同日志内容时直接报错，不会因翻页而漏检。

单次命令有固定终点，不持续追赶运行中旧服务的新提交。`stage=round_start` 报告本轮固定 `throughSeq`，`stage=batch_complete` 报告已处理的 `appliedSeq` 和 `remainingSeqUpperBound`；后者是剩余序号跨度的上界，可能包含明确排除的序号，不等于剩余业务行数。达到终点后完成来源校验并输出 `step=complete`。若 `mode=baseline`，说明仍在续跑未完成全量；只有全量成功后，下次命令才进入增量。若进度长期不变，保留最后几条日志和启动参数，检查当前读取、写入、校验或恢复步骤；单次请求的 5 分钟超时不是整轮总时限。

当复制处理速度大于旧库变更速度时，下一轮需处理的积压通常减少，耗时和可能损失的窗口也随之缩小；每轮仍有连接、结构核验和读回的固定开销，不能保证耗时严格递减。若追平一直不收敛，应先调整负载或资源，不能忽略切换检查强行上线。

完成报告包含：

| 字段 | 含义 |
| --- | --- |
| `round`、`mode` | 已完成轮数；baseline 或 incremental |
| `fromSeq`、`throughSeq` | 本轮起始水位与已完整复制的目标水位 |
| `observedAt`、`finishedAt` | 取水位及完成复制时的 ClickHouse 服务器时间 |
| `lagMs` | 本轮完成时距取水位的时间，是潜在缺口窗口的保守上界 |
| `cutoverDeadline` | `observedAt + 5 分钟`，网关切换和旧请求排空必须在此前完成 |
| `tables` | 各表本轮 `read / written / deleted / expired / unchanged`，不含事件正文或员工资料；旧断点没有 unchanged 时按 0 累加 |

全量 `read` 是逻辑键数量，增量 `read` 是日志中该表变更数；重复更新合并和跳过相同行后 `written` 可小于 `read`。`unchanged` 统计批内合并后与目标一致而跳过的行数；`written` 不包含启动时 pending 恢复的重放，恢复后的相同行会在日志复制阶段计入 unchanged。没有新提交的追平返回空 `tables`，仍刷新观察时间；不会因旧库长期无事件而误判落后。正常增量不全扫源实体表，只有父事实缺失时按键核验它是否过期。

### 4. 最后一次追平，启用新实例

准备好启动命令和网关切换操作后执行：

```bash
pnpm tracking upgrade \
  --config /srv/website/config/website.next.json \
  --source-database website_analytics_dual \
  --finalize
```

`--finalize` 仍会完成一轮增量，只有 `lagMs <= 300000` 才写入 `phase=armed`，允许新官网启动。**5 分钟从 `observedAt` 开始算，不是从命令结束或新实例启动开始算。** 应在积压很小时执行，为新实例启动、首轮清理和网关切换留足时间。

使用进程管理器在新端口启动新构建，传入新配置；手工启动的等价命令是：

```bash
DSH_OPS_WEBSITE_CONFIG=/srv/website/config/website.next.json pnpm start
```

在切换前检查新实例：

```bash
curl --fail --silent --show-error http://127.0.0.1:4319/api/tracking/ready
```

应返回 `{"status":"ok"}`。它检查数据库连接、待完成批次恢复和切换时限；原 `/health` 只表示官网进程可响应，不足以判断迁移完成。启动和健康探测不会锁定迁移状态，切换前不要向新实例发送测试采集请求或业务写入。

在 `cutoverDeadline` 前将网关的官网流量整体切到新端口，并排空旧实例已接收的请求、结束旧上游连接，保证旧端不再接收数据。不要把两个实例同时放入负载均衡池。迁移期间后台内容编辑也只通过当前承接流量的实例进行。

新实例第一次业务写入会再次核验 5 分钟时限，随后持久化 `phase=active`，从此拒绝旧库导入；正常重启不再受这次切换时限影响。确认新端采集 ACK，并重新登录管理后台检查总览/用户/操作/对话/Skill；会话保存在实例内存中，切换后需要重新登录。确认正常后停止旧实例及其自动重启，保留回退材料。

若出现 `ANALYTICS_UPGRADE_CATCHUP_REQUIRED` 或 readiness 返回 503，保持网关指向旧实例，停止尚未接流量的新实例，再执行一次 `upgrade --finalize`、重启并检查。不要修改断点时间或删除文件绕过。新库一旦业务写入变成 active，不能再执行这一流程覆盖新数据。

## 数据损失边界与源数据要求

迁移只认旧 epoch 的已发布水位，并排除旧 `excluded` 区间。旧 writer 在完成日志、实体版本和水位发布之后才 ACK；迁移按该水位复制源端仍保留的有效、未过期数据。全量超过旧源 TTL 宽限期后，原快照中的部分记录可能已被物理删除，无法保证历史快照完整，也无法仅凭本次扫描统计已经消失的记录。

切换时允许放弃的是**最后取水位之后，到旧实例停止接收和完成在途请求之间的变更**，包括新增事件及同期更新、删除。按上述期限完成流量切换与排空，这部分窗口不超过 5 分钟；该上限不涵盖超龄全量期间源 TTL 造成的历史记录缺失。CLI 无法替部署系统阻止旧端在期限之后继续 ACK。

窗口按服务器接收/提交时刻计算，不按客户端 `occurredAt` 计算。旧库未发布尾部不被视为已完成提交；未 ACK 的请求由客户端按原协议重试。保留期之外的数据按原规则计入 `expired`，不属于这次切换损失。

历史数据不能因为“允许损失 5 分钟”而任意跳过：非法字段、摘要不符、必要关联缺失、用户身份冲突、日志断档都会阻止切换，**撤销此前“最多跳过 100 个坏行”的离线方案**。用户、身份、安装、事实、原始事件、操作 JSON、runtime 和健康累计值按原业务字段转换，工号前导零、JSON 原串和摘要保持。健康累计值替换为完整值，不重复累加。user_day 与旧控制表不导入目标；每个目标批次仍读回校验。

源版本有 TTL 宽限期（当前旧默认配置为 24 小时，实际读取源配置）。首轮超出该期限后仍允许沿用原断点继续，仅报告保留期提示；这不会暂停或延长旧源 TTL，也不会恢复已经删除的源记录。增量依赖旧库保留 7 天的提交日志，应连续追平，不应停放几天后才继续。日志缺口只能按明确的旧 excluded 区间跳过，其他缺口报错。超龄全量完成后先执行增量追平；直接对旧全量执行 `--finalize` 仍会因超过 5 分钟而返回 `ANALYTICS_UPGRADE_CATCHUP_REQUIRED`，已完成全量会保留为 ready，下次追平再尝试切换。

默认每批 500 条变更，`--batch-size` 允许 1–2000，例如 `--batch-size 100`；一个原提交不会拆开。单次请求默认 300000 毫秒，可用 `--timeout-ms` 调整，这不是本轮总时长或切换时限。Windows 使用同一 CLI，环境变量按 PowerShell 语法设置；本次隔离验收不替代 Windows 平台验证。

## 中断、重跑与回退

新 analyticsDirectory 的 `typed-upgrade.json` 保存固定来源身份、目标 UUID、已复制水位、当前轮游标和切换状态；`typed-pending.json` 保存当前目标写入/删除批次。它们以受限权限原子落盘，不进 Git，也不是新增数据库控制表。

失败后保持旧实例在线、新实例停止，重跑同一命令。先恢复未完成目标批次，再完成原来固定水位的那一轮；即使此时旧库已继续写入也不报错。随后再运行一次，才追平到更新水位。每个完成轮次推进断点，尚未完成的轮次不能用于切换。

状态为 copying / ready 时新服务拒绝启动；armed 允许在期限内启动；首次业务写入变为 active 后，upgrade 即使在新服务停止后也拒绝再运行。迁移目录锁防止同一目标上 CLI 与服务同时运行；它不替代跨主机互斥。

| 错误或提示 | 处理 |
| --- | --- |
| `ANALYTICS_QUERY_TIMEOUT` | 某次 ClickHouse 请求超过时间预算；CLI 默认已是 300000 毫秒，不等于迁移总时限或切换超时。保留启动预算、最后进度及完整错误 JSON，根据 diagnostics 的 operation / phase / queryId 排查。升级到分页读取实现后可沿用原 format=2 断点重跑；若仍超时，检查对应查询及 CH 负载，不能只反复扩大时间预算 |
| `ANALYTICS_UPGRADE_CATCHUP_REQUIRED` | 目标尚未接流量时，停新实例并再次 `upgrade --finalize`；旧实例继续服务 |
| `ANALYTICS_UPGRADE_TARGET_ACTIVE` | 新库已经接收业务写入，不得再从旧库覆盖 |
| `ANALYTICS_UPGRADE_COMMIT_GAP` | 旧日志缺失或过期；检查源日志，无法完整恢复时用全新目标库和目录重做全量 |
| `ANALYTICS_UPGRADE_BASELINE_EXPIRED_USE_NEW_TARGET`（旧版本） | 已取消该强制中止。更新迁移工具，保留原目标库、目录及 format=2 断点，重跑原命令继续全量 |
| `ANALYTICS_UPGRADE_BASELINE_RETENTION_ELAPSED`（warning） | 原全量已超过旧源 TTL 宽限期；提示后继续，旧源已删除的历史记录可能缺失 |
| `ANALYTICS_UPGRADE_SOURCE_CHANGED` | 源 epoch / UUID / 排除区间等身份改变，或水位倒退；不能继续混用来源 |
| `ANALYTICS_UPGRADE_INVALID_ROW` / `INVALID_COMMIT` / 关联或唯一性错误 | 检查并修复源数据后重试；不能计数跳过历史损坏 |
| `ANALYTICS_UPGRADE_CHECKPOINT_OBSOLETE_USE_NEW_TARGET` | 不兼容此前离线 format=1 断点，使用全新目标库和目录；不要删除断点复用已填充库 |
| `ANALYTICS_SCHEMA_MISMATCH*` | 目标字段、类型、键或视图不符；检查库名和构建 |
| `ANALYTICS_LEGACY_PENDING_USE_NEW_DIRECTORY` | 误用旧运行目录，换新 analyticsDirectory，保留旧 pending |
| `ANALYTICS_PENDING_TARGET_MISMATCH` | 数据库被重建或目录来自别处，恢复匹配的库和本地文件 |
| `ANALYTICS_XML_GRANTS_UPDATE_REQUIRED` | 在线更新既有账号的 users.xml 授权后重试 |
| `ANALYTICS_LOCKED` | 确认没有新实例、CLI 或其他主机占用目标库，再检查崩溃遗留 `.tracking.lock`；旧源实例无需停止 |
| `ANALYTICS_RECOVERY_PENDING` | 删除 mutation 未完成，检查磁盘、mutation 和权限，保留本地批次后重试 |

首次迁移使用独立空目标库，续跑复用同一目标库和目录，不允许源目标相同。升级命令不会清空或重建已有目标。不要删除断点/pending 来绕过保护。放弃迁移时保留诊断文件，用另一个全新目标库和目录重新开始。

新库首次业务写入前，可以停止新实例继续使用旧实例。开始写入后，直接切回旧实例会丢失切换后的新数据；没有反向同步或无损回滚命令。

## 没有 TTL 的定期清理

官网启动时执行一次维护，此后每小时执行一次，不重叠调度。查询、采集、身份签发和整个维护过程共用串行队列。后台维护失败会记录安全错误码；如有未完成批次，下一次操作先恢复它，恢复不成功时返回错误，不读取半完成状态。

| 数据 | 删除条件（一次维护固定当前时刻 T） |
| --- | --- |
| tracking_events | received_at < T - 90 天 |
| event_dedup | received_at < T - 120 天 |
| identity_sessions | expires_at < T - 120 天；真实身份有效期仍单独校验 |
| operations | terminal.occurredAt 优先，否则 accepted.occurredAt，< T - 120 天 |
| activity_facts | day < Asia/Shanghai 日期(T - 400 天) |
| runtime_facts | 随本次活动事实级联删除，先删子表 |
| users、user_identities、installations、ingestion_health | 长期保留 |

恰好位于边界的行保留；NULL 时间不按零日期清理。普通查询不额外过滤保留期，超期但尚未维护删除的数据仍可见，保持 SQLite 行为。

维护每批从 FINAL 当前值选最多 1000 个业务键，持久化删除计划，再按键执行 `ALTER TABLE ... DELETE ... SETTINGS mutations_sync=1`，删除所有物理版本并等待完成。不能仅按旧版本的日期删行，也不能在子表和父表删除之间开放读写。大规模积压会延长维护和请求排队时间；新实例在启动维护完成前不开放端口，需将这一时间纳入切换期限，超时则重新追平。普通写入队列和请求超时仍有界，不承诺大规模清理无停顿。

必要时可在停服状态手动维护：

```bash
pnpm tracking maintain --config /srv/website/config/website.json
```

writer 的 ALTER DELETE 用于维护，两个 system 表的 SELECT 用于故障恢复确认。恢复只终止自身已记录的查询并等待该表旧 mutation 完成，随后重放同一批；不授予全局 KILL QUERY，不使用 KILL MUTATION 跳过未完成删除。服务仍要求单 writer 和独立本地目录，目录锁不提供跨主机分布式互斥。

## 新部署与 SQLite 补数

全新空库使用 `pnpm tracking init`，该命令创建并校验 `0001_tracking_typed.sql` 定义的类型化结构及已有账号权限。旧布局定义仅作为测试夹具保留。此次迁移记录重新编号不改变实际 DDL，已有目标库和迁移断点无需重建。结构检查由实际 system.columns / system.tables 完成，没有 schema_version 或 schema_migrations 表。

保留显式离线 `pnpm tracking backfill --sqlite /path/analytics.sqlite --since '2026-10-18T10:00:00+08:00'`，用于选定时间窗口的 SQLite 补数；源只读，需停服，旧 user_day 不导入，无时间的健康累计计数仍按该命令原规则跳过。它不是当前 CH 升级所需步骤，也不支持从空库自动补齐全部 SQLite 历史。SQLite 选中的现存超期行可先导入，之后按正常维护删除，不在补数过程额外改变源可见范围。

## 验证范围

2026-10-20：Node.js 24.14.0、pnpm 11.19.0、ClickHouse 26.3.52.9 隔离实例。`pnpm check` 的 174 项测试全部通过、0 跳过，`pnpm build` 通过。测试覆盖真实数据库读写、唯一性与引用、失败恢复、读取互斥、清理边界和升级；历史 SQLite v3 源码仅作为测试夹具，九类查询在六组筛选、清理前/100 天后/401 天后共 162 次响应对比通过。

在线迁移测试在复制过程中持续向旧库发布提交，验证多轮收敛、增量不扫描全部实体历史、同键更新合并、删除后重建不复活子记录、中断后续跑固定水位、excluded 区间、日志断档/损坏、快照超出 TTL 宽限期、空增量刷新、5 分钟边界、HTTP readiness、首次写入再校验及 active 后拒绝导入。真实坏行直接阻止迁移，101 个随父事实过期的 runtime 行则正常计入 expired。没有连接生产库或执行生产网关切换；生产规模吞吐、清理停顿及磁盘空间须按实际负载观测。

另使用 `dist/scripts/tracking/cli.js` 与 `dist/server/main.js` 完成真实进程验收：首轮复制到水位 1，新增旧提交后增量到 3，最终追平到 4；新官网 readiness 与实际采集均返回 200，首次采集落盘 active，停止新官网后再次导入仍被拒绝，旧源保持不变。测试使用独立数据库与临时内容/发布目录，容器、匿名卷和临时文件验收后清理。

后续超时修复：已在本地 HTTP 服务复现“消费者逐批写入时，源响应仍占用请求时间，最终 body 超时”。改为完整读取有限页后写入，并保留源固定水位、格式 2 断点和全部切换检查；回归覆盖同键多个版本、删除、分页后的增量、多个 excluded 区间及页边界日志冲突。修复后 `pnpm check` 的 176 项测试全部通过、0 跳过，`pnpm build` 通过，随后补强的多版本与 excluded 分页用例也单独通过。

取消全量超龄中止后，再次通过隔离 ClickHouse 上的全部 176 项测试（0 跳过）及构建。回归验证部分分页完成后中断、格式 2 断点超龄、旧源继续发布新提交、沿用目标身份与原游标续跑、不重写已完成分页、原水位与切换期限保持不变、每次命令仅提示一次，以及后续增量追平和切换。

增量相同行优化后，隔离 ClickHouse 上的 177 项测试全部通过（0 跳过），`pnpm build` 通过。新增回归覆盖十张表的重复快照不产生目标 INSERT、全相同批次仍推进断点、中断后按固定终点续跑、复制期间新增旧提交留到下一轮，以及真实资料更新和 NULL 清空仍写入。关闭测试用户表的后台合并后，重复快照期间物理行数保持不变，真实更新仅增加一行；未对生产库执行清理。
