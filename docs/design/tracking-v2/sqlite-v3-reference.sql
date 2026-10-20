-- Reference only: SQLite schema v3 from da75d733891a38ed936aa182f37e91aa734cb291.
-- Reconstructed in memory from the historical constructor and its v2/v3 upgrades.
-- Not a runtime migration and not intended for production execution.

CREATE TABLE activity_facts(tenant TEXT,id TEXT,user_id TEXT,installation TEXT,day TEXT,occurred_at TEXT,environment TEXT,platform TEXT,app_version TEXT,feature TEXT,action TEXT,event_name TEXT,initiator TEXT,interaction TEXT,operation TEXT,outcome TEXT,active INTEGER,success INTEGER,pending INTEGER,PRIMARY KEY(tenant,id));

CREATE TABLE event_dedup(tenant TEXT,id TEXT,digest TEXT,received_at TEXT,PRIMARY KEY(tenant,id));

CREATE TABLE identity_sessions(ref TEXT PRIMARY KEY,tenant TEXT,installation TEXT,user_id TEXT,valid_from TEXT,expires_at TEXT);

CREATE TABLE ingestion_health(code TEXT PRIMARY KEY,count INTEGER);

CREATE TABLE installations(tenant TEXT, installation TEXT, environment TEXT, last_seen TEXT, PRIMARY KEY(tenant,installation));

CREATE TABLE operations(tenant TEXT,installation TEXT,operation TEXT,accepted TEXT,terminal TEXT,terminal_digest TEXT,PRIMARY KEY(tenant,installation,operation));

CREATE TABLE runtime_facts(
          tenant TEXT,id TEXT,conversation TEXT,turn INTEGER,step INTEGER,session_kind TEXT,
          provider TEXT,model TEXT,usage_reported INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER,
          skill_name TEXT,method TEXT,result TEXT,PRIMARY KEY(tenant,id),FOREIGN KEY(tenant,id) REFERENCES activity_facts(tenant,id) ON DELETE CASCADE);

CREATE TABLE schema_version(version INTEGER PRIMARY KEY);

CREATE TABLE tracking_events(tenant TEXT,id TEXT,body TEXT,received_at TEXT,PRIMARY KEY(tenant,id));

CREATE TABLE user_day(tenant TEXT,day TEXT,user_id TEXT,environment TEXT,active INTEGER,logins INTEGER,interactions INTEGER,successes INTEGER,PRIMARY KEY(tenant,day,user_id,environment));

CREATE TABLE user_identities(tenant TEXT,issuer TEXT,subject TEXT,user_id TEXT,PRIMARY KEY(tenant,issuer,subject));

CREATE TABLE users(id TEXT PRIMARY KEY, tenant TEXT, issuer TEXT, subject TEXT, display_name TEXT, chinese_name TEXT, department_name TEXT, dept_l1_name TEXT, dept_name TEXT, profile_updated_at TEXT, UNIQUE(tenant,issuer,subject));

CREATE INDEX facts_operation ON activity_facts(tenant,installation,operation);

CREATE INDEX facts_window ON activity_facts(environment,day,user_id);

CREATE INDEX runtime_skill ON runtime_facts(skill_name);
