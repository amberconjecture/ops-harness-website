import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { backfillSqlite } from '../scripts/tracking/backfill.js'
import { parseBackfillSince } from '../scripts/tracking/backfill-time.js'
import { TABLES, TABLE_META, applyChanges, emptyState, rowKey, type Row, type State, type TableName } from '../server/tracking/canonical.js'
import { INTEGER_COLUMNS, NULLABLE_COLUMNS } from '../server/tracking/clickhouse-schema.js'
import type { ClickHouseBackend } from '../server/tracking/clickhouse.js'
import { dayAt } from '../server/tracking/types.js'

function row(table: TableName, values: Row): Row {
  return { ...Object.fromEntries(TABLE_META[table].columns.map(column => [column, INTEGER_COLUMNS.has(column) ? 0 : NULLABLE_COLUMNS.has(column) ? null : ''])), ...values }
}
function writeSource(file: string, state: State) {
  const db = new DatabaseSync(file)
  try {
    for (const table of TABLES) {
      const { columns, primaryKey } = TABLE_META[table]
      db.exec(`CREATE TABLE "${table}" (${columns.map(column => `"${column}"`).join(',')}, PRIMARY KEY (${primaryKey.map(column => `"${column}"`).join(',')}))`)
      const insert = db.prepare(`INSERT INTO "${table}" VALUES (${columns.map(() => '?').join(',')})`)
      for (const value of state[table]) insert.run(...columns.map(column => value[column]!))
    }
  } finally { db.close() }
}
function destination(initial = emptyState()) {
  let state = initial
  const target: Pick<ClickHouseBackend, 'rows' | 'commit'> = {
    async rows(table, filter = {}) { return state[table].filter(value => !filter.keys || filter.keys.includes(rowKey(table, value))).map(value => ({ ...value })) },
    async commit(changes) { state = applyChanges(state, changes) },
  }
  return { target, state: () => state }
}

test('backfill requires an explicit, valid timezone-qualified cutoff before connecting to a database', () => {
  assert.equal(parseBackfillSince('2026-10-18T10:30:00+08:00'), '2026-10-18T02:30:00.000Z')
  assert.throws(() => parseBackfillSince(undefined), /SINCE_REQUIRED/)
  for (const value of ['', '2026-10-18', '2026-10-18T10:30:00', '2026-02-30T10:00:00Z']) {
    assert.throws(() => parseBackfillSince(value), /SINCE_MUST_BE_ISO_TIMESTAMP_WITH_TIMEZONE/)
  }
  for (const args of [[], ['--since', 'not-a-time']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/tracking/cli.ts', 'backfill', '--sqlite', 'missing.sqlite', '--config', 'missing.json', ...args], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, args.length ? /SINCE_MUST_BE_ISO_TIMESTAMP_WITH_TIMEZONE/ : /SINCE_REQUIRED/)
    assert.doesNotMatch(result.stderr, /ExperimentalWarning|ENOENT/)
  }
})

test('time-window backfill filters all tables, includes delayed receipts and dependencies, maps users, and is repeatable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-window-')), file = path.join(root, 'source.sqlite')
  // The cutoff is shortly after Beijing midnight, on the previous UTC date.
  const cutoffDay = dayAt(Date.now() - 2 * 86400000), since = `${cutoffDay}T00:30:00+08:00`, cutoff = Date.parse(since)
  const before = new Date(cutoff - 1).toISOString(), boundary = new Date(cutoff).toISOString(), after = new Date(cutoff + 1).toISOString()
  const oldEvent = new Date(cutoff - 3600000).toISOString()
  const source = emptyState(), seed = emptyState()
  try {
    for (const id of ['old', 'active', 'profile', 'session', 'daily']) {
      source.users.push(row('users', { id, tenant: 't', issuer: 'welink', subject: id, display_name: id, profile_updated_at: id === 'profile' ? boundary : null }))
      source.user_identities.push(row('user_identities', { tenant: 't', issuer: 'welink', subject: id, user_id: id }))
    }
    seed.users.push({ ...source.users.find(value => value.id === 'active')!, id: 'already-migrated', display_name: 'newer-profile', profile_updated_at: after })
    seed.user_identities.push(row('user_identities', { tenant: 't', issuer: 'welink', subject: 'active', user_id: 'already-migrated' }))
    for (const [id, time] of [['old', before], ['boundary', boundary], ['after', after]]) {
      source.installations.push(row('installations', { tenant: 't', installation: id!, environment: 'test', last_seen: time! }))
      source.identity_sessions.push(row('identity_sessions', { ref: id!, tenant: 't', installation: id!, user_id: 'session', valid_from: time!, expires_at: after }))
    }
    for (const [id, received, occurred] of [
      ['old', before, oldEvent], ['boundary', boundary, oldEvent], ['after', after, oldEvent],
      ['event-only', after, oldEvent], ['fallback', null, after], ['old-terminal', before, oldEvent],
    ] as const) {
      source.activity_facts.push(row('activity_facts', { tenant: 't', id, user_id: id === 'old' ? 'old' : 'active', installation: 'i', occurred_at: occurred, day: dayAt(Date.parse(occurred)), operation: id === 'old-terminal' ? 'resolved' : id }))
      source.runtime_facts.push(row('runtime_facts', { tenant: 't', id, input_tokens: 7 }))
      if (received) {
        if (id !== 'event-only') source.event_dedup.push(row('event_dedup', { tenant: 't', id, digest: id, received_at: received }))
        source.tracking_events.push(row('tracking_events', { tenant: 't', id, body: '{}', received_at: received }))
      }
    }
    source.operations.push(
      row('operations', { tenant: 't', installation: 'i', operation: 'old', accepted: JSON.stringify({ eventId: 'old', occurredAt: oldEvent }) }),
      row('operations', { tenant: 't', installation: 'i', operation: 'delayed', accepted: JSON.stringify({ eventId: 'boundary', occurredAt: oldEvent }) }),
      row('operations', { tenant: 't', installation: 'i', operation: 'resolved', accepted: JSON.stringify({ eventId: 'after', occurredAt: oldEvent }), terminal: JSON.stringify({ eventId: 'old-terminal', occurredAt: oldEvent }) }),
      row('operations', { tenant: 't', installation: 'i', operation: 'fallback', terminal: JSON.stringify({ occurredAt: after }) }),
      row('operations', { tenant: 't', installation: 'i', operation: 'bad-json', accepted: '{broken-json' }),
    )
    source.ingestion_health.push(row('ingestion_health', { code: 'INVALID_EVENT', count: 100 }))
    source.tracking_events.push(row('tracking_events', { tenant: 't', id: 'bad-time', body: '{}', received_at: 'invalid' }))
    source.runtime_facts.push(row('runtime_facts', { tenant: 't', id: 'orphan' }))
    writeSource(file, source)
    const original = await readFile(file), target = destination(seed)
    const report = await backfillSqlite(file, target.target, { since, batchSize: 1 })
    const actual = target.state(), ids = (table: TableName, field = 'id') => actual[table].map(value => value[field]).sort()
    assert.deepEqual(ids('users'), ['already-migrated', 'profile', 'session'])
    assert.equal(actual.users.find(value => value.id === 'already-migrated')!.display_name, 'newer-profile')
    assert.deepEqual(ids('user_identities', 'subject'), ['active', 'profile', 'session'])
    assert.deepEqual(ids('installations', 'installation'), ['after', 'boundary'])
    assert.deepEqual(ids('identity_sessions', 'ref'), ['after', 'boundary'])
    assert.deepEqual(ids('event_dedup'), ['after', 'boundary'])
    assert.deepEqual(ids('tracking_events'), ['after', 'boundary', 'event-only'])
    assert.deepEqual(ids('activity_facts'), ['after', 'boundary', 'event-only', 'fallback', 'old-terminal'])
    assert.deepEqual(ids('runtime_facts'), ids('activity_facts'))
    assert.ok(actual.activity_facts.every(value => value.user_id === 'already-migrated'))
    assert.deepEqual(ids('operations', 'operation'), ['delayed', 'fallback', 'resolved'])
    assert.equal(actual.ingestion_health.length, 0)
    assert.equal(report.find(value => value.table === 'ingestion_health')!.skipReason, 'NO_TIME_COLUMN')
    assert.equal(report.find(value => value.table === 'tracking_events')!.read, 3)
    assert.deepEqual(await readFile(file), original)
    const again = await backfillSqlite(file, target.target, { since: boundary, batchSize: 2 })
    assert.equal(again.reduce((sum, value) => sum + value.written, 0), 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('missing receipt/context tables use fact time without full-copying undated rows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-window-legacy-')), file = path.join(root, 'source.sqlite')
  const time = Date.now() - 1000, since = new Date(time).toISOString(), source = emptyState()
  try {
    source.users.push(row('users', { id: 'u', tenant: 't', issuer: 'sso', subject: 'u' }))
    for (const [id, timestamp] of [['old', time - 1], ['new', time]] as const) {
      source.activity_facts.push(row('activity_facts', { tenant: 't', id, user_id: 'u', occurred_at: new Date(timestamp).toISOString(), day: dayAt(timestamp) }))
      source.runtime_facts.push(row('runtime_facts', { tenant: 't', id }))
    }
    writeSource(file, source)
    const sqlite = new DatabaseSync(file)
    sqlite.exec('DROP TABLE event_dedup; DROP TABLE tracking_events; DROP TABLE operations; DROP TABLE identity_sessions; ALTER TABLE users DROP COLUMN profile_updated_at')
    sqlite.prepare('UPDATE runtime_facts SET input_tokens=?, output_tokens=? WHERE id=?').run(9223372036854775807n, -9223372036854775808n, 'new')
    sqlite.close()
    const target = destination(), report = await backfillSqlite(file, target.target, { since })
    assert.deepEqual(target.state().activity_facts.map(value => value.id), ['new'])
    assert.deepEqual(target.state().runtime_facts.map(value => value.id), ['new'])
    assert.equal(target.state().runtime_facts[0]!.input_tokens, '9223372036854775807')
    assert.equal(target.state().runtime_facts[0]!.output_tokens, '-9223372036854775808')
    assert.deepEqual(target.state().users.map(value => value.id), ['u'])
    assert.equal(report.filter(value => value.missingTable).length, 4)
  } finally { await rm(root, { recursive: true, force: true }) }
})
