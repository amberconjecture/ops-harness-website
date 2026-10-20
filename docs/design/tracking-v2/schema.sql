-- Review snapshot. Runtime source: db/clickhouse/migrations/0003_tracking_typed.sql.
-- Use a NEW isolated database and a validated, quoted {{database}} identifier.
-- Column names match SQLite v3 for the ten retained business tables.
-- No version columns, tombstones, control tables, or automatic TTL.
-- Requires a single serialized writer. Supply every column explicitly.
-- Keys retain SQLite scope; only key columns are NOT NULL.
-- Non-key columns retain SQLite nullability; INTEGER maps to signed Int64.

CREATE TABLE IF NOT EXISTS {{database}}.users (
    id String COMMENT '内部用户 ID，保留历史值',
    tenant Nullable(String) COMMENT '租户 ID',
    issuer LowCardinality(Nullable(String)) COMMENT '身份签发方或员工来源',
    subject Nullable(String) COMMENT '签发方内的身份 ID 或工号，保留前导零',
    display_name Nullable(String) COMMENT '展示名称',
    chinese_name Nullable(String) COMMENT '员工中文姓名，未知为 NULL',
    department_name Nullable(String) COMMENT '部门名称',
    dept_l1_name Nullable(String) COMMENT '一级部门名称',
    dept_name Nullable(String) COMMENT '来源提供的部门名称，不与 department_name 强行合并',
    profile_updated_at Nullable(DateTime64(3, 'UTC')) COMMENT '来源资料更新时间，防止旧资料覆盖新资料'
) ENGINE = ReplacingMergeTree()
ORDER BY id
SETTINGS fsync_after_insert = 1, fsync_part_directory = 1;

CREATE TABLE IF NOT EXISTS {{database}}.user_identities (
    tenant String COMMENT '租户 ID',
    issuer LowCardinality(String) COMMENT '身份签发方',
    subject String COMMENT '签发方内的身份 ID',
    user_id Nullable(String) COMMENT '关联同租户 users.id'
) ENGINE = ReplacingMergeTree()
ORDER BY (tenant, issuer, subject)
SETTINGS fsync_after_insert = 1, fsync_part_directory = 1;

CREATE TABLE IF NOT EXISTS {{database}}.installations (
    tenant String COMMENT '租户 ID',
    installation String COMMENT '客户端安装 ID',
    environment LowCardinality(Nullable(String)) COMMENT '安装登记环境，历史事件环境以事实表为准',
    last_seen Nullable(DateTime64(3, 'UTC')) COMMENT '服务器最后收到该安装上报的时间'
) ENGINE = ReplacingMergeTree()
ORDER BY (tenant, installation)
SETTINGS fsync_after_insert = 1, fsync_part_directory = 1;

CREATE TABLE IF NOT EXISTS {{database}}.identity_sessions (
    ref String COMMENT '签发给客户端的身份引用 ID',
    tenant Nullable(String) COMMENT '租户 ID',
    installation Nullable(String) COMMENT '绑定的安装 ID',
    user_id Nullable(String) COMMENT '关联同租户 users.id',
    valid_from Nullable(DateTime64(3, 'UTC')) COMMENT '身份有效期起点，包含',
    expires_at Nullable(DateTime64(3, 'UTC')) COMMENT '身份有效期终点，不包含；存储保留期另计'
) ENGINE = ReplacingMergeTree()
ORDER BY ref
SETTINGS fsync_after_insert = 1, fsync_part_directory = 1;

CREATE TABLE IF NOT EXISTS {{database}}.event_dedup (
    tenant String COMMENT '租户 ID',
    id String COMMENT '事件 ID',
    digest Nullable(String) COMMENT '规范事件 SHA-256，用于重复或冲突判定',
    received_at Nullable(DateTime64(3, 'UTC')) COMMENT '服务器接收时间'
) ENGINE = ReplacingMergeTree()
ORDER BY (tenant, id)
SETTINGS fsync_after_insert = 1, fsync_part_directory = 1;

CREATE TABLE IF NOT EXISTS {{database}}.operations (
    tenant String COMMENT '租户 ID',
    installation String COMMENT '操作所在安装 ID',
    operation String COMMENT '受理与终态共用的操作 ID',
    accepted Nullable(String) COMMENT '完整 operation.accepted 事件 JSON，尚未收到为 NULL',
    terminal Nullable(String) COMMENT '完整 operation.finished 事件 JSON，尚未收到为 NULL',
    terminal_digest Nullable(String) COMMENT '终态业务上下文摘要，沿用原算法'
) ENGINE = ReplacingMergeTree()
ORDER BY (tenant, installation, operation)
SETTINGS fsync_after_insert = 1, fsync_part_directory = 1;

CREATE TABLE IF NOT EXISTS {{database}}.activity_facts (
    tenant String COMMENT '租户 ID',
    id String COMMENT '事件 ID，同租户内唯一；日期和环境不参与业务键',
    user_id Nullable(String) COMMENT '关联用户，匿名或终态待匹配时为 NULL',
    installation Nullable(String) COMMENT '上报安装 ID',
    day Nullable(Date) COMMENT '事件发生时间对应的 Asia/Shanghai 业务日期',
    occurred_at Nullable(DateTime64(3, 'UTC')) COMMENT '事件发生时间',
    environment LowCardinality(Nullable(String)) COMMENT '事件环境',
    platform LowCardinality(Nullable(String)) COMMENT '客户端平台',
    app_version LowCardinality(Nullable(String)) COMMENT '客户端版本',
    feature LowCardinality(Nullable(String)) COMMENT '功能分类',
    action LowCardinality(Nullable(String)) COMMENT '具体操作，无值为空串',
    event_name LowCardinality(Nullable(String)) COMMENT '事件类型',
    initiator LowCardinality(Nullable(String)) COMMENT '发起方，例如 user',
    interaction Nullable(String) COMMENT '交互 ID，无显式 ID 时使用事件 ID',
    operation Nullable(String) COMMENT '操作 ID，无显式 ID 时使用事件 ID',
    outcome LowCardinality(Nullable(String)) COMMENT '操作结果，无值为空串',
    active Nullable(Int64) COMMENT '是否满足现有活跃判定，0 或 1',
    success Nullable(Int64) COMMENT '是否满足现有成功判定，0 或 1',
    pending Nullable(Int64) COMMENT '终态是否等待受理事件匹配，1 时不计入正式统计'
) ENGINE = ReplacingMergeTree()
ORDER BY (tenant, id)
SETTINGS fsync_after_insert = 1, fsync_part_directory = 1;

CREATE TABLE IF NOT EXISTS {{database}}.runtime_facts (
    tenant String COMMENT '租户 ID',
    id String COMMENT '关联同租户 activity_facts.id',
    conversation Nullable(String) COMMENT '对话 ID，无值为空串',
    turn Nullable(Int64) COMMENT '对话轮次，无值为 0',
    step Nullable(Int64) COMMENT '轮次内步骤，无值为 0',
    session_kind LowCardinality(Nullable(String)) COMMENT '会话类型，沿用源值和协议默认值',
    provider LowCardinality(Nullable(String)) COMMENT '模型服务提供方',
    model LowCardinality(Nullable(String)) COMMENT '模型名称',
    usage_reported Nullable(Int64) COMMENT '是否报告用量，区分未上报与上报为零',
    input_tokens Nullable(Int64) COMMENT '普通输入 Token 数',
    output_tokens Nullable(Int64) COMMENT '输出 Token 数',
    cache_read_tokens Nullable(Int64) COMMENT '读取缓存的 Token 数',
    cache_write_tokens Nullable(Int64) COMMENT '写入缓存的 Token 数',
    reasoning_tokens Nullable(Int64) COMMENT '推理 Token 数，属于输出子集，不重复加入总量',
    skill_name Nullable(String) COMMENT '被加载的 Skill 名称',
    method LowCardinality(Nullable(String)) COMMENT 'Skill 加载方式',
    result LowCardinality(Nullable(String)) COMMENT 'Skill 加载结果'
) ENGINE = ReplacingMergeTree()
ORDER BY (tenant, id)
SETTINGS fsync_after_insert = 1, fsync_part_directory = 1;

CREATE TABLE IF NOT EXISTS {{database}}.tracking_events (
    tenant String COMMENT '租户 ID',
    id String COMMENT '事件 ID',
    body Nullable(String) COMMENT '完整原始事件 JSON，保留字符串，durationMs 在响应组装时读取',
    received_at Nullable(DateTime64(3, 'UTC')) COMMENT '服务器接收时间'
) ENGINE = ReplacingMergeTree()
ORDER BY (tenant, id)
SETTINGS fsync_after_insert = 1, fsync_part_directory = 1;

CREATE TABLE IF NOT EXISTS {{database}}.ingestion_health (
    code String COMMENT '拒收原因代码，全局累计维度',
    count Nullable(Int64) COMMENT '累计拒收次数，写入完整新值，重试不重复累加'
) ENGINE = ReplacingMergeTree()
ORDER BY code
SETTINGS fsync_after_insert = 1, fsync_part_directory = 1;
