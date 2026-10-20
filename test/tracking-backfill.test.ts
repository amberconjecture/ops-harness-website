import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { integrationTest as test, createTestDatabase, prepareTestDatabase } from './helpers/clickhouse.js'
import { event, installation } from './helpers/tracking-events.js'
import { TABLES, TABLE_META, applyChanges, emptyState, canonical, hashCanonical, rowKey, type State, type Row, type TableName } from '../server/tracking/canonical.js'
import { decideIngest } from '../server/tracking/decision.js'
import { backfillSqlite } from '../scripts/tracking/backfill.js'
import { dayAt } from '../server/tracking/types.js'
import { TrackingDatabase } from '../server/tracking/database.js'
import { ClickHouseHttpClient, grantTypedAccess } from '../server/tracking/clickhouse.js'
import { qualified, identifier } from '../server/tracking/clickhouse-schema.js'
import { migrationStatements } from '../server/tracking/clickhouse-migrations.js'
import { upgradeClickHouse } from '../scripts/tracking/upgrade.js'

function writeSource(file: string, state: State) {
  const db = new DatabaseSync(file)
  try {
    for (const table of TABLES) {
      const columns = TABLE_META[table].columns
      db.exec(`CREATE TABLE ${table} (${columns.map(column => `"${column}"`).join(',')})`)
      const insert = db.prepare(`INSERT INTO ${table} VALUES (${columns.map(() => '?').join(',')})`)
      for (const row of state[table]) insert.run(...columns.map(column => row[column]!))
    }
  } finally { db.close() }
}
const query = () => ({ from: dayAt(Date.now() - 60 * 86400000), to: dayAt(Date.now()), environment: 'all', offset: 0, limit: 100 })

test('backfill adds missing rows and changed pending facts, skips bad rows, maps employees, and can be repeated', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-backfill-')), db = await createTestDatabase(root)
  try {
    const i = installation(), now = Date.now(), accepted = event(i)
    const terminal = { ...accepted, eventId: randomUUID(), eventName: 'operation.finished' as const, outcome: 'succeeded' as const, changed: true }
    // The migrated database has a pending terminal and an existing employee ID.
    await db.ingest(i, [terminal])
    const first = decideIngest(emptyState(), i, [terminal], now)
    const source = applyChanges(applyChanges(emptyState(), first.changes), decideIngest(applyChanges(emptyState(), first.changes), i, [accepted], now).changes)
    const old = event(i, { occurredAt: new Date(now - 45 * 86400000).toISOString(), employee: { source: 'welink', employeeId: 'older-person' } })
    const final = applyChanges(source, decideIngest(source, i, [old], now - 45 * 86400000).changes)
    const sourceFile = path.join(root, 'source.sqlite')
    writeSource(sourceFile, final)
    const corrupt = new DatabaseSync(sourceFile)
    corrupt.prepare('INSERT INTO tracking_events VALUES (?,?,?,?)').run(null, randomUUID(), '{}', new Date(now).toISOString()); corrupt.close()
    const before = await readFile(sourceFile)
    const recent = await backfillSqlite(sourceFile, db.backend, { since: new Date(now - 86400000).toISOString(), batchSize: 1 })
    // The previously migrated terminal may also differ in its server receipt timestamp.
    assert.equal(recent.find(row => row.table === 'tracking_events')?.read, 3)
    assert.equal((await db.query('health', query())).collected, 2)
    assert.equal((await db.query('users', query())).total, 1)
    const since = new Date(now - 60 * 86400000).toISOString()
    const report = await backfillSqlite(sourceFile, db.backend, { since, batchSize: 1 })
    assert.ok(report.reduce((n, row) => n + row.written, 0) > 0)
    assert.equal(report.find(row => row.table === 'tracking_events')?.skipped, 1)
    assert.deepEqual(await readFile(sourceFile), before)
    assert.equal((await db.query('health', query())).collected, 3)
    assert.equal((await db.query('overview', query())).successes, 1)
    assert.equal((await db.query('users', query())).total, 2)
    const again = await backfillSqlite(sourceFile, db.backend, { since, batchSize: 2 })
    assert.equal(again.reduce((n, row) => n + row.written, 0), 0)
    assert.equal((await db.ingest(i, [accepted])).duplicateIds.length, 1)
    assert.equal((await db.ingest(i, [event(i)])).acceptedIds.length, 1)
    assert.equal((await db.query('users', query())).total, 2)
  } finally { await db.close(); await rm(root, { recursive: true, force: true }) }
})

test('a partially inserted batch blocks reads, recovers after restart and does not double count', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-recovery-'))
  const config = await prepareTestDatabase(root)
  let db = new TrackingDatabase(root, config)
  try {
    await db.ready
    const i = installation(), accepted = event(i), insert = db.backend.client.insert.bind(db.backend.client)
    db.backend.client.insert = async (table, rows, options) => {
      if (table === 'activity_facts') throw new Error('SIMULATED_CONNECTION_LOSS')
      return insert(table, rows, options)
    }
    await assert.rejects(db.ingest(i, [accepted]), /SIMULATED_CONNECTION_LOSS/)
    await assert.rejects(db.query('health', query()), /SIMULATED_CONNECTION_LOSS/)
    await db.close(); db = new TrackingDatabase(root, config); await db.ready
    assert.equal((await db.ingest(i, [accepted])).duplicateIds.length, 1)
    const second = event(i), publish = db.backend.client.insert.bind(db.backend.client)
    db.backend.client.insert = async (table, rows, options) => { await publish(table, rows, options); if (table === 'tracking_events') throw new Error('SIMULATED_RESPONSE_LOSS') }
    await assert.rejects(db.ingest(i, [second]), /SIMULATED_RESPONSE_LOSS/)
    await db.close(); db = new TrackingDatabase(root, config); await db.ready
    assert.equal((await db.ingest(i, [second])).duplicateIds.length, 1)
    assert.equal((await db.query('health', query())).collected, 2)
  } finally { await db.close(); await rm(root, { recursive: true, force: true }) }
})

test('online baseline preserves published state, excludes tails and tombstones, and resumes an interrupted insert', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-upgrade-')), config = await prepareTestDatabase(root)
  const sourceDatabase = `${config.clickhouse.database}_old`, client = new ClickHouseHttpClient({ ...config.clickhouse, database: sourceDatabase })
  const table = (name: string) => qualified(sourceDatabase, name), epoch = randomUUID()
  let db: TrackingDatabase | undefined
  try {
    await client.command(`CREATE DATABASE ${identifier(sourceDatabase)}`, {}, { database: 'default' })
    for (const ddl of migrationStatements('0001_tracking_baseline', sourceDatabase)) await client.command(ddl)
    await client.insert('projection_manifest', [{ epoch, projection_id: 'legacy', baseline_seq: '0', manifest_hash: hashCanonical('legacy'), ttl_grace_seconds: 86400 }])
    await client.insert('tracking_runtime', [{ payload: canonical({ epoch, startSeq: 1, excluded: [{ after: 1, through: 3 }], ttlGraceSeconds: 86400 }) }])
    const version = (seq: number, count: number) => ({ source_epoch: epoch, key: rowKey('ingestion_health', { code: 'TEST' }), commit_seq: String(seq), deleted: 0, payload: canonical({ code: 'TEST', count }), payload_hash: hashCanonical({ code: 'TEST', count }), retention_day: '', partition_date: '1970-01-01', physical_delete_at: '2106-02-07 06:28:15' })
    const gone = { ...version(4, 7), key: rowKey('ingestion_health', { code: 'GONE' }), payload: canonical({ code: 'GONE', count: 7 }), payload_hash: hashCanonical({ code: 'GONE', count: 7 }) }
    await client.insert('ingestion_health_versions', [version(1, 1), version(2, 999), version(6, 9999), gone, { ...gone, commit_seq: '5', deleted: 1 }])
    await client.insert('published_watermarks', [{ epoch, seq: '5', hash: hashCanonical('legacy'), baseline: 0 }])
    const insert = ClickHouseHttpClient.prototype.insert
    let loseResponse = true
    t.mock.method(ClickHouseHttpClient.prototype, 'insert', async function (this: ClickHouseHttpClient, ...args: Parameters<typeof insert>) {
      await insert.apply(this, args)
      if (this.database === config.clickhouse.database && args[0] === 'ingestion_health' && loseResponse) {
        loseResponse = false
        throw new Error('SIMULATED_UPGRADE_RESPONSE_LOSS')
      }
    })
    await assert.rejects(upgradeClickHouse(root, config, sourceDatabase, { batchSize: 1 }), /SIMULATED_UPGRADE_RESPONSE_LOSS/)
    const incomplete = new TrackingDatabase(root, config)
    await assert.rejects(incomplete.ready, /ANALYTICS_UPGRADE_INCOMPLETE/)
    await assert.rejects(incomplete.close(), /ANALYTICS_UPGRADE_INCOMPLETE/)
    const report = await upgradeClickHouse(root, config, sourceDatabase, { batchSize: 1 })
    assert.equal(report.tables.ingestion_health?.written, 1)
    assert.equal(report.tables.ingestion_health?.deleted, 1)
    const armed = await upgradeClickHouse(root, config, sourceDatabase, { finalize: true })
    assert.equal(armed.mode, 'incremental')
    assert.equal(armed.phase, 'armed')
    assert.deepEqual(armed.tables, {})
    assert.equal((await client.query(`SELECT count() AS n FROM ${table('ingestion_health_versions')}`))[0]!.n, '5')
    db = new TrackingDatabase(root, config); await db.ready
    assert.deepEqual(await db.backend.rows('ingestion_health'), [{ code: 'TEST', count: 1 }])
    const i = installation(), value = event(i)
    assert.equal((await db.ingest(i, [value])).acceptedIds.length, 1)
    assert.equal((await db.backend.rows('ingestion_health'))[0]!.count, 1)
    await db.close(); db = undefined
    await assert.rejects(upgradeClickHouse(root, config, sourceDatabase), /ANALYTICS_UPGRADE_TARGET_ACTIVE/)
  } finally { if (db) await db.close(); await client.command(`DROP DATABASE ${identifier(sourceDatabase)} SYNC`, {}, { database: 'default' }); client.close(); await rm(root, { recursive: true, force: true }) }
})

test('runtime works with granted writer/reader, recovers interrupted cleanup, serializes retries and drops expired queued work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-permissions-')), config = await prepareTestDatabase(root)
  const admin = new ClickHouseHttpClient(config.clickhouse), suffix = randomUUID().replaceAll('-', '')
  const writer = `website_writer_${suffix}`, reader = `website_reader_${suffix}`
  let db: TrackingDatabase | undefined
  try {
    await admin.command(`CREATE USER ${writer} IDENTIFIED WITH no_password`)
    await admin.command(`CREATE USER ${reader} IDENTIFIED WITH no_password SETTINGS readonly=2`)
    const runtimeConfig = { ...config, clickhouse: { ...config.clickhouse, writerUser: writer, readerUser: reader } }
    await grantTypedAccess(admin, runtimeConfig.clickhouse)
    await grantTypedAccess(admin, runtimeConfig.clickhouse)
    db = new TrackingDatabase(root, runtimeConfig)
    await db.ready
    const i = installation(), value = event(i)
    const results = await Promise.all(Array.from({ length: 6 }, () => db!.ingest(i, [value])))
    assert.equal(results.reduce((sum, result) => sum + result.acceptedIds.length, 0), 1)
    assert.equal(results.reduce((sum, result) => sum + result.duplicateIds.length, 0), 5)
    await assert.rejects(db.ingest(i, [event(i)], Date.now() - 1), /ANALYTICS_QUEUE_TIMEOUT/)
    assert.equal((await db.query('health', query())).collected, 1)
    const expired = { tenant: i.tenantId, id: randomUUID(), body: '{}', received_at: '2020-01-01T00:00:00.000Z' }
    await db.backend.commit([{ table: 'tracking_events', key: rowKey('tracking_events', expired), row: expired }])
    const command = db.backend.client.command.bind(db.backend.client)
    db.backend.client.command = async (...args) => {
      await command(...args)
      if (args[0].startsWith('ALTER TABLE')) throw new Error('SIMULATED_CLEANUP_RESPONSE_LOSS')
    }
    await assert.rejects(db.maintain(), /SIMULATED_CLEANUP_RESPONSE_LOSS/)
    await db.close(); db = new TrackingDatabase(root, runtimeConfig); await db.ready
    await db.maintain()
    assert.equal((await db.query('health', query())).collected, 1)
  } finally {
    if (db) await db.close()
    await admin.command(`DROP USER IF EXISTS ${writer},${reader}`)
    admin.close(); await rm(root, { recursive: true, force: true })
  }
})

test('online baseline counts expired runtime children as retention but refuses historical invalid rows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-upgrade-limits-')), config = await prepareTestDatabase(root)
  const sourceDatabase = `${config.clickhouse.database}_old`, client = new ClickHouseHttpClient({ ...config.clickhouse, database: sourceDatabase }), epoch = randomUUID()
  const version = (table: TableName, row: Row) => ({ source_epoch: epoch, key: rowKey(table, row), commit_seq: '1', deleted: 0, payload: canonical(row), payload_hash: hashCanonical(row), retention_day: '', partition_date: '1970-01-01', physical_delete_at: '2106-02-07 06:28:15' })
  try {
    await client.command(`CREATE DATABASE ${identifier(sourceDatabase)}`, {}, { database: 'default' })
    for (const ddl of migrationStatements('0001_tracking_baseline', sourceDatabase)) await client.command(ddl)
    await client.insert('projection_manifest', [{ epoch, projection_id: 'legacy', baseline_seq: '0', manifest_hash: hashCanonical('legacy'), ttl_grace_seconds: 86400 }])
    await client.insert('tracking_runtime', [{ payload: canonical({ epoch, startSeq: 1, excluded: [], ttlGraceSeconds: 86400 }) }])
    await client.insert('published_watermarks', [{ epoch, seq: '1', hash: hashCanonical('legacy'), baseline: 0 }])
    const rows = (table: TableName) => Array.from({ length: 101 }, (_, index) => ({
      ...Object.fromEntries(TABLE_META[table].columns.map(column => [column, null])),
      tenant: 't', id: String(index), ...(table === 'activity_facts' ? { day: '2020-01-01' } : {}),
    }))
    await client.insert('activity_fact_versions', rows('activity_facts').map(row => version('activity_facts', row)))
    await client.insert('runtime_fact_versions', rows('runtime_facts').map(row => version('runtime_facts', row)))
    const report = await upgradeClickHouse(root, config, sourceDatabase)
    assert.equal(report.tables.activity_facts?.expired, 101)
    assert.equal(report.tables.runtime_facts?.expired, 101)
    await client.insert('ingestion_health_versions', Array.from({ length: 101 }, (_, index) => version('ingestion_health', { code: `BAD_${index}`, count: 'invalid' })))
    const limitedRoot = path.join(root, 'limited'), limitedConfig = await prepareTestDatabase(limitedRoot)
    await assert.rejects(upgradeClickHouse(limitedRoot, limitedConfig, sourceDatabase), /ANALYTICS_UPGRADE_INVALID_ROW/)
    assert.equal(JSON.parse(await readFile(path.join(limitedRoot, 'typed-upgrade.json'), 'utf8')).phase, 'copying')
  } finally { await client.command(`DROP DATABASE ${identifier(sourceDatabase)} SYNC`, {}, { database: 'default' }); client.close(); await rm(root, { recursive: true, force: true }) }
})
