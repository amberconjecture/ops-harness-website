# 运营数据库结构与验证依据

这是 [ADR 0027](../../adr/0027-typed-tracking-schema.md) 的可检查 SQL，配套 [迁移方案](../../runbooks/tracking-typed-migration.md)。运行代码和 CLI 已于 2026-10-20 接入；正式运行结构在 `db/clickhouse`，本目录保留评审 SQL 快照，不会重复加载为运行 migration。

| 文件 | 用途 |
| --- | --- |
| sqlite-v3-reference.sql | 从 Git 历史恢复的 SQLite v3 完整表及索引，含 11 张业务表与 schema_version |
| schema.sql | 10 张业务表，共 76 个原 SQLite 字段，每个字段有中文 COMMENT；无公共技术字段及控制表 |
| views.sql | 10 个普通 *_current 视图，使用 FINAL 返回业务当前状态 |
| verify.mjs | 隔离验证字段集合、去重、NULL 更新、关联筛选、JSON 保留与物理删除 |
| sqlite-user-day-analysis.md | 仅依据历史 SQLite 分析 user_day 的维护、实际查询依赖和潜在加速价值 |
| verify-sqlite-user-day.mjs | 运行历史 SQLite 实现，对比清空/删除日汇总前后的查询结果 |

SQL 唯一模板 {{database}} 必须由严格校验后的带引号库名替换。正式 writer 已适配。已有 key/payload 库须使用 upgrade 复制到新库，不能只覆盖 DDL。旧实例可持续运行：首轮全量、重复命令增量追平，最终 `--finalize` 后在报告的 5 分钟期限内启用新实例并切换、排空旧流量；新实例首次业务写入后禁止旧库导入。

## 本次修订

已完成 SQLite 全量差异处置，详见 [逐项决定与剩余实施要求](../../adr/0027-typed-tracking-schema.md#与-sqlite-的全部差异及处理决定)。恢复全局 users.id、全局 identity_sessions.ref、活动事实 (tenant,id)；取消月份分区和 event_lookup；digest 使用普通字符串，INTEGER 使用 Int64，非键列恢复可空并撤销新 CHECK。保留日期时间类型、分类字典编码、业务键非空、FINAL 当前视图及必要的写入恢复机制。普通查询不再额外过滤保留期，恢复维护任务删除后生效。

删除 source_epoch、commit_seq、is_deleted、row_hash、physical_delete_at，以及 tracking_runtime、published_watermarks、tracking_commits、schema_migrations、migration_runs、migration_chunks。不再提供固定水位的 *_at 视图。

user_day 在历史 SQLite 中仍持续维护，但九类统计查询均不读取它；当前不作为必需表导入。它可用于无版本/平台筛选的 DAU/MAU 加速，是否启用需独立设计与压测，详见 [SQLite 专项分析](sqlite-user-day-analysis.md)。runtime_facts 恢复 17 列，日期和环境通过关联 activity_facts 获取。tracking_events 恢复 tenant/id/body/received_at；operations 恢复 tenant/installation/operation/accepted/terminal/terminal_digest。

body.durationMs 只在组装 API 返回值时读取，没有 JSON 子字段 SQL 筛选。operations 的 JSON occurredAt 确实用于保留期，eventId/occurredAt 还用于旧补数筛选；保留这些少量按需解析，不将整段事件结构拆列。详细代码依据与 user_day 字段说明见 ADR。

## 查询方式

正常查询使用 *_current 视图或显式 FINAL，直接 count 物理表可能计入尚未合并的重复行。视图不自动限制租户，也不提供跨表事务；后端必须绑定租户和请求的时间范围，并让一次请求的所有查询共用读写互斥门。任何更新、删除、旧请求重试都不得穿插在这次读取中。保留期由维护清理执行，普通读取不提前隐藏尚未删除的数据。

例如，查询生产环境每日活跃用户，day 是北京时间日期：

```sql
SELECT day, uniqExactIf(user_id, active = 1 AND isNotNull(user_id)) AS dau
FROM typed_analytics.activity_facts_current
WHERE tenant = {tenant:String}
  AND day BETWEEN {from:Date} AND {through:Date}
  AND environment = 'production'
  AND pending = 0
GROUP BY day
ORDER BY day
SETTINGS optimize_move_to_prewhere_if_final = 0;
```

运行事实的筛选仍来自活动事实，避免重复存储：

```sql
SELECT r.model,
       coalesce(sumOrNull(toInt128(r.input_tokens) + toInt128(r.output_tokens)
           + toInt128(r.cache_read_tokens) + toInt128(r.cache_write_tokens)), 0) AS tokens
FROM typed_analytics.activity_facts_current AS f
INNER JOIN typed_analytics.runtime_facts_current AS r
    ON r.tenant = f.tenant AND r.id = f.id
WHERE f.tenant = {tenant:String}
  AND f.day BETWEEN {from:Date} AND {through:Date}
  AND f.environment = 'production'
  AND f.pending = 0
  AND r.usage_reported = 1
GROUP BY r.model
SETTINGS optimize_move_to_prewhere_if_final = 0;
```

reasoning_tokens 属于 output_tokens 子集，不重复加入总量。四桶分别转 Int128 后相加，避免中间 Int64 加法溢出；NULL 仍按原 SQL 表达式传播，只在原有 COALESCE 位置补零。API 适配保留 ISO UTC 毫秒时间、YYYY-MM-DD 日期及既有数值格式；Int64 不得先经有损 Number 转换。外连接使用 join_use_nulls=1；空集和全 NULL 聚合按原查询选择 sumOrNull / sum，不能直接假定两种引擎的默认值一致。用户关联使用同租户键。reader 每次查询禁用 FINAL 前的自动 PREWHERE 下推，也不能手动把 user_id/pending 等可变字段移到去重前。视图不替代鉴权；不向未授权客户端开放数据库入口。

## 写入与清理前提

无版本参数的 ReplacingMergeTree 保留最后插入的完整行，旧请求晚到可能覆盖新值。因此单 writer 串行执行决策、写入及重试，失败先恢复本地待完成批次，确认旧请求结束后才开放新操作。整个管理请求和维护也进入同一互斥门。这些配套能力已在后端实现并有故障恢复测试。多进程直写和绕过应用的 SQL 查询不受应用互斥保护。

不使用自动 TTL。维护按原 90/120/400 天规则从当前状态选键，再删除所有物理副本并等待完成，runtime 跟随活动事实清理；清理前的数据保持可见。不得用只删除某个旧值的条件留下可复活的其他副本。数据库无历史回退能力，批次文件与数据库必须配套备份。完整边界见 ADR。

## 隔离验证

使用 Node.js 24、pnpm 11.19.0 和固定 ClickHouse 26.3.52.9 镜像：

```sh
node docs/design/tracking-v2/verify.mjs
node docs/design/tracking-v2/verify-sqlite-user-day.mjs
pnpm check
pnpm build
```

verify.mjs 不读取 website.json、生产密码或真实事件，不挂载目录、不发布端口，结束删除容器及匿名卷。验证覆盖十张表与 SQLite 的字段集合完全一致、无控制表和公共技术字段、全部当前视图、重复写入、租户隔离、pending 解挂、NULL 更新、FINAL 合并前后结果、日期/环境关联、原 JSON 字符串、小数 duration、大整数 Token、全副本物理删除以及旧源水位/excluded/tombstone 提取。

以上设计验证脚本不覆盖运行后端。运行集成测试另行覆盖持续写入期间的全量及多轮追平、升级中断续跑、旧源 excluded/tombstone、日志断档/损坏、5 分钟切换保护、整次请求互斥、部分插入/删除恢复、所有清理边界和 SQLite 九类 API 对照。生产数据质量、容量和线上网关切换不在隔离验收范围内。

2026-10-19 本次差异收敛后验证：固定 ClickHouse 26.3.52.9 上 78 项设计断言通过，覆盖全部字段顺序/类型/可空性、原业务键、全局键范围、跨月/环境属性修正、NULL 更新、有符号整数边界、原串 digest 和维护前后可见性。pnpm check 使用另一个 loopback 隔离实例，158 个现有测试通过、0 跳过；pnpm build 通过。环境为 Node.js 24.14.0、pnpm 11.19.0。测试容器和匿名卷已清理，未连接生产库或执行实际迁移。

同日补充 SQLite 专项验证：历史实现通过 132 项断言；九类查询 × 六组筛选在清空和删除 user_day 后均保持结果一致。另验证原写入及清理不能在仅删表、未改代码的情况下继续运行。该验证不使用 ClickHouse。

2026-10-20 实现验收：`test/tracking-sqlite-parity.test.ts` 直接运行历史 SQLite 实现，九类 API × 六组筛选 × 三个清理阶段共 162 次响应对比通过。启动及每小时清理、账号授权、删除失败恢复、升级断点及未完成升级启动拦截均有独立测试。最新完整检查结果见升级运行手册。
