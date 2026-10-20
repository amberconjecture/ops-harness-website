# ADR 0027：运营数据恢复 SQLite 业务字段

状态：已实施，2026-10-20。新后端、在线全量与多轮增量升级 CLI、定期维护已实现，替代 ADR 0026 的在线 key/payload 布局。已在隔离 ClickHouse 验证，未连接生产库或迁移生产数据。

## 结论与交付

继续使用 ClickHouse，保留 10 张业务表，字段集合与历史 SQLite v3 中对应表完全一致。常规统计直接读取类型化业务列；原始事件 `body` 和操作上下文 `accepted/terminal` 保留 JSON。

本次按评审要求删除五个公共技术字段：`source_epoch`、`commit_seq`、`is_deleted`、`row_hash`、`physical_delete_at`；删除六张控制表：`tracking_runtime`、`published_watermarks`、`tracking_commits`、`schema_migrations`、`migration_runs`、`migration_chunks`。不以改名字段、隐藏列或新的控制表替代。

这同时撤销新后端的固定水位快照和数据库提交日志设计。新结构只保存业务当前状态，需要单进程串行读写、失败批次本地恢复，不能继续宣称具备跨表数据库事务或历史快照能力。在线迁移只读取旧源已有的水位与日志，增量断点保存在本地文件，不将这些控制表重新建到目标库。

交付包括 [SQLite 历史结构](../design/tracking-v2/sqlite-v3-reference.sql)、[目标 DDL（逐字段中文注释）](../design/tracking-v2/schema.sql)、[当前状态视图](../design/tracking-v2/views.sql)、[使用及验证说明](../design/tracking-v2/README.md)、[迁移方案](../runbooks/tracking-typed-migration.md)。运行 DDL 已落入 `db/clickhouse/migrations/0001_tracking_typed.sql` 与 `db/clickhouse/schema.sql`；类型化结构作为唯一初始迁移记录，旧布局定义仅保留在测试夹具中。此次重新编号不改变 DDL 或已有迁移断点。设计目录保留评审 SQL 快照，不重复作为运行 migration 加载。

## 历史依据与当前问题

参考提交 `da75d733891a38ed936aa182f37e91aa734cb291`（`0f4fc66^`）的 SQLite v3：11 张业务表及 `schema_version`。其中仅原始事件和操作上下文存 JSON，其余均为业务列。

旧 ClickHouse 的 11 张业务实体表采用 `key/payload`，查询先按 key 聚合，再逐列解析 JSON，才进行日期等业务筛选。恢复显式列能去掉这一层通用 JSON 解码，直接筛选日期和业务维度。未访问生产数据和查询日志，不能把所有空结果都归因于这个结构，也没有生产性能数字。

## 十张表的职责

| 表 | 字段数 | 逻辑键 | 一行代表什么 |
| --- | ---: | --- | --- |
| `users` | 10 | id（全局） | 用户当前资料；issuer/subject 标识其来源身份，资料更新时间防止旧快照覆盖新资料 |
| `user_identities` | 4 | tenant、issuer、subject | 外部身份到内部 user_id 的映射 |
| `installations` | 4 | tenant、installation | 客户端安装的登记环境与最近接收时间 |
| `identity_sessions` | 6 | ref（全局） | 绑定用户与安装、具有有效期的身份引用 |
| `event_dedup` | 4 | tenant、id | 事件 ID 对应的内容摘要与接收时间，用于区分重试和冲突 |
| `operations` | 6 | tenant、installation、operation | 同一操作的完整受理事件、终态事件及终态幂等摘要 |
| `activity_facts` | 19 | tenant、id | 事件的统计维度与活跃/成功/待匹配标记 |
| `runtime_facts` | 17 | tenant、id | 对话用量或 Skill 加载的补充事实 |
| `tracking_events` | 4 | tenant、id | 一条原始事件正文及服务器接收时间 |
| `ingestion_health` | 2 | code | 某个拒收原因的全局累计次数，不具备日期或环境维度 |

全部 76 个字段的类型和含义逐列写在 schema.sql 的 `COMMENT` 中。ID 保持字符串，工号保留前导零；时间为毫秒精度 UTC，day 是 Asia/Shanghai 业务日期；NULL、空串和零保持各自语义。在线写入拒绝非零亚毫秒精度、无效日期或越界整数。升级遇到无效历史记录会停止，不截断、填零或跳过；允许丢失的范围仅为最终切换前不超过 5 分钟的未同步变更。

关联使用同租户键，users.id 和 identity_sessions.ref 仍为全局业务标识，tenant 不参与它们的去重键。业务唯一性和引用规则不因换引擎而放宽；ClickHouse 的排序键不提供 SQLite PRIMARY KEY / UNIQUE 的即时拒绝能力，具体补偿要求见下文。

## 与 SQLite 的全部差异及处理决定

以原 SQLite v3 的 DDL、写入、查询和维护代码为基准。以下决定已落实到运行代码和 DDL；数据库本身不提供的约束由应用补偿，不能把它们视为 ClickHouse 原生事务或唯一约束。

| 差异 | 决定及最终设计 | 判断依据 / 代价 |
| --- | --- | --- |
| 十张保留表的表名、列名、列数、列顺序 | 保持 SQLite，共 76 列 | 不新增业务维度，不重命名原字段 |
| `user_day` 未迁入 | 保留删除决定 | SQLite 写入维护但九类查询均不读取；事实可按原公式重算，省去无消费方的同步汇总。不是因为 CH 迁移方案曾经停写；详见专项证据 |
| `schema_version` 未迁入 | 保留删除决定 | 它记录 SQLite 1/2/3 的升级，不是目标 CH 的版本。当前升级来源为旧 CH，SQLite 结构保留为历史依据；目标构建携带完整结构清单并在启动时核验，识别结构兼容性。遵守不新增控制表的要求 |
| 五个公共字段、六张新增控制表 | 继续删除 | 已按用户要求撤销；不改名重新引入 |
| `runtime_facts.day/environment` | 继续不添加 | 原 17 列足够；查询已有事实关联，无压测依据支持冗余 |
| 两张 JSON 表的额外拆列 | 继续不添加 | `tracking_events` 4 列、`operations` 6 列；保留 JSON 原串，包括暂缓的 duration_ms、accepted_at、terminal_at |
| `users` 去重键从全局 id 扩为 tenant/id | **恢复全局 id**，`ORDER BY id` | 原唯一范围不应变化；租户隔离由授权和查询条件负责 |
| `identity_sessions` 从全局 ref 扩为 tenant/ref | **恢复全局 ref**，`ORDER BY ref` | 防止把身份引用的唯一范围改成租户内 |
| `activity_facts` 排序键包含 day/environment | **恢复 `(tenant,id)`** | 日期和环境是业务属性，不应使同一事件变成多条独立记录；其余七张表原复合键 / code 键保持 |
| 活动事实按月分区 | **撤销**，十张表均无显式分区 | 避免同一事件不同日期落在不同分区，恢复原去重范围；代价是不能按月快速删分区，日期查询须实测 |
| `event_dedup.digest FixedString(64)` | **恢复普通字符串**，`Nullable(String)` | 原来是 TEXT；FixedString 会补零或拒绝长值，不负责验证 SHA-256，没必要增加这种存储限制 |
| INTEGER 改 UInt64/UInt8、增加四个布尔 CHECK | **恢复有符号 Int64，撤销新 CHECK** | 保留 SQLite 整数的有符号 64 位范围，不改变数值域来做未经验证的优化；0/1 和非负业务要求仍由原采集规则验证 |
| 非键字段增加 NOT NULL | **恢复全部 57 个非键字段可空** | 原 SQLite 没有这些非空约束，不应仅因换库拒绝历史 NULL；正常 writer 仍应写出原有空串、零和 NULL，不能随意互换 |
| 业务键原 DDL 也可存 NULL | **保留 19 个键列非空要求** | 原表是普通 rowid 表，TEXT / 复合 PRIMARY KEY 可接受 NULL，但不是应用生成记录的合法标识。目标必须有确定的替换键；历史空键作为无效行报告并停止迁移，不能补空串、跳过或悄悄合并 |
| TEXT 时间和业务日期改类型 | **保留** `DateTime64(3,'UTC')` / `Date`，均可空 | 直接做时间比较和日期聚合，统一 UTC 毫秒 / 上海业务日。目标类型有表示范围，迁移逐值核验；不能静默截断或使用当前时间替代 |
| 16 个分类字符串使用 LowCardinality | **保留字典编码**，非键列使用 `LowCardinality(Nullable(String))` | 值域仍是字符串，不是固定 Enum；减少重复文本存储，保留 NULL / 空串。是否值得长期保留须以真实基数和扫描量检验 |
| SQLite 动态类型与缺列默认 NULL | **保留强类型及显式全列写入** | 类型化是本次重构目的；非键列省略虽会得到 NULL，writer 仍禁止缺字段，防止完整行替换抹掉旧值。非预期类型报错，不宽松转换、填零 |
| 查询结果的类型和 NULL 行为 | **保持原 API，适配数据库输出** | 时间仍输出 ISO UTC 毫秒字符串，日期输出 YYYY-MM-DD；64 位整数无损解码后按既有响应契约输出。CH 聚合空集默认值和外连接默认值与 SQLite 不总相同，要按原 COALESCE 位置使用 sumOrNull / sum、设置 join_use_nulls=1，不把 NULL / 空串 / 零混同 |
| PRIMARY KEY / UNIQUE 即时检查消失 | **保留原业务约束，改由串行 writer 校验** | ReplacingMergeTree 是合并机制，不是唯一约束；尤其不能丢掉 users 的 `UNIQUE(tenant,issuer,subject)` |
| runtime 外键与 ON DELETE CASCADE 消失 | **保留引用和级联行为，由 writer / 维护补偿** | 原唯一显式外键是 runtime → activity。SQLite 没有的其他外键不冒充“恢复”，但仍检查原业务的同租户关系 |
| 原三条 B-tree 索引未移植 | **保留引擎差异，列为性能验收项** | CH 没有同等 B-tree 二级索引。原事实窗口、操作关联、Skill 统计查询必须保留并压测，不能宣称排序键等价替代 |
| 新增 `event_lookup` bloom 索引 | **撤销** | 恢复 `(tenant,id)` 后带租户的事件点查已有排序键；没有独立收益证据，暂不加冗余索引 |
| 行存与 UPDATE/UPSERT → 列存与完整行替换 | **保留必要适配** | 当前仍选 CH；未变字段要从当前状态复制，完整行保留 NULL；重试不能覆盖后续写入 |
| 10 个 `_current` 视图与 FINAL | **保留** | 统一读取合并后的当前值，防止后台合并前重复计数；视图无存储副本、无自动授权和过期筛选 |
| SQLite 跨表事务 / 回滚 → 互斥及批次恢复 | **保留应用互斥及恢复，明确非等价** | 已验证整次查询互斥、部分插入及删除中断恢复；应用阻止半批次被读到并完成失败批次，不能提供 SQLite 原生回滚 |
| 普通查询新增 90/120/400 天自动过滤 | **撤销，恢复维护任务清理生效** | SQLite 清理前，超期但仍存在的行可被普通查询读到；目标只按请求筛选，不额外提前隐藏。身份有效期、上报窗口等原业务校验继续保留 |
| 保留时长、删除边界、自动 TTL | 保持原 90/120/400 天及严格小于边界；继续不设自动 TTL | 按一次维护固定时刻选键，等所有物理版本和 runtime 子记录删除完成再放行 |
| SQLite rowid、自带主键索引、WAL/PRAGMA | 不模拟这些引擎内部对象 | rowid 未作为业务字段使用；CH 使用自身持久化机制和 fsync 设置，不能以此声称恢复了 SQLite 事务 |

最终字段类型总计：19 个非空键列（18 个 String、1 个 LowCardinality(String)）；57 个可空非键列（22 个 Nullable(String)、15 个 LowCardinality(Nullable(String))、7 个 Nullable(DateTime64)、1 个 Nullable(Date)、12 个 Nullable(Int64)）。没有 DEFAULT 业务值或 CHECK；NULL 的迁移和业务处理必须显式保留。

原索引的查询职责仍需覆盖：`facts_window(environment,day,user_id)` 服务窗口/用户统计；`facts_operation(tenant,installation,operation)` 服务受理晚到时定位终态；`runtime_skill(skill_name)` 服务 Skill 分组。新版首先保留正确查询和原逻辑键，不新增未经验证的投影、派生表或索引。上线前用原九类查询、用户筛选、操作解挂和 Skill 查询测扫描量、延迟、合并/清理停顿；若不达标，须先形成不改变事件唯一范围的物理优化方案再切换，而不是直接接受回归。

writer 在同一互斥门内完成预检与写入：全局 id/ref 冲突不能被解释成跨租户更新；users 的完整非空身份三元组不能映射到两个用户，含 NULL 的组合沿用 SQLite UNIQUE 的 NULL 语义；批内新记录与当前记录一并检查；runtime 插入前存在同租户事实；删除事实时先删 runtime。升级器按用户、引用、事实的依赖顺序逐批核验后写入；身份唯一性冲突和真实孤立引用直接停止，随过期父事实清理的 runtime 计入 expired。复制与追平期间不允许目标服务启动，最终显式启用且满足时限后才允许启动。重复上报沿用原 digest / ACK 决策，不能把数据库任意重复 INSERT 都视为合法业务重试。

## user_day 是否必要：以 SQLite 实现为依据

依据迁移前提交 `da75d733891a38ed936aa182f37e91aa734cb291` 重新核对：SQLite 每批仍在同一事务中维护 user_day，但它的九类统计查询全部读取 activity_facts 及关联表，没有读取 user_day；初始提交 `e96cf39` 也如此。不能以迁移 ClickHouse 后停写为理由，更不能将 SQLite 的历史状态描述为“已经停用”。完整字段、历史代码位置、能力边界及可复现验证见 [SQLite user_day 分析](../design/tracking-v2/sqlite-user-day-analysis.md)。

原表按 `(tenant,day,user_id,environment)` 汇总已识别且 pending=0 的事实，保存 active、logins、interactions、successes；没有独有事实，与活动事实同样保留 400 天。受影响日期整日重算，受理晚到会重算终态所在日期，不是简单累加。

它能加速无版本/平台筛选的 DAU、MAU 和活跃天数。因为保留 user_id，也能跨环境正确去重；不能简单相加环境人数，但这不是删除它的理由。其限制是缺版本/平台及功能等维度，logins 只统计 auth.login.succeeded，与 SQLite 页面“前台活动用户”口径不同；按日交互计数相加也不能普遍替代范围内精确去重。

因此当前设计继续不把原 user_day 作为必需表，保留日汇总作为后续性能优化选项。是否启用应基于明确的汇总查询路径与压测，而不是仅凭“可重算”或“列不够”下结论。132 项隔离断言已验证：旧 SQLite 九类查询在六组筛选下，清空和 DROP user_day 前后结果均一致；但旧写入和清理会报缺表，实施时必须一起移除 rebuildDays/dirtyDays 和对应清理，保留晚到事件修复事实的逻辑。

升级保留源备份，当前 CH 在线升级不导入 user_day，也不要求重建它作为切换步骤；SQLite 原公式保留在专项验证中。不把历史汇总预先判定为陈旧，也不声称事实缺失时仍能无损重建。

## 为什么 runtime_facts 删除 day 和 environment

上一版增加这两列，是为了让运行事实独立按日期/环境裁剪和分区，属于预期的查询优化，并非 SQLite 原有字段，也没有实测证明必须冗余。

现有查询已经通过 `(tenant,id)` 将 runtime_facts 关联 activity_facts，日期、环境、平台、版本、用户和 pending 条件都来自 activity_facts。因此恢复原 17 列；runtime 不再按不存在的 day 分区，也不单独设置日期 TTL。它的业务日期、环境与过期清理由对应活动事实决定。后续若性能实测要求冗余字段，应另提变更并提供扫描量与延迟证据。

## 两张 JSON 表是否真的按子字段查询

| 表及 JSON 字段 | 当前实际用途 | 设计处理 |
| --- | --- | --- |
| tracking_events.body | clickhouse-query.ts 的 operations 接口选出正文后，在 TypeScript 读取 durationMs 组装响应；没有以 body 子字段执行 SQL WHERE/GROUP BY/ORDER BY | 恢复 tenant、id、body、received_at 四列，durationMs 不单独拆列 |
| operations.accepted / terminal | 旧 CH 的 logicalTableSql 曾用 JSON occurredAt 做读取时保留期过滤；新版与原 SQLite maintain 一样用它决定清理，终态时间优先；backfill.ts/sourceFilters 用 eventId 关联接收时间、occurredAt 作为补数时间回退 | 保留原 JSON 六列；恢复 SQLite 的维护清理时机，不新增普通读取过滤，不把整段上下文拆列 |
| operations.accepted / terminal | database.ts 按 terminal.eventId 找待匹配事实；decision.ts 在内存比较 action/module/identityRef/employee/initiator/interactionId/properties/occurredAt，做两端匹配、保留期判断及晚到解挂 | 属于按业务键取出后的状态逻辑，完整保留 JSON 与现有比较规则 |

注意管理 API 名为 `operations` 的列表查询，实际使用 `activity_facts + tracking_events + users`，不是对操作上下文表逐个 JSON 字段做业务搜索。列表的日期、环境、平台、版本、用户筛选来自事实列，功能、动作、结果也从事实列返回。

原 JSON 字符串及 terminal_digest 原样迁移，不重新 JSON.stringify、不改摘要算法、不从仅保留 90 天的原始事件反推保留 120 天的操作上下文。两端未齐时保持 NULL，终态先到仍写 pending=1，受理晚到后只更新对应终态事实的 user_id/pending。既有事件匹配与 ACK 业务语义保持。

## 无版本列的当前状态存储

使用无版本参数的 `ReplacingMergeTree()`，业务排序键相同的多次完整行写入由 `FINAL` 选择最后插入的数据；后台合并时间不确定，普通 SELECT 可能看见多行。因此提供 10 个普通 `*_current` 视图，统一 `SELECT * FROM ... FINAL`。它们没有水位参数，不保证跨表快照，不自动做权限或保留期过滤。[官方去重说明](https://clickhouse.com/docs/engines/table-engines/mergetree-family/replacingmergetree)

“最后写入”不是“事件时间最新”。所有更新和重试必须串行；旧请求的执行结果未确认前，不能开始后续批次，否则旧重试可能覆盖新状态。完整行写入保留显式 NULL，不能把每个可空字段分别聚合。reader 每次查询设置 `optimize_move_to_prewhere_if_final=0`，禁止将 user_id/pending 等可变列手动放到 FINAL 之前的 PREWHERE。

在线增量迁移在串行写入目标前按业务键批量读取 FINAL 当前行，比较全部类型化字段，完全相同的行不再重复插入，计入 unchanged 并照常推进断点。真实更新仍写完整行；删除和级联顺序不变，不因父行已不存在而省略删除。该优化不改变表引擎，也不清理已有物理重复；恢复不确定写入仍先完成原 pending 批次，再对日志重放去除相同行。

十张表均不声明 PARTITION BY，使用默认单分区；活动事实只按 `(tenant,id)` 排序。日期、环境以及其他非键属性不参与记录身份，修正属性后仍是同一条事实。正常上报仍按原摘要规则拒绝同 ID 不同内容，并不因此允许客户端修改事件；恢复主键只是不再增加“属性不同即另一条记录”的存储语义。移除新加的 id bloom 索引。runtime 通过关联获取日期，其他二级访问路径的优化由实测决定。

## 批次失败、读写互斥与清理

删除数据库控制结构以后，运行实现采用以下保障；旧后端不能直接套用新 DDL：

1. 单实例拥有整个 tracking 读写入口。一次写入决策和所有表写入、一次管理请求的全部子查询、维护清理共用互斥门；多实例直写或绕过应用的 SQL 读者不具备同样的一致性。读锁覆盖整个管理请求，不能只锁其中一条 SQL。
2. 变更前在 config 指定 analyticsDirectory 原子落盘一个待完成批次文件，包含目标绑定、完整行新值、需要删除的业务键及原响应；fsync 文件和目录。它仅恢复当前批次，不保存历史水位或七天提交日志。全局累计 count 保存计算后的完整值，重试不能再次加一。
3. 同步写入并读回核对全部结果后，原子完成本地批次状态，再发送 ACK。进程重启或任一步失败时，关闭新写入和管理查询，先确认旧查询均已结束，再按原顺序重放同一批次；不得重新决策、分配 ID 或生成时间。超时不等于服务器停止，无法确认结果时保持恢复状态并返回可重试 503。
4. 删除没有 tombstone。先在互斥门内固定待删除业务键，将删除计划写入待完成文件，再以业务键删除所有物理副本，等待 mutation 完成，恢复也先完成原计划。runtime 先于对应活动事实删除。只有全部完成后才开放后续批次，防止旧版本复活或迟到写入恢复旧数据。

不配置自动 TTL，以免独立后台清理在多条查询之间改变可见集合。恢复 SQLite 的可见性：普通查询只执行请求指定的条件，不额外加滚动保留期过滤；超期但尚未被维护清理的行仍可读。维护任务固定本次时刻 T，从 FINAL 当前行选出待删业务键，再批量执行 `ALTER TABLE ... DELETE ... SETTINGS mutations_sync=1` 删除这些键的所有物理版本（目标是单节点非复制表），确认完成后放行。这个操作需要显式 ALTER DELETE 权限，部署应将维护权限与普通查询权限区分；删除会重写数据 part，需通过演练确定批量和窗口，不能按每个事件频繁执行。[官方删除说明](https://clickhouse.com/docs/sql-reference/statements/alter/delete)

| 数据 | 维护删除条件，T 为一次维护固定的当前时刻；恰好在边界的行保留 |
| --- | --- |
| tracking_events | received_at < T - 90 天 |
| event_dedup | received_at < T - 120 天 |
| identity_sessions | expires_at < T - 120 天；身份使用时仍另查真实有效期 |
| operations | terminal.occurredAt 优先，否则 accepted.occurredAt，< T - 120 天 |
| activity_facts | day < shanghaiDay(T - 400 天) |
| runtime_facts | 级联删除本次待删活动事实对应的记录 |
| users、user_identities、installations、ingestion_health | 沿用既有长期保留，不增加清理字段 |

可空时间与 SQLite 一致：NULL 与截止值比较不成立，不能默认成 epoch、零日期或“已过期”。JSON 时间取值沿用原 COALESCE 规则。异常值单独报告；原有身份有效期、事件接收窗口和操作两端匹配规则与数据库保留期清理分开，不因恢复查询可见性而撤销。

本地批次文件和数据库需要配套备份；如果部分写入后该文件丢失，仅凭这 10 张表无法判断跨表批次是否完整，必须停止服务并从一致备份恢复。数据库原生快照、多进程并发发布、任意历史回退均不在本设计能力范围内。单实例串行读写的真实吞吐和维护停顿仍需按部署数据量验证。

## 实施边界

已实现类型编解码、完整批次恢复与整次请求互斥、显式列查询、启动及每小时清理、可续跑升级工具，并完成插入响应丢失、清理中断、阻止半批次读取等故障测试。历史 SQLite 实现直接参与对照：九类 API × 六组筛选，在清理前、100 天后及 401 天后比较结果。operations 的 JSON 匹配逻辑沿用，user_day 写入和清理一起移除。

按用户要求，旧服务在全量与多轮增量迁移期间持续运行。首轮按固定已发布水位读取旧版本表；随后从旧 `tracking_commits` 的序号范围读取增量，只复制上轮之后的完整变更，包含更新和删除。合并重复更新时保留删除顺序，避免级联删除后重建父记录时复活子记录。中断后先完成原轮，再进行下一轮；缺失日志或来源身份改变会阻止切换。按后续要求，取消首轮超过旧源 TTL 宽限期后的强制中止，保留原目标库、固定水位、时间和分页游标，继续复制源端仍可读取的记录；每次命令在发现超龄时仅提示一次。格式 2 断点及来源绑定保持兼容，不增加绕过参数。超龄后旧源已被 TTL 物理删除的记录可能缺失，不能保证原历史快照完整；增量仍须在旧日志过期前持续追平。

最后 `upgrade --finalize` 检查取水位时的服务器时间距当前不超过 5 分钟，并写本地 armed 状态。新实例在独立端口启动，readiness 检查通过后，由部署网关在报告期限内切换全部流量并排空旧请求；旧实例在此之前保持服务。第一次新业务写入再次检查时限，原子标记 active，此后拒绝旧库导入。readiness 和启动不会标记 active；过期时可停止尚未承接流量的新实例、重新追平后启动。没有双写或目标数据库控制表，迁移身份、水位和状态保存在新 analyticsDirectory。

切换时允许放弃的是最后取水位之后到旧端结束接收和在途处理之间的变更；窗口按服务器提交/ACK 时刻计算，不按客户端事件时间计算。要满足 5 分钟上限，网关切换与排空也必须在该期限内完成，程序无法替外部网关关闭旧流量。这个上限不涵盖超龄全量期间源 TTL 造成的历史记录缺失。读取到的历史无效行、摘要损坏、唯一性冲突或关联缺失仍一律停止，撤销离线方案的 100 行跳过阈值。追平速度大于新增速度时，积压通常逐轮下降，但不承诺耗时严格递减。完整命令、部署前提、错误处理及回退见运行手册。

不引入 MySQL，不恢复 SQLite 在线后端，不修改 vendor，不接入 DSH。官网其他文件存储、鉴权、CSRF、Host/Origin 校验、发布归档与源码同步流程不变。上线前按真实数据量验证点查、统计、关联及维护停顿，不从小样本 DDL 测试推断生产速度。
