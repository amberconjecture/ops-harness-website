CREATE TABLE IF NOT EXISTS {{database}}.`projection_manifest` (
      epoch UUID, projection_id String, baseline_seq UInt64, manifest_hash String, ttl_grace_seconds UInt64
    ) ENGINE=MergeTree() ORDER BY (epoch,projection_id) SETTINGS fsync_after_insert=1,fsync_part_directory=1;

CREATE TABLE IF NOT EXISTS {{database}}.`delivery_receipts` (
      epoch UUID, seq UInt64, hash FixedString(64), previous_hash String
    ) ENGINE=MergeTree() ORDER BY (epoch,seq) SETTINGS fsync_after_insert=1,fsync_part_directory=1;

CREATE TABLE IF NOT EXISTS {{database}}.`delivery_intents` (
      epoch UUID, seq UInt64, hash FixedString(64), previous_hash String
    ) ENGINE=MergeTree() ORDER BY (epoch,seq) SETTINGS fsync_after_insert=1,fsync_part_directory=1;

CREATE TABLE IF NOT EXISTS {{database}}.`published_watermarks` (
      epoch UUID, seq UInt64, hash FixedString(64), baseline UInt8
    ) ENGINE=MergeTree() ORDER BY (epoch,seq) SETTINGS fsync_after_insert=1,fsync_part_directory=1;

CREATE TABLE IF NOT EXISTS {{database}}.`user_versions` (
    source_epoch UUID, key String, commit_seq UInt64, deleted UInt8,
    payload String, payload_hash FixedString(64), retention_day String,
    partition_date Date, physical_delete_at DateTime('UTC')
  ) ENGINE=ReplacingMergeTree()

  ORDER BY (source_epoch,key,commit_seq)
  SETTINGS fsync_after_insert=1, fsync_part_directory=1;

CREATE TABLE IF NOT EXISTS {{database}}.`user_identity_versions` (
    source_epoch UUID, key String, commit_seq UInt64, deleted UInt8,
    payload String, payload_hash FixedString(64), retention_day String,
    partition_date Date, physical_delete_at DateTime('UTC')
  ) ENGINE=ReplacingMergeTree()

  ORDER BY (source_epoch,key,commit_seq)
  SETTINGS fsync_after_insert=1, fsync_part_directory=1;

CREATE TABLE IF NOT EXISTS {{database}}.`installation_versions` (
    source_epoch UUID, key String, commit_seq UInt64, deleted UInt8,
    payload String, payload_hash FixedString(64), retention_day String,
    partition_date Date, physical_delete_at DateTime('UTC')
  ) ENGINE=ReplacingMergeTree()

  ORDER BY (source_epoch,key,commit_seq)
  SETTINGS fsync_after_insert=1, fsync_part_directory=1;

CREATE TABLE IF NOT EXISTS {{database}}.`identity_session_versions` (
    source_epoch UUID, key String, commit_seq UInt64, deleted UInt8,
    payload String, payload_hash FixedString(64), retention_day String,
    partition_date Date, physical_delete_at DateTime('UTC')
  ) ENGINE=ReplacingMergeTree()

  ORDER BY (source_epoch,key,commit_seq)
  SETTINGS fsync_after_insert=1, fsync_part_directory=1;

CREATE TABLE IF NOT EXISTS {{database}}.`event_dedup_versions` (
    source_epoch UUID, key String, commit_seq UInt64, deleted UInt8,
    payload String, payload_hash FixedString(64), retention_day String,
    partition_date Date, physical_delete_at DateTime('UTC')
  ) ENGINE=ReplacingMergeTree()
  PARTITION BY toYYYYMM(partition_date)
  ORDER BY (source_epoch,key,commit_seq)
  SETTINGS fsync_after_insert=1, fsync_part_directory=1;

CREATE TABLE IF NOT EXISTS {{database}}.`operation_versions` (
    source_epoch UUID, key String, commit_seq UInt64, deleted UInt8,
    payload String, payload_hash FixedString(64), retention_day String,
    partition_date Date, physical_delete_at DateTime('UTC')
  ) ENGINE=ReplacingMergeTree()

  ORDER BY (source_epoch,key,commit_seq)
  SETTINGS fsync_after_insert=1, fsync_part_directory=1;

CREATE TABLE IF NOT EXISTS {{database}}.`activity_fact_versions` (
    source_epoch UUID, key String, commit_seq UInt64, deleted UInt8,
    payload String, payload_hash FixedString(64), retention_day String,
    partition_date Date, physical_delete_at DateTime('UTC')
  ) ENGINE=ReplacingMergeTree()
  PARTITION BY toYYYYMM(partition_date)
  ORDER BY (source_epoch,key,commit_seq)
  SETTINGS fsync_after_insert=1, fsync_part_directory=1;

CREATE TABLE IF NOT EXISTS {{database}}.`runtime_fact_versions` (
    source_epoch UUID, key String, commit_seq UInt64, deleted UInt8,
    payload String, payload_hash FixedString(64), retention_day String,
    partition_date Date, physical_delete_at DateTime('UTC')
  ) ENGINE=ReplacingMergeTree()
  PARTITION BY toYYYYMM(partition_date)
  ORDER BY (source_epoch,key,commit_seq)
  SETTINGS fsync_after_insert=1, fsync_part_directory=1;

CREATE TABLE IF NOT EXISTS {{database}}.`tracking_event_versions` (
    source_epoch UUID, key String, commit_seq UInt64, deleted UInt8,
    payload String, payload_hash FixedString(64), retention_day String,
    partition_date Date, physical_delete_at DateTime('UTC')
  ) ENGINE=ReplacingMergeTree()
  PARTITION BY toYYYYMM(partition_date)
  ORDER BY (source_epoch,key,commit_seq)
  SETTINGS fsync_after_insert=1, fsync_part_directory=1;

CREATE TABLE IF NOT EXISTS {{database}}.`user_day_versions` (
    source_epoch UUID, key String, commit_seq UInt64, deleted UInt8,
    payload String, payload_hash FixedString(64), retention_day String,
    partition_date Date, physical_delete_at DateTime('UTC')
  ) ENGINE=ReplacingMergeTree()
  PARTITION BY toYYYYMM(partition_date)
  ORDER BY (source_epoch,key,commit_seq)
  SETTINGS fsync_after_insert=1, fsync_part_directory=1;

CREATE TABLE IF NOT EXISTS {{database}}.`ingestion_health_versions` (
    source_epoch UUID, key String, commit_seq UInt64, deleted UInt8,
    payload String, payload_hash FixedString(64), retention_day String,
    partition_date Date, physical_delete_at DateTime('UTC')
  ) ENGINE=ReplacingMergeTree()

  ORDER BY (source_epoch,key,commit_seq)
  SETTINGS fsync_after_insert=1, fsync_part_directory=1;

CREATE TABLE IF NOT EXISTS {{database}}.`tracking_runtime` (payload String) ENGINE=MergeTree ORDER BY tuple() SETTINGS fsync_after_insert=1,fsync_part_directory=1;

CREATE TABLE IF NOT EXISTS {{database}}.`tracking_commits` (
    source_epoch UUID,seq UInt64,created_at DateTime('UTC'),payload String,hash FixedString(64)
    ) ENGINE=ReplacingMergeTree ORDER BY (source_epoch,seq) TTL created_at + INTERVAL 7 DAY DELETE
    SETTINGS fsync_after_insert=1,fsync_part_directory=1;
