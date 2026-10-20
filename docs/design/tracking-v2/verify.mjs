// Design SQL validation only. No production connection or migration implementation.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout } from 'node:timers/promises'

const container = `website-schema-design-${randomUUID()}`
const database = 'website_test_typed_design'
const names = ['users', 'user_identities', 'installations', 'identity_sessions', 'event_dedup', 'operations', 'activity_facts', 'runtime_facts', 'tracking_events', 'ingestion_health']
const dictionaryColumns = new Set(['users.issuer', 'user_identities.issuer', 'installations.environment', 'activity_facts.environment', 'activity_facts.platform', 'activity_facts.app_version', 'activity_facts.feature', 'activity_facts.action', 'activity_facts.event_name', 'activity_facts.initiator', 'activity_facts.outcome', 'runtime_facts.session_kind', 'runtime_facts.provider', 'runtime_facts.model', 'runtime_facts.method', 'runtime_facts.result'])
const timestamps = new Set(['profile_updated_at', 'last_seen', 'valid_from', 'expires_at', 'received_at', 'occurred_at'])
let assertions = 0
const equal = (actual, expected) => { assert.deepEqual(actual, expected); assertions++ }
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 })
function sql(query) {
  return execFileSync('docker', ['exec', '-i', container, 'clickhouse-client', '--multiquery'], {
    input: `SET optimize_move_to_prewhere_if_final=0;\n${query}`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000,
  }).trim()
}
const rows = query => {
  const output = sql(`${query} FORMAT JSONEachRow`)
  return output ? output.split('\n').map(line => JSON.parse(line)) : []
}
const insert = (table, records) => sql(`INSERT INTO ${database}.${table} FORMAT JSONEachRow\n${records.map(row => JSON.stringify(row)).join('\n')}\n`)
const current = name => `${database}.${name}_current`
const facts = current('activity_facts')

try {
  docker(['run', '--detach', '--rm', '--name', container, '--hostname', 'localhost', '--network', 'none', '--ulimit', 'nofile=262144:262144', 'clickhouse/clickhouse-server:26.3.52.9'])
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try { sql('SELECT 1'); ready = true; break } catch { await setTimeout(200) }
  }
  assert.ok(ready, 'isolated ClickHouse did not start')
  console.log(`ClickHouse ${sql('SELECT version()')}`)
  const ddl = ['schema.sql', 'views.sql'].map(file => readFileSync(new URL(file, import.meta.url), 'utf8').replaceAll('{{database}}', `\`${database}\``)).join('\n')
  sql(`CREATE DATABASE ${database};\n${ddl}`)
  sql(ddl)
  equal(rows(`SELECT name FROM system.tables WHERE database='${database}' AND engine!='View' ORDER BY name`).map(row => row.name), [...names].sort())
  equal(sql(`SELECT count() FROM system.columns WHERE database='${database}' AND table NOT LIKE '%_current'`), '76')
  equal(sql(`SELECT count() FROM system.columns WHERE database='${database}' AND name IN ('source_epoch','commit_seq','is_deleted','row_hash','physical_delete_at')`), '0')

  const sqlite = new DatabaseSync(':memory:')
  try {
    sqlite.exec(readFileSync(new URL('sqlite-v3-reference.sql', import.meta.url), 'utf8'))
    equal(sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n, 12)
    for (const name of names) {
      const original = sqlite.prepare(`PRAGMA table_info(${name})`).all()
      const expected = original.map(column => {
        const type = column.type === 'INTEGER' ? 'Int64' : timestamps.has(column.name) ? "DateTime64(3, 'UTC')" : column.name === 'day' ? 'Date' : 'String'
        const nullable = column.pk ? type : `Nullable(${type})`
        return { name: column.name, type: dictionaryColumns.has(`${name}.${column.name}`) ? `LowCardinality(${nullable})` : nullable }
      })
      equal(rows(`SELECT name,type FROM system.columns WHERE database='${database}' AND table='${name}' ORDER BY position`), expected)
      const keys = original.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name)
      equal(rows(`SELECT sorting_key,partition_key FROM system.tables WHERE database='${database}' AND name='${name}'`), [{ sorting_key: keys.join(', '), partition_key: '' }])
      equal(sql(`SELECT count() FROM ${current(name)}`), '0')
    }
  } finally { sqlite.close() }
  equal(sql(`SELECT count() FROM system.columns WHERE database='${database}' AND table NOT LIKE '%_current' AND type LIKE '%Nullable(%'`), '57')
  equal(sql(`SELECT count() FROM system.columns WHERE database='${database}' AND default_kind!=''`), '0')
  equal(sql(`SELECT count() FROM system.data_skipping_indices WHERE database='${database}'`), '0')
  equal(sql(`SELECT count() FROM system.tables WHERE database='${database}' AND (position(create_table_query,'CONSTRAINT ')>0 OR position(create_table_query,' TTL ')>0)`), '0')

  sql(`SYSTEM STOP MERGES ${database}.activity_facts`)
  const fact = {
    tenant: 'fixture', id: 'late-terminal', user_id: null, installation: 'installation-a',
    day: '2026-10-18', occurred_at: '2026-10-18 12:00:00.000', environment: 'production', platform: 'linux',
    app_version: '1.0.0', feature: 'conversation', action: '', event_name: 'operation.finished', initiator: 'user',
    interaction: 'interaction-a', operation: 'operation-a', outcome: 'succeeded', active: 0, success: 1, pending: 1,
  }
  insert('activity_facts', [fact, fact, { ...fact, tenant: 'other', user_id: 'other-tenant' }])
  equal(sql(`SELECT count() FROM ${facts} WHERE tenant='fixture'`), '1')
  insert('activity_facts', [{ ...fact, user_id: 'employee-a', pending: 0 }])
  equal(rows(`SELECT user_id,toString(pending) AS pending_text FROM ${facts} WHERE tenant='fixture' AND pending=0`), [{ user_id: 'employee-a', pending_text: '0' }])
  insert('activity_facts', [{ ...fact, user_id: null, pending: 0 }])
  const checkCurrent = () => {
    equal(rows(`SELECT user_id,toString(pending) AS pending_text FROM ${facts} WHERE tenant='fixture'`), [{ user_id: null, pending_text: '0' }])
    equal(rows(`SELECT id FROM ${facts} WHERE tenant='fixture' AND user_id='employee-a'`), [])
    equal(rows(`SELECT id FROM ${facts} WHERE tenant='fixture' AND pending=1`), [])
    equal(rows(`SELECT user_id FROM ${facts} WHERE tenant='other'`), [{ user_id: 'other-tenant' }])
  }
  checkCurrent()

  // Date/environment are attributes, never part of a second identity or partition.
  // Direct SQL tests storage replacement only; normal ingestion still rejects changed digests.
  sql(`SYSTEM STOP MERGES ${database}.activity_facts`)
  insert('activity_facts', [{ ...fact, tenant: 'key-review', id: 'corrected', day: '2026-09-30', environment: 'development' }])
  insert('activity_facts', [{ ...fact, tenant: 'key-review', id: 'corrected', day: '2026-10-01', environment: 'production', active: null, pending: null }])
  const checkCorrected = () => {
    equal(rows(`SELECT toString(day) AS day,environment,active,pending FROM ${facts} WHERE tenant='key-review'`), [{ day: '2026-10-01', environment: 'production', active: null, pending: null }])
    equal(sql(`SELECT count() FROM ${facts} WHERE tenant='key-review' AND day='2026-09-30'`), '0')
    equal(sql(`SELECT count() FROM ${facts} WHERE tenant='key-review' AND environment='development'`), '0')
  }
  checkCorrected()
  sql(`SYSTEM START MERGES ${database}.activity_facts; OPTIMIZE TABLE ${database}.activity_facts FINAL`)
  checkCorrected()
  checkCurrent()

  const cutoff = new Date(Date.parse('2026-10-19T00:00:00Z') - 400 * 86_400_000).toISOString().slice(0, 10)
  const prior = new Date(Date.parse(`${cutoff}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
  insert('activity_facts', [
    { ...fact, id: 'at-boundary', day: cutoff, occurred_at: `${cutoff} 00:00:00.000`, pending: 0 },
    { ...fact, id: 'expired', day: prior, occurred_at: `${prior} 00:00:00.000`, pending: 0 },
  ])
  equal(rows(`SELECT id FROM ${facts} WHERE tenant='fixture' AND day >= toDate(toDateTime64('2026-10-19 00:00:00',3,'UTC') - INTERVAL 400 DAY,'Asia/Shanghai') ORDER BY id`), [{ id: 'at-boundary' }, { id: 'late-terminal' }])
  // Like SQLite, expiry alone does not hide rows before maintenance has run.
  equal(sql(`SELECT count() FROM ${facts} WHERE tenant='fixture' AND id='expired'`), '1')
  const expiredKeys = rows(`SELECT tenant,id FROM ${facts} WHERE tenant='fixture' AND day < toDate('${cutoff}')`)
  equal(expiredKeys, [{ tenant: 'fixture', id: 'expired' }])
  sql(`ALTER TABLE ${database}.activity_facts DELETE WHERE tenant='fixture' AND id='expired' SETTINGS mutations_sync=1`)
  equal(sql(`SELECT count() FROM ${facts} WHERE tenant='fixture' AND id='expired'`), '0')
  equal(sql(`SELECT count() FROM ${facts} WHERE tenant='fixture' AND id='at-boundary'`), '1')
  insert('users', [{ tenant: 'fixture', id: 'employee-a', issuer: 'welink', subject: '000007', display_name: 'fixture', chinese_name: 'fixture-name', department_name: null, dept_l1_name: null, dept_name: null, profile_updated_at: null }])
  equal(rows(`SELECT subject,department_name FROM ${current('users')} WHERE tenant='fixture'`), [{ subject: '000007', department_name: null }])

  const runtime = { tenant: 'fixture', id: 'late-terminal', conversation: '', turn: '0', step: '0', session_kind: 'root', provider: '', model: 'fixture-model', usage_reported: 1, input_tokens: '9007199254740991', output_tokens: '7', cache_read_tokens: '2', cache_write_tokens: '3', reasoning_tokens: '4', skill_name: '', method: '', result: '' }
  insert('runtime_facts', [runtime, runtime, { ...runtime, id: 'orphan-fixture' }])
  const joined = `${facts} AS f INNER JOIN ${current('runtime_facts')} AS r ON r.tenant=f.tenant AND r.id=f.id`
  const runtimeFilter = "f.tenant='fixture' AND f.day='2026-10-18' AND f.pending=0"
  equal(sql(`SELECT count() FROM ${joined} WHERE ${runtimeFilter} AND f.environment='production'`), '1')
  equal(sql(`SELECT count() FROM ${joined} WHERE ${runtimeFilter} AND f.environment='development'`), '0')
  equal(sql(`SELECT toString(sum(toInt128(r.input_tokens)+toInt128(r.output_tokens)+toInt128(r.cache_read_tokens)+toInt128(r.cache_write_tokens))) FROM ${joined} WHERE ${runtimeFilter}`), '9007199254741003')

  // Digest remains variable-length text. Hash validity belongs to the source/business validator.
  insert('event_dedup', [{ tenant: 'fixture', id: 'short', digest: 'legacy-short', received_at: null }, { tenant: 'fixture', id: 'long', digest: 'a'.repeat(65), received_at: null }])
  equal(rows(`SELECT id,digest,received_at FROM ${current('event_dedup')} ORDER BY id`), [{ id: 'long', digest: 'a'.repeat(65), received_at: null }, { id: 'short', digest: 'legacy-short', received_at: null }])
  // These are storage domain tests, not permission to ingest negative business counters.
  insert('ingestion_health', [{ code: 'int64-min', count: '-9223372036854775808' }, { code: 'int64-max', count: '9223372036854775807' }, { code: 'nullable', count: null }])
  equal(rows(`SELECT code,toString(count) AS count FROM ${current('ingestion_health')} ORDER BY code`), [{ code: 'int64-max', count: '9223372036854775807' }, { code: 'int64-min', count: '-9223372036854775808' }, { code: 'nullable', count: null }])

  // The original global key must deduplicate globally. A production writer must REJECT
  // this cross-tenant conflict before inserting; FINAL itself is not a uniqueness check.
  const globalUser = { id: 'global-user', tenant: 'global-a', issuer: null, subject: null, display_name: null, chinese_name: null, department_name: null, dept_l1_name: null, dept_name: null, profile_updated_at: null }
  insert('users', [globalUser])
  insert('users', [{ ...globalUser, tenant: 'global-b' }])
  equal(rows(`SELECT tenant FROM ${current('users')} WHERE id='global-user'`), [{ tenant: 'global-b' }])
  equal(sql(`SELECT count() FROM ${current('users')} WHERE id='global-user' AND tenant='global-a'`), '0')
  const session = { ref: 'global-ref', tenant: 'global-a', installation: null, user_id: null, valid_from: null, expires_at: null }
  insert('identity_sessions', [session])
  insert('identity_sessions', [{ ...session, tenant: 'global-b' }])
  equal(rows(`SELECT tenant FROM ${current('identity_sessions')} WHERE ref='global-ref'`), [{ tenant: 'global-b' }])
  equal(sql(`SELECT count() FROM ${current('identity_sessions')} WHERE ref='global-ref' AND tenant='global-a'`), '0')

  const body = '{ "durationMs": 0.125, "fixture": "原始正文" }'
  insert('tracking_events', [{ tenant: 'fixture', id: 'late-terminal', body, received_at: '2026-10-19 00:00:00.000' }])
  const raw = rows(`SELECT body FROM ${current('tracking_events')} WHERE tenant='fixture'`)[0]
  equal(raw.body, body)
  equal(JSON.parse(raw.body).durationMs, 0.125)

  const accepted = '{ "eventId":"accepted-id", "occurredAt":"2026-06-20T00:00:00.000Z" }'
  const terminal = '{ "eventId":"terminal-id", "occurredAt":"2026-07-01T00:00:00.000Z" }'
  const op = { tenant: 'fixture', installation: 'installation-a', operation: 'a', accepted, terminal: null, terminal_digest: null }
  insert('operations', [op, { ...op, operation: 'b' }])
  insert('operations', [{ ...op, terminal, terminal_digest: 'a'.repeat(64) }])
  equal(rows(`SELECT accepted,terminal,terminal_digest FROM ${current('operations')} WHERE operation='a'`), [{ accepted, terminal, terminal_digest: 'a'.repeat(64) }])
  // Current real maintenance filter: terminal time takes precedence, accepted is fallback.
  equal(rows(`SELECT operation FROM ${current('operations')} WHERE coalesce(nullIf(JSONExtractString(ifNull(terminal,'{}'),'occurredAt'),''),JSONExtractString(ifNull(accepted,'{}'),'occurredAt')) >= '2026-06-21T00:00:00.000Z' ORDER BY operation`), [{ operation: 'a' }])

  // Delete ALL physical versions by immutable business key, then verify no resurrection.
  sql(`ALTER TABLE ${database}.runtime_facts DELETE WHERE tenant='fixture' AND id='late-terminal' SETTINGS mutations_sync=1`)
  sql(`ALTER TABLE ${database}.activity_facts DELETE WHERE tenant='fixture' AND id='late-terminal' SETTINGS mutations_sync=1`)
  equal(sql(`SELECT count() FROM ${database}.activity_facts WHERE tenant='fixture' AND id='late-terminal'`), '0')
  equal(sql(`SELECT count() FROM ${database}.runtime_facts WHERE tenant='fixture' AND id='late-terminal'`), '0')
  sql(`OPTIMIZE TABLE ${database}.activity_facts FINAL`)
  equal(sql(`SELECT count() FROM ${facts} WHERE tenant='fixture' AND id='late-terminal'`), '0')
  equal(sql(`SELECT count() FROM ${facts} WHERE tenant='other' AND id='late-terminal'`), '1')

  // The old source still requires watermark/excluded/tombstone interpretation.
  // These fixture columns are NOT part of the proposed target schema.
  sql(`CREATE TABLE ${database}.source_versions (key String,seq UInt64,deleted UInt8,payload String) ENGINE=MergeTree ORDER BY (key,seq);\nINSERT INTO ${database}.source_versions VALUES ('a',1,0,'old'),('a',2,1,'null'),('a',5,0,'unpublished'),('b',1,0,'base'),('b',3,0,'excluded');`)
  equal(rows(`SELECT key,argMax(tuple(payload,deleted),seq) AS latest FROM ${database}.source_versions WHERE seq<=4 AND NOT(seq>2 AND seq<=3) GROUP BY key ORDER BY key`), [{ key: 'a', latest: ['null', 1] }, { key: 'b', latest: ['base', 0] }])
  console.log(`${assertions} design assertions passed. No production connection or application migration performed.`)
} finally {
  try { docker(['rm', '--force', '--volumes', container]) } catch { /* Already removed or creation failed. */ }
}
