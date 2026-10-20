# 数据库结构与迁移

数据库资产按引擎隔离管理；当前运行后端为 ClickHouse，MySQL 目录仍仅预留。

```text
db/clickhouse/
  schema.sql                         # 当前 10 张类型化业务表和 10 个当前视图
  migrations/
    0001_tracking_baseline.sql        # 旧 key/payload 布局，保留历史文件
    0002_tracking_retention.sql       # 旧布局 TTL，保留历史文件
    0003_tracking_typed.sql           # 新布局；新库初始化只执行本文件
```

- `schema.sql` 是当前结构快照，与 `CURRENT_MIGRATIONS` 的执行结果一致。每次结构变化更新快照、执行入口、测试和升级步骤。
- 编号 migration 不修改、不重排、不删除已发布文件；0001/0002 是从原初始化代码提取的基线，0003 采用独立新库切换，不在旧库上清空重建。
- `pnpm tracking init` 只创建和验证新结构；遇到旧版本表会拒绝。已有 key/payload 数据使用 `pnpm tracking upgrade --source-database OLD_DB`，无需先运行 init。
- upgrade 保持旧实例在线，配置指向独立目标库/目录；首轮全量，后续同命令只追平新增提交（含更新、删除）。最终 `--finalize` 校验 5 分钟窗口，启动新实例并在报告期限前切换、排空旧流量。目标第一次业务写入后不再允许旧库导入；断点保存在本地文件，不添加数据库控制表。
- 构建将整个 db 复制到 dist/db，编译后的 CLI 和运行代码从该位置加载，不依赖当前工作目录。
- SQL 中唯一模板 `{{database}}` 必须经过严格标识符校验并加引号。加载器按分号拆分，SQL 注释/字符串中不得加入 ASCII 分号；若需要复杂过程体，先升级加载器。
- 目标没有 schema_version / schema_migrations 表。启动核验全部字段顺序、类型、可空性、默认值、引擎、排序键、分区、TTL、视图和持久化设置，结构不符即拒绝启动。
- 10 张表不配置自动 TTL。官网启动及每小时按 90/120/400 天规则维护，writer 需要目标库 SELECT、INSERT、ALTER DELETE，以及 system.processes / system.mutations 的 SELECT。init / upgrade 检查权限，SQL 账号由 admin 补充授权，XML 账号须同步更新部署配置。

[完整升级步骤、损失边界和恢复方式](../docs/runbooks/tracking-typed-migration.md)，[SQLite 差异决定](../docs/adr/0027-typed-tracking-schema.md)。DDL 和升级都没有跨表数据库事务；单 writer、完整请求互斥及本地 pending 恢复是运行前提。运行文件、密码和业务数据不得加入 Git。
