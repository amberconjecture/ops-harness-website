-- Current-state views, not snapshots or access-control boundaries.
-- Callers bind tenant/requested time range and share the application read/write gate.
-- Readers set optimize_move_to_prewhere_if_final=0 on every query.
-- Do not manually PREWHERE mutable fields before FINAL.
-- Retention is applied by maintenance, not by these views or extra read filters.

CREATE VIEW IF NOT EXISTS {{database}}.users_current AS
SELECT * FROM {{database}}.users FINAL;

CREATE VIEW IF NOT EXISTS {{database}}.user_identities_current AS
SELECT * FROM {{database}}.user_identities FINAL;

CREATE VIEW IF NOT EXISTS {{database}}.installations_current AS
SELECT * FROM {{database}}.installations FINAL;

CREATE VIEW IF NOT EXISTS {{database}}.identity_sessions_current AS
SELECT * FROM {{database}}.identity_sessions FINAL;

CREATE VIEW IF NOT EXISTS {{database}}.event_dedup_current AS
SELECT * FROM {{database}}.event_dedup FINAL;

CREATE VIEW IF NOT EXISTS {{database}}.operations_current AS
SELECT * FROM {{database}}.operations FINAL;

CREATE VIEW IF NOT EXISTS {{database}}.activity_facts_current AS
SELECT * FROM {{database}}.activity_facts FINAL;

CREATE VIEW IF NOT EXISTS {{database}}.runtime_facts_current AS
SELECT * FROM {{database}}.runtime_facts FINAL;

CREATE VIEW IF NOT EXISTS {{database}}.tracking_events_current AS
SELECT * FROM {{database}}.tracking_events FINAL;

CREATE VIEW IF NOT EXISTS {{database}}.ingestion_health_current AS
SELECT * FROM {{database}}.ingestion_health FINAL;
