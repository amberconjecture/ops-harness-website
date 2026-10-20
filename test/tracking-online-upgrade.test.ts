import assert from 'node:assert/strict'
import unitTest, { type TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { integrationTest as test, prepareTestDatabase } from './helpers/clickhouse.js'
import { TABLE_META, canonical, hashCanonical, rowKey, type Change, type Row, type TableName } from '../server/tracking/canonical.js'
import { ClickHouseHttpClient } from '../server/tracking/clickhouse.js'
import { ClickHouseTransportError } from '../server/tracking/clickhouse-errors.js'
import { ENTITY_TABLES, identifier, qualified } from '../server/tracking/clickhouse-schema.js'
import { TrackingDatabase } from '../server/tracking/database.js'
import { migrationStatements } from '../server/tracking/clickhouse-migrations.js'
import { atomicJson } from '../server/tracking/durable-file.js'
import { cutoverLag, MAX_CUTOVER_LAG_MS, readUpgradeCheckpoint } from '../server/tracking/upgrade-state.js'
import { upgradeClickHouse } from '../scripts/tracking/upgrade.js'
import { event, installation } from './helpers/tracking-events.js'
import { createTrackingHandlers } from '../server/tracking/http.js'
import type { TrackingStore } from '../server/tracking/store.js'

const make = (table: TableName, values: Row): Change => {
  const row = { ...Object.fromEntries(TABLE_META[table].columns.map(column => [column, null])), ...values }
  return { table, key: rowKey(table, row), row }
}
const remove = (table: TableName, values: Row): Change => ({ table, key: rowKey(table, values), row: null })
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-online-')), config = await prepareTestDatabase(root)
  const sourceDatabase = `${config.clickhouse.database}_old`, epoch = randomUUID()
  const source = new ClickHouseHttpClient({ ...config.clickhouse, database: sourceDatabase }), target = new ClickHouseHttpClient(config.clickhouse)
  const databases: TrackingDatabase[] = []
  t.after(async () => {
    for (const db of databases) await db.close().catch(() => {})
    try { await source.command(`DROP DATABASE IF EXISTS ${identifier(sourceDatabase)} SYNC`, {}, { database: 'default' }) }
    finally { source.close(); target.close(); await rm(root, { recursive: true, force: true }) }
  })
  await source.command(`CREATE DATABASE ${identifier(sourceDatabase)}`, {}, { database: 'default' })
  for (const ddl of migrationStatements('0001_tracking_baseline', sourceDatabase)) await source.command(ddl)
  await source.insert('projection_manifest', [{ epoch, projection_id: 'legacy', baseline_seq: '0', manifest_hash: hashCanonical('legacy'), ttl_grace_seconds: 86400 }])
  await source.insert('tracking_runtime', [{ payload: canonical({ epoch, startSeq: 1, excluded: [], ttlGraceSeconds: 86400 }) }])
  await source.insert('published_watermarks', [{ epoch, seq: '0', hash: hashCanonical('legacy'), baseline: 1 }])
  const publish = async (seq: number, changes: Change[], options: { journal?: boolean; watermark?: boolean } = {}) => {
    const versions: Record<string, Record<string, unknown>[]> = {}
    for (const { table, key, row } of changes) (versions[table] ??= []).push({ source_epoch: epoch, key, commit_seq: String(seq), deleted: row ? 0 : 1, payload: canonical(row), payload_hash: hashCanonical(row), retention_day: '', partition_date: '1970-01-01', physical_delete_at: '2106-02-07 06:28:15' })
    const commit = { epoch, seq, createdAt: new Date().toISOString(), versions }, hash = hashCanonical(commit)
    if (options.journal !== false) await source.insert('tracking_commits', [{ source_epoch: epoch, seq: String(seq), created_at: commit.createdAt, payload: canonical(commit), hash }])
    for (const [table, rows] of Object.entries(versions)) await source.insert(ENTITY_TABLES[table as TableName], rows)
    if (options.watermark !== false) await source.insert('published_watermarks', [{ epoch, seq: String(seq), hash, baseline: 0 }])
  }
  const start = () => { const db = new TrackingDatabase(root, config); databases.push(db); return db }
  const rows = (table: TableName) => target.query(`SELECT * FROM ${qualified(target.database, table)} FINAL ORDER BY ${TABLE_META[table].primaryKey.map(identifier).join(',')}`)
  const sync = (options: Parameters<typeof upgradeClickHouse>[3] = {}) => upgradeClickHouse(root, config, sourceDatabase, options)
  const checkpointFile = path.join(root, 'typed-upgrade.json')
  return { root, config, sourceDatabase, source, target, epoch, publish, start, rows, sync, checkpointFile }
}

unitTest('cutover window includes exactly five minutes and rejects stale/future observations', () => {
  const time = Date.parse('2026-10-20T00:00:00.000Z'), at = new Date(time).toISOString()
  assert.equal(cutoverLag(at, new Date(time + MAX_CUTOVER_LAG_MS).toISOString()), MAX_CUTOVER_LAG_MS)
  assert.throws(() => cutoverLag(at, new Date(time + MAX_CUTOVER_LAG_MS + 1).toISOString()), /CATCHUP_REQUIRED/)
  assert.throws(() => cutoverLag(at, new Date(time - 1).toISOString()), /CATCHUP_REQUIRED/)
})

test('online baseline and multiple incremental rounds include late updates and deletes without entity rescans', async t => {
  const f = await fixture(t)
  const user = make('users', { id: 'u', tenant: 't', issuer: 'welink', subject: '001', display_name: 'initial' })
  const fact = make('activity_facts', { tenant: 't', id: 'a', pending: 1 })
  await f.publish(1, [user, fact, make('runtime_facts', { tenant: 't', id: 'a', input_tokens: 7 }), make('ingestion_health', { code: 'TEST', count: 1 })])
  const insert = ClickHouseHttpClient.prototype.insert
  let onInsert: (() => Promise<void>) | undefined = () => f.publish(2, [
    { ...user, row: { ...user.row!, display_name: 'updated' } }, { ...fact, row: { ...fact.row!, pending: 0, user_id: 'u' } },
    make('tracking_events', { tenant: 't', id: 'b', body: '{}', received_at: new Date().toISOString() }), make('ingestion_health', { code: 'TEST', count: 9 }),
  ])
  t.mock.method(ClickHouseHttpClient.prototype, 'insert', async function (this: ClickHouseHttpClient, ...args: Parameters<typeof insert>) {
    await insert.apply(this, args)
    if (this.database === f.target.database && args[0] === 'users' && onInsert) { const run = onInsert; onInsert = undefined; await run() }
  })
  const first = await f.sync()
  assert.equal(first.mode, 'baseline'); assert.equal(first.throughSeq, 1); assert.equal(first.phase, 'ready')
  assert.equal((await f.rows('users'))[0]!.display_name, 'initial')
  assert.equal((await f.rows('activity_facts'))[0]!.pending, '1')
  const blocked = f.start(); await assert.rejects(blocked.ready, /UPGRADE_INCOMPLETE/)
  await f.publish(3, [make('ingestion_health', { code: 'TEST', count: 10 })])
  onInsert = () => f.publish(4, [remove('activity_facts', { tenant: 't', id: 'a' })])
  const iterate = ClickHouseHttpClient.prototype.iterate, reads: string[] = []
  t.mock.method(ClickHouseHttpClient.prototype, 'iterate', async function* (this: ClickHouseHttpClient, ...args: Parameters<typeof iterate>) {
    if (this.database === f.sourceDatabase) reads.push(args[0])
    yield* iterate.apply(this, args)
  })
  const second = await f.sync()
  assert.equal(second.mode, 'incremental'); assert.equal(second.fromSeq, 1); assert.equal(second.throughSeq, 3)
  assert.equal(second.tables.ingestion_health?.read, 2); assert.equal(second.tables.ingestion_health?.written, 1)
  assert.equal((await f.rows('ingestion_health'))[0]!.count, '10')
  assert.equal((await f.rows('activity_facts'))[0]!.pending, '0')
  assert.equal((await f.rows('users'))[0]!.display_name, 'updated')
  assert.ok(reads.some(sql => sql.includes('tracking_commits') && sql.includes('seq>{after:UInt64}')))
  assert.ok(reads.every(sql => !/FROM\s+`[^`]+`\.`\w+_versions`/.test(sql)), 'incremental copy must use the sequence index, not scan entity history')
  await f.publish(5, [{ ...fact, row: { ...fact.row!, pending: 0 } }, make('ingestion_health', { code: 'TEST', count: 11 })])
  const third = await f.sync({ batchSize: 2000 })
  assert.equal(third.fromSeq, 3); assert.equal(third.throughSeq, 5)
  assert.equal((await f.rows('activity_facts')).length, 1)
  assert.equal((await f.rows('runtime_facts')).length, 0, 'delete then reinsert must not restore the previous runtime row')
  const last = await f.sync({ finalize: true })
  assert.deepEqual(last.tables, {}); assert.equal(last.phase, 'armed')
  const live = f.start(); await live.ready; await live.readiness()
  assert.equal(readUpgradeCheckpoint(f.checkpointFile).phase, 'armed')
  const i = installation(); await live.ingest(i, [event(i)]); await live.close()
  assert.equal(readUpgradeCheckpoint(f.checkpointFile).phase, 'active')
  await assert.rejects(f.sync(), /TARGET_ACTIVE/)
  assert.equal((await f.source.query(`SELECT max(seq) AS seq FROM ${qualified(f.sourceDatabase, 'published_watermarks')}`))[0]!.seq, '5')
})

test('interrupted incremental commit resumes its original watermark even while the source advances', async t => {
  const f = await fixture(t)
  await f.publish(1, [make('ingestion_health', { code: 'TEST', count: 1 })]); await f.sync()
  await f.publish(2, [make('ingestion_health', { code: 'TEST', count: 7 })])
  const insert = ClickHouseHttpClient.prototype.insert
  let fail = true
  t.mock.method(ClickHouseHttpClient.prototype, 'insert', async function (this: ClickHouseHttpClient, ...args: Parameters<typeof insert>) {
    await insert.apply(this, args)
    if (fail && this.database === f.target.database && args[0] === 'ingestion_health') {
      fail = false
      await f.publish(3, [make('ingestion_health', { code: 'TEST', count: 12 })])
      throw new Error('SIMULATED_INCREMENTAL_RESPONSE_LOSS')
    }
  })
  await assert.rejects(f.sync(), /SIMULATED_INCREMENTAL_RESPONSE_LOSS/)
  assert.equal(readUpgradeCheckpoint(f.checkpointFile).applied?.seq, 1)
  assert.equal(readUpgradeCheckpoint(f.checkpointFile).round?.through.seq, 2)
  const resumed = await f.sync()
  assert.equal(resumed.throughSeq, 2); assert.equal(resumed.tables.ingestion_health?.written, 0)
  assert.equal(resumed.tables.ingestion_health?.unchanged, 1, 'the recovered batch must not be inserted again by journal replay')
  assert.equal((await f.rows('ingestion_health'))[0]!.count, '7')
  const next = await f.sync()
  assert.equal(next.fromSeq, 2); assert.equal(next.throughSeq, 3)
  assert.equal((await f.rows('ingestion_health'))[0]!.count, '12')
})

test('unchanged incremental snapshots advance and resume without inserts while real updates still replace full rows', async t => {
  const f = await fixture(t), at = new Date().toISOString()
  const user = make('users', { id: 'u', tenant: 't', issuer: 'welink', subject: '001', display_name: 'initial', dept_name: 'old' })
  const snapshot = [
    user, make('users', { id: 'u2', tenant: 't', issuer: 'welink', subject: '002' }),
    make('user_identities', { tenant: 't', issuer: 'welink', subject: '001', user_id: 'u' }),
    make('installations', { tenant: 't', installation: 'i', environment: 'production', last_seen: at }),
    make('identity_sessions', { ref: 's', tenant: 't', installation: 'i', user_id: 'u', valid_from: at, expires_at: at }),
    make('event_dedup', { tenant: 't', id: 'e', digest: 'digest', received_at: at }),
    make('operations', { tenant: 't', installation: 'i', operation: 'o', accepted: canonical({ occurredAt: at }) }),
    make('activity_facts', { tenant: 't', id: 'e', user_id: 'u', installation: 'i', day: at.slice(0, 10), occurred_at: at, pending: 0 }),
    make('runtime_facts', { tenant: 't', id: 'e', input_tokens: 7 }),
    make('tracking_events', { tenant: 't', id: 'e', body: '{}', received_at: at }),
    make('ingestion_health', { code: 'TEST', count: 1 }),
  ]
  await f.publish(1, snapshot); await f.sync()
  await f.target.command(`SYSTEM STOP MERGES ${qualified(f.target.database, 'users')}`)
  await f.publish(2, snapshot); await f.publish(3, snapshot)

  const insert = ClickHouseHttpClient.prototype.insert, writes: string[] = []
  t.mock.method(ClickHouseHttpClient.prototype, 'insert', async function (this: ClickHouseHttpClient, ...args: Parameters<typeof insert>) {
    if (this.database === f.target.database) writes.push(args[0])
    return insert.apply(this, args)
  })
  const query = ClickHouseHttpClient.prototype.query
  let publishWhileCopying = true
  t.mock.method(ClickHouseHttpClient.prototype, 'query', async function (this: ClickHouseHttpClient, ...args: Parameters<typeof query>) {
    const rows = await query.apply(this, args)
    if (publishWhileCopying && this.database === f.sourceDatabase && args[0].includes('`tracking_commits`')) {
      publishWhileCopying = false
      await f.publish(4, snapshot)
    }
    return rows
  })
  await assert.rejects(f.sync({ batchSize: 1, progress: row => {
    const progress = row as { stage?: string; appliedSeq?: number }
    if (progress.stage === 'batch_complete' && progress.appliedSeq === 2) throw new Error('SIMULATED_UNCHANGED_INTERRUPTION')
  } }), /SIMULATED_UNCHANGED_INTERRUPTION/)
  assert.equal(readUpgradeCheckpoint(f.checkpointFile).round?.cursorSeq, 2)

  const progress: Record<string, unknown>[] = []
  const resumed = await f.sync({ batchSize: 1, progress: row => progress.push(row as Record<string, unknown>) })
  assert.equal(resumed.throughSeq, 3); assert.equal(resumed.phase, 'ready')
  assert.deepEqual(progress[0], { stage: 'round_start', mode: 'incremental', fromSeq: 1, appliedSeq: 2, throughSeq: 3, remainingSeqUpperBound: 1 })
  assert.equal(progress.at(-1)!.remainingSeqUpperBound, 0)
  assert.deepEqual(writes, [])
  for (const table of Object.keys(TABLE_META) as TableName[]) {
    const expected = snapshot.filter(change => change.table === table).length * 2
    assert.equal(resumed.tables[table]?.read, expected)
    assert.equal(resumed.tables[table]?.unchanged, expected)
    assert.equal(resumed.tables[table]?.written, 0)
  }
  const next = await f.sync()
  assert.equal(next.fromSeq, 3); assert.equal(next.throughSeq, 4)
  assert.deepEqual(writes, [])
  assert.equal((await f.target.query(`SELECT count() AS n FROM ${qualified(f.target.database, 'users')}`))[0]!.n, '2')

  const updated = { ...user, row: { ...user.row!, display_name: 'updated', dept_name: null } }
  await f.publish(5, [updated]); await f.publish(6, [updated])
  const changed = await f.sync({ batchSize: 1, finalize: true })
  assert.equal(changed.phase, 'armed'); assert.equal(changed.throughSeq, 6)
  assert.equal(changed.tables.users?.written, 1); assert.equal(changed.tables.users?.unchanged, 1)
  assert.deepEqual(writes, ['users'])
  const current = (await f.rows('users')).find(row => row.id === 'u')!
  assert.equal(current.display_name, 'updated'); assert.equal(current.dept_name, null)
  assert.equal((await f.target.query(`SELECT count() AS n FROM ${qualified(f.target.database, 'users')}`))[0]!.n, '3')
})

test('idle source can arm cutover, readiness does not activate, and stale first writes are refused', async t => {
  const f = await fixture(t)
  await f.publish(1, [make('ingestion_health', { code: 'TEST', count: 1 })]); await f.sync({ finalize: true })
  let db = f.start(); await db.ready
  const handlers = createTrackingHandlers(db as unknown as TrackingStore, { enabled: true, defaultEnvironment: 'production' })
  const server = createServer((req, res) => { void handlers.collect(req, res, new URL(req.url!, 'http://127.0.0.1')) })
  server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const port = (server.address() as { port: number }).port
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/tracking/ready`)).status, 200)
  assert.equal(readUpgradeCheckpoint(f.checkpointFile).phase, 'armed')
  const query = db.backend.client.query.bind(db.backend.client)
  db.backend.client.query = async (...args) => args[0] === "SELECT now64(3,'UTC') AS observedAt" ? [{ observedAt: new Date(Date.now() + 301000).toISOString() }] : query(...args)
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/tracking/ready`)).status, 503)
  const i = installation()
  await assert.rejects(db.ingest(i, [event(i)]), /CATCHUP_REQUIRED/)
  assert.equal(readUpgradeCheckpoint(f.checkpointFile).phase, 'armed')
  assert.equal((await f.rows('activity_facts')).length, 0)
  await db.close()
  const stale = readUpgradeCheckpoint(f.checkpointFile)
  stale.applied!.observedAt = new Date(Date.now() - 301000).toISOString(); atomicJson(f.checkpointFile, stale)
  const rejected = f.start(); await assert.rejects(rejected.ready, /CATCHUP_REQUIRED/)
  const fresh = await f.sync({ finalize: true })
  assert.equal(fresh.throughSeq, 1); assert.ok(fresh.lagMs < 300000); assert.deepEqual(fresh.tables, {})
  db = f.start(); await db.ready; await db.ingest(i, [event(i)]); await db.close()
  const active = readUpgradeCheckpoint(f.checkpointFile)
  active.applied!.observedAt = new Date(Date.now() - 301000).toISOString(); atomicJson(f.checkpointFile, active)
  db = f.start(); await db.ready; await db.readiness()
  db.backend.reader.query = async () => { throw new Error('SIMULATED_DATABASE_OUTAGE') }
  await assert.rejects(db.readiness(), /SIMULATED_DATABASE_OUTAGE/)
  await db.close()
  await assert.rejects(f.sync({ finalize: true }), /TARGET_ACTIVE/)
})

test('missing journal commits and regressed watermarks never advance the checkpoint or authorize cutover', async t => {
  const f = await fixture(t)
  await f.publish(1, [make('ingestion_health', { code: 'TEST', count: 1 })]); await f.sync()
  await f.publish(3, [make('ingestion_health', { code: 'TEST', count: 3 })])
  await assert.rejects(f.sync({ finalize: true }), /COMMIT_GAP/)
  assert.equal(readUpgradeCheckpoint(f.checkpointFile).applied?.seq, 1)
  assert.equal((await f.rows('ingestion_health'))[0]!.count, '1')
  await f.publish(2, [make('ingestion_health', { code: 'TEST', count: 2 })])
  const repaired = await f.sync()
  assert.equal(repaired.throughSeq, 3); assert.equal((await f.rows('ingestion_health'))[0]!.count, '3')
  await f.source.command(`TRUNCATE TABLE ${qualified(f.sourceDatabase, 'published_watermarks')}`)
  await f.source.insert('published_watermarks', [{ epoch: f.epoch, seq: '1', hash: hashCanonical('rollback'), baseline: 0 }])
  await assert.rejects(f.sync(), /SOURCE_CHANGED/)
  assert.equal(readUpgradeCheckpoint(f.checkpointFile).applied?.seq, 3)
})

test('finalize rejects a round older than five minutes and a fresh no-op catch-up can re-arm it', async t => {
  const f = await fixture(t)
  await f.publish(1, [make('ingestion_health', { code: 'TEST', count: 1 })]); await f.sync()
  const query = ClickHouseHttpClient.prototype.query
  let stale = true
  t.mock.method(ClickHouseHttpClient.prototype, 'query', async function (this: ClickHouseHttpClient, ...args: Parameters<typeof query>) {
    const rows = await query.apply(this, args)
    if (stale && this.database === f.sourceDatabase && args[0].includes('max(seq) AS seq,now64')) {
      return rows.map(row => ({ ...row, observedAt: new Date(Date.now() - 301000).toISOString() }))
    }
    return rows
  })
  await assert.rejects(f.sync({ finalize: true }), /CATCHUP_REQUIRED/)
  assert.equal(readUpgradeCheckpoint(f.checkpointFile).phase, 'ready')
  stale = false
  assert.equal((await f.sync({ finalize: true })).phase, 'armed')
})

test('incremental continuity skips declared unpublished intervals and refuses a changed source lineage', async t => {
  const f = await fixture(t)
  await f.source.command(`TRUNCATE TABLE ${qualified(f.sourceDatabase, 'tracking_runtime')}`)
  const runtime = { epoch: f.epoch, startSeq: 1, excluded: [{ after: 1, through: 3 }, { after: 4, through: 6 }], ttlGraceSeconds: 86400 }
  await f.source.insert('tracking_runtime', [{ payload: canonical(runtime) }])
  await f.publish(1, [make('ingestion_health', { code: 'TEST', count: 1 })]); await f.sync()
  await f.publish(2, [make('ingestion_health', { code: 'TEST', count: 99 })], { watermark: false })
  await f.publish(4, [make('ingestion_health', { code: 'TEST', count: 4 })])
  await f.publish(7, [make('ingestion_health', { code: 'TEST', count: 7 })])
  const incremental = await f.sync({ batchSize: 2 })
  assert.equal(incremental.throughSeq, 7); assert.equal(incremental.tables.ingestion_health?.read, 2)
  assert.equal((await f.rows('ingestion_health'))[0]!.count, '7')
  await f.source.command(`TRUNCATE TABLE ${qualified(f.sourceDatabase, 'tracking_runtime')}`)
  await f.source.insert('tracking_runtime', [{ payload: canonical({ ...runtime, excluded: [] }) }])
  await assert.rejects(f.sync({ finalize: true }), /SOURCE_CHANGED/)
  assert.equal(readUpgradeCheckpoint(f.checkpointFile).phase, 'ready')
})

test('corrupt source commit fails closed without importing it or arming the target', async t => {
  const f = await fixture(t)
  await f.publish(1, [make('ingestion_health', { code: 'TEST', count: 1 })]); await f.sync()
  await f.publish(2, [make('ingestion_health', { code: 'TEST', count: 2 })], { journal: false })
  await f.source.insert('tracking_commits', [{ source_epoch: f.epoch, seq: '2', created_at: new Date().toISOString(), payload: '{}', hash: hashCanonical('invalid') }])
  await assert.rejects(f.sync({ finalize: true }), /INVALID_COMMIT/)
  assert.equal(readUpgradeCheckpoint(f.checkpointFile).applied?.seq, 1)
  assert.equal(readUpgradeCheckpoint(f.checkpointFile).phase, 'copying')
  assert.equal((await f.rows('ingestion_health'))[0]!.count, '1')
})

test('expired baseline resumes its saved target and cursor without changing the watermark or cutover deadline', async t => {
  const f = await fixture(t)
  await f.publish(1, ['A', 'B', 'C'].map(code => make('ingestion_health', { code, count: 1 })))
  await assert.rejects(f.sync({ batchSize: 1, progress: row => {
    if ((row as { table?: string }).table === 'ingestion_health') throw new Error('SIMULATED_BASELINE_INTERRUPTION')
  } }), /SIMULATED_BASELINE_INTERRUPTION/)
  const saved = readUpgradeCheckpoint(f.checkpointFile)
  assert.equal(saved.round?.cursor, rowKey('ingestion_health', { code: 'A' }))
  assert.equal((await f.rows('ingestion_health')).length, 1)
  // Model an old format=2 checkpoint whose original baseline is now outside the TTL grace.
  saved.round!.through.observedAt = new Date(Date.now() - 86400000).toISOString()
  atomicJson(f.checkpointFile, saved)
  await f.publish(2, [make('ingestion_health', { code: 'A', count: 9 })])

  const insert = ClickHouseHttpClient.prototype.insert, inserted: unknown[] = []
  t.mock.method(ClickHouseHttpClient.prototype, 'insert', async function (this: ClickHouseHttpClient, ...args: Parameters<typeof insert>) {
    if (this.database === f.target.database && args[0] === 'ingestion_health') inserted.push(...args[1].map(row => row.code))
    return insert.apply(this, args)
  })
  const progress: Record<string, unknown>[] = []
  const resumed = await f.sync({ batchSize: 1, progress: row => progress.push(row as Record<string, unknown>) })
  assert.equal(resumed.mode, 'baseline'); assert.equal(resumed.phase, 'ready'); assert.equal(resumed.throughSeq, 1)
  assert.equal(resumed.observedAt, saved.round!.through.observedAt)
  assert.equal(Date.parse(resumed.cutoverDeadline), Date.parse(resumed.observedAt) + MAX_CUTOVER_LAG_MS)
  assert.deepEqual(inserted, ['B', 'C'])
  assert.deepEqual((await f.rows('ingestion_health')).map(row => [row.code, row.count]), [['A', '1'], ['B', '1'], ['C', '1']])
  const completed = readUpgradeCheckpoint(f.checkpointFile)
  assert.equal(completed.format, 2); assert.equal(completed.target, saved.target); assert.equal(completed.binding, saved.binding)
  assert.deepEqual(completed.applied, saved.round!.through)
  const warnings = progress.filter(row => row.warning)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]!.warning, 'ANALYTICS_UPGRADE_BASELINE_RETENTION_ELAPSED')
  assert.equal(warnings[0]!.observedAt, resumed.observedAt)
  assert.equal(warnings[0]!.graceSeconds, 86400)
  const blocked = f.start(); await assert.rejects(blocked.ready, /UPGRADE_INCOMPLETE/)
  const fresh = await f.sync({ finalize: true })
  assert.equal(fresh.mode, 'incremental'); assert.equal(fresh.fromSeq, 1); assert.equal(fresh.throughSeq, 2); assert.equal(fresh.phase, 'armed')
  assert.equal((await f.rows('ingestion_health'))[0]!.count, '9')
  assert.equal((await f.source.query(`SELECT max(seq) AS seq FROM ${qualified(f.sourceDatabase, 'published_watermarks')}`))[0]!.seq, '2')
})

test('bounded source pages finish before target writes can exhaust their HTTP deadline', async t => {
  const f = await fixture(t)
  await f.publish(1, Array.from({ length: 5 }, (_, index) => make('ingestion_health', { code: `HEALTH${index}`, count: index })))
  await f.publish(2, [make('ingestion_health', { code: 'HEALTH0', count: 100 }), remove('ingestion_health', { code: 'HEALTH4' })])
  const iterate = ClickHouseHttpClient.prototype.iterate, insert = ClickHouseHttpClient.prototype.insert
  let openResponses = 0
  const pages: { kind: string; rows: number }[] = []
  t.mock.method(ClickHouseHttpClient.prototype, 'iterate', async function* (this: ClickHouseHttpClient, ...args: Parameters<typeof iterate>) {
    const kind = this.database === f.sourceDatabase ? args[0].includes('`ingestion_health_versions`') && args[0].includes('argMax') ? 'baseline' : args[0].includes('`tracking_commits`') ? 'incremental' : undefined : undefined
    if (!kind) { yield* iterate.apply(this, args); return }
    const page = { kind, rows: 0 }; pages.push(page); openResponses++
    try { for await (const row of iterate.apply(this, args)) { page.rows++; yield row } }
    finally { openResponses-- }
  })
  t.mock.method(ClickHouseHttpClient.prototype, 'insert', async function (this: ClickHouseHttpClient, ...args: Parameters<typeof insert>) {
    // Model a target write that lasts longer than the remaining source response budget.
    if (this.database === f.target.database && openResponses) throw new ClickHouseTransportError('ANALYTICS_QUERY_TIMEOUT', {
      phase: 'body', operation: 'table_export', queryId: 'fixture-source-deadline', requestElapsedMs: 300001, attempt: 1, transportCode: 'ABORT_TIMEOUT',
    })
    return insert.apply(this, args)
  })
  await f.sync({ batchSize: 2 })
  assert.deepEqual(pages.filter(page => page.kind === 'baseline').map(page => page.rows), [1, 2, 2])
  assert.deepEqual((await f.rows('ingestion_health')).map(row => [row.code, row.count]), [
    ['HEALTH0', '100'], ['HEALTH1', '1'], ['HEALTH2', '2'], ['HEALTH3', '3'],
  ])
  for (const [seq, code, count] of [[3, 'HEALTH0', 20], [4, 'HEALTH1', 30], [5, 'HEALTH2', 40]] as const) await f.publish(seq, [make('ingestion_health', { code, count })])
  await f.publish(6, [remove('ingestion_health', { code: 'HEALTH3' })])
  await f.publish(7, [make('ingestion_health', { code: 'HEALTH3', count: 60 })])
  const delta = await f.sync({ batchSize: 2, finalize: true })
  assert.equal(delta.throughSeq, 7); assert.equal(delta.phase, 'armed')
  assert.deepEqual(pages.filter(page => page.kind === 'incremental').map(page => page.rows), [2, 2, 1])
  assert.deepEqual((await f.rows('ingestion_health')).map(row => [row.code, row.count]), [
    ['HEALTH0', '20'], ['HEALTH1', '30'], ['HEALTH2', '40'], ['HEALTH3', '60'],
  ])
})

test('conflicting journal copies at a page boundary cannot be skipped by the sequence cursor', async t => {
  const f = await fixture(t)
  await f.publish(1, [make('ingestion_health', { code: 'TEST', count: 1 })]); await f.sync()
  await f.source.command(`SYSTEM STOP MERGES ${qualified(f.sourceDatabase, 'tracking_commits')}`)
  await f.publish(2, [make('ingestion_health', { code: 'TEST', count: 2 })])
  await f.publish(2, [make('ingestion_health', { code: 'TEST', count: 99 })])
  await assert.rejects(f.sync({ batchSize: 1, finalize: true }), /INVALID_COMMIT/)
  assert.equal(readUpgradeCheckpoint(f.checkpointFile).applied?.seq, 1)
  assert.equal((await f.rows('ingestion_health'))[0]!.count, '1')
})
