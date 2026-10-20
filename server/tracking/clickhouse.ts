import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { TABLES, TABLE_META, canonical, hashCanonical, rowKey, type Change, type Row, type TableName } from './canonical.js'
import type { AnalyticsConfig } from './config.js'
import { dayAt, type AnalyticsQuery } from './types.js'
import { ClickHouseHttpClient } from './clickhouse-http.js'
import { analyticsSql, logicalTableSql, normalizeQueryRow, type QueryParams } from './clickhouse-query.js'
import { EXPECTED_COLUMNS, identifier, qualified, keyFilter, typedRow } from './clickhouse-schema.js'
import { CURRENT_MIGRATIONS, migrationStatements } from './clickhouse-migrations.js'
import { atomicJson, readPrivateJson, removeDurable } from './durable-file.js'
import { cutoverLag, readUpgradeCheckpoint, timestamp, type UpgradeCheckpoint } from './upgrade-state.js'

export { ClickHouseHttpClient } from './clickhouse-http.js'
type Step = { table: TableName; keys: string[]; rows: Row[] | null }
type Batch = { format: 1; target: string; id: string; steps: Step[]; response: unknown }
type Pending = { batch: Batch; hash: string; next: number; activeQuery: string | null }
const DAY = 86400000
const deleteOrder: TableName[] = ['runtime_facts', ...TABLES.filter(table => table !== 'runtime_facts')]

export async function validateTypedSchema(client: ClickHouseHttpClient) {
  const tables = await client.query('SELECT name,engine,sorting_key,partition_key,create_table_query,as_select FROM system.tables WHERE database={database:String}', { database: client.database })
  if (tables.some(row => String(row.name).endsWith('_versions'))) throw new Error('ANALYTICS_LEGACY_SCHEMA_USE_UPGRADE')
  if (tables.length !== TABLES.length * 2) throw new Error('ANALYTICS_SCHEMA_MISMATCH_RUN_TRACKING_INIT')
  for (const name of TABLES) {
    const table = tables.find(row => row.name === name), view = tables.find(row => row.name === `${name}_current`)
    const ddl = String(table?.create_table_query)
    if (table?.engine !== 'ReplacingMergeTree' || table.sorting_key !== TABLE_META[name].primaryKey.join(', ') || table.partition_key !== '' || /\b(TTL|CONSTRAINT|INDEX|PROJECTION)\b/.test(ddl) || !/ENGINE = ReplacingMergeTree(?:\(\))? ORDER BY/.test(ddl) || !ddl.includes('fsync_after_insert = 1') || !ddl.includes('fsync_part_directory = 1') || view?.engine !== 'View' || String(view.as_select).replaceAll('`', '').replace(/\s+/g, ' ').trim() !== `SELECT * FROM ${client.database}.${name} FINAL`) throw new Error('ANALYTICS_SCHEMA_MISMATCH')
  }
  const columns = await client.query('SELECT table,name,type,default_kind FROM system.columns WHERE database={database:String} AND table IN {tables:Array(String)} ORDER BY table,position', { database: client.database, tables: TABLES })
  const expected = [...EXPECTED_COLUMNS].sort((a, b) => a.table.localeCompare(b.table)).map(column => ({ ...column, default_kind: '' }))
  if (canonical(columns) !== canonical(expected)) throw new Error('ANALYTICS_SCHEMA_MISMATCH')
  const database = (await client.query('SELECT uuid,engine FROM system.databases WHERE name={database:String}', { database: client.database }))[0]
  if (database?.engine !== 'Atomic' || !database.uuid) throw new Error('ANALYTICS_REQUIRES_ATOMIC_DATABASE')
  return String(database.uuid)
}

/** Initialize or validate typed databases. Legacy layouts must use the online upgrade. */
export async function initializeClickHouse(client: ClickHouseHttpClient) {
  await client.command(`CREATE DATABASE IF NOT EXISTS ${identifier(client.database)} ENGINE=Atomic`, {}, { database: 'default' })
  const existing = await client.query('SELECT name FROM system.tables WHERE database={database:String}', { database: client.database })
  const allowed = new Set(TABLES.flatMap(name => [name, `${name}_current`]))
  if (existing.some(row => !allowed.has(String(row.name)))) throw new Error('ANALYTICS_LEGACY_SCHEMA_USE_UPGRADE')
  for (const name of CURRENT_MIGRATIONS) for (const ddl of migrationStatements(name, client.database)) await client.command(ddl)
  return { database: client.database, uuid: await validateTypedSchema(client) }
}

/** SQL-managed accounts can be granted privileges; XML-managed accounts must be configured at deployment. */
export async function grantTypedAccess(client: ClickHouseHttpClient, config: AnalyticsConfig['clickhouse']) {
  for (const role of ['writer', 'reader'] as const) {
    const account = new ClickHouseHttpClient(config, role)
    const user = role === 'writer' ? config.writerUser : config.readerUser
    const grants = role === 'writer'
      ? [`SELECT, INSERT, ALTER DELETE ON ${identifier(client.database)}.*`, 'SELECT ON system.processes', 'SELECT ON system.mutations']
      : [`SELECT ON ${identifier(client.database)}.*`]
    try {
      for (const grant of grants) {
        const check = `CHECK GRANT ${grant}`
        if ((await account.text(check)).trim() === '1') continue
        const storage = (await client.query('SELECT storage FROM system.users WHERE name={user:String}', { user }))[0]?.storage
        if (storage === 'users_xml') throw new Error('ANALYTICS_XML_GRANTS_UPDATE_REQUIRED')
        await client.command(`GRANT ${grant} TO ${identifier(user)}`)
        if ((await account.text(check)).trim() !== '1') throw new Error('ANALYTICS_GRANTS_MISSING')
      }
    } finally { account.close() }
  }
}

/** Caller holds the directory lock and serializes whole writes, reads and maintenance. */
export class ClickHouseBackend {
  readonly client: ClickHouseHttpClient
  readonly reader: ClickHouseHttpClient
  private target = ''
  private pending: Pending | undefined
  private upgrade: UpgradeCheckpoint | undefined
  private readonly pendingFile: string
  constructor(readonly directory: string, readonly config: AnalyticsConfig, private readonly now = Date.now) {
    this.client = new ClickHouseHttpClient(config.clickhouse)
    this.reader = new ClickHouseHttpClient(config.clickhouse, 'reader')
    this.pendingFile = path.join(directory, 'typed-pending.json')
  }
  private table(name: string) { return qualified(this.client.database, name) }
  async open(allowUpgrade = false) {
    if (existsSync(path.join(this.directory, 'clickhouse-pending.json'))) throw new Error('ANALYTICS_LEGACY_PENDING_USE_NEW_DIRECTORY')
    const upgradeFile = path.join(this.directory, 'typed-upgrade.json')
    if (!allowUpgrade && existsSync(upgradeFile)) {
      this.upgrade = readUpgradeCheckpoint(upgradeFile)
      if (!['armed', 'active'].includes(this.upgrade.phase)) throw new Error('ANALYTICS_UPGRADE_INCOMPLETE')
    }
    const uuid = await validateTypedSchema(this.client)
    this.target = `${this.config.clickhouse.url}/${this.client.database}/${uuid}`
    if (this.upgrade && this.upgrade.target !== this.target) throw new Error('ANALYTICS_PENDING_TARGET_MISMATCH')
    await this.beforeRequest()
    if (existsSync(this.pendingFile)) {
      const pending = readPrivateJson(this.pendingFile) as Pending
      if (pending?.batch?.format !== 1 || pending.batch.target !== this.target || hashCanonical(pending.batch) !== pending.hash || !Number.isInteger(pending.next) || pending.next < 0 || pending.next > pending.batch.steps.length || (pending.activeQuery !== null && typeof pending.activeQuery !== 'string')) throw new Error('ANALYTICS_PENDING_TARGET_MISMATCH')
      for (const step of pending.batch.steps) {
        if (!TABLES.includes(step.table)) throw new Error('ANALYTICS_PENDING_INVALID')
        keyFilter(step.table, step.keys)
        if (step.rows && (step.rows.length !== step.keys.length || step.rows.some((row, index) => rowKey(step.table, typedRow(step.table, row)) !== step.keys[index]))) throw new Error('ANALYTICS_PENDING_INVALID')
      }
      this.pending = pending
      await this.recover()
    }
  }
  /** Startup/readiness never seals cutover; the first business write does, inside the request gate. */
  async beforeRequest(write = false) {
    if (this.upgrade?.phase !== 'armed') return
    const now = timestamp((await this.client.query("SELECT now64(3,'UTC') AS observedAt"))[0]?.observedAt)
    cutoverLag(this.upgrade.applied!.observedAt, now)
    if (write) {
      const active: UpgradeCheckpoint = { ...this.upgrade, phase: 'active', activatedAt: now }
      atomicJson(path.join(this.directory, 'typed-upgrade.json'), active)
      this.upgrade = active
    }
  }
  private save() { atomicJson(this.pendingFile, this.pending) }
  private async settle(queryId: string, table: TableName) {
    // A timed-out HTTP request can still run. Stop it before replaying its full after-images.
    await this.client.query('KILL QUERY WHERE user=currentUser() AND query_id={queryId:String} SYNC', { queryId })
    const deadline = Date.now() + this.config.clickhouse.requestTimeoutMs
    while (true) {
      const mutations = await this.client.query('SELECT count() AS remaining FROM system.mutations WHERE database={database:String} AND table={table:String} AND is_done=0', { database: this.client.database, table }, { deadline })
      if (!Number(mutations[0]?.remaining)) return
      if (Date.now() >= deadline) throw new Error('ANALYTICS_RECOVERY_PENDING')
      await delay(100)
    }
  }
  async recover() {
    const pending = this.pending
    if (!pending) return
    for (; pending.next < pending.batch.steps.length;) {
      const step = pending.batch.steps[pending.next]!
      if (pending.activeQuery) await this.settle(pending.activeQuery, step.table)
      pending.activeQuery = randomUUID(); this.save()
      const filter = keyFilter(step.table, step.keys)
      if (step.rows) {
        await this.client.insert(step.table, step.rows, { queryId: pending.activeQuery })
        const actual = new Map((await this.rows(step.table, { keys: step.keys })).map(row => [rowKey(step.table, row), canonical(row)]))
        if (step.rows.some(row => actual.get(rowKey(step.table, row)) !== canonical(row))) throw new Error('ANALYTICS_WRITE_VERIFY_FAILED')
      } else {
        await this.client.command(`ALTER TABLE ${this.table(step.table)} DELETE WHERE ${filter.predicate} SETTINGS mutations_sync=1`, filter.params, { queryId: pending.activeQuery })
        const remaining = await this.client.query(`SELECT count() AS n FROM ${this.table(step.table)} WHERE ${filter.predicate}`, filter.params)
        if (Number(remaining[0]?.n)) throw new Error('ANALYTICS_DELETE_VERIFY_FAILED')
      }
      pending.next++; pending.activeQuery = null; this.save()
    }
    removeDurable(this.pendingFile); this.pending = undefined
  }
  async rows(table: TableName, filter: { keys?: string[]; predicate?: string; params?: QueryParams } = {}, _at = this.now()): Promise<Row[]> {
    if (filter.keys?.length === 0) return []
    const keys = filter.keys ? keyFilter(table, filter.keys) : undefined
    const rows = await this.reader.query(`SELECT * FROM (${logicalTableSql(this.client.database, table)}) WHERE (${filter.predicate ?? '1'})${keys ? ` AND (${keys.predicate})` : ''}`, { ...filter.params, ...keys?.params }, { timeoutMs: this.config.queryTimeoutMs, retryOnConnectionLoss: true })
    return rows.map(row => typedRow(table, row as Row))
  }
  async query(kind: string, query: AnalyticsQuery) {
    const deadline = Date.now() + this.config.queryTimeoutMs
    const plan = analyticsSql(this.client.database, this.now(), kind, query)
    // Await every query even after one fails, before releasing the application gate.
    const results = await Promise.allSettled(plan.queries.map(async sql => (await this.reader.query(sql, plan.params, { deadline, retryOnConnectionLoss: true })).map(normalizeQueryRow)))
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    return plan.finish(results.map(result => (result as PromiseFulfilledResult<Record<string, unknown>[]>).value))
  }
  private async validate(changes: Change[]) {
    const byTable = new Map(TABLES.map(table => [table, changes.filter(change => change.table === table)]))
    for (const table of ['users', 'identity_sessions'] as const) {
      const selected = byTable.get(table)!.filter(change => change.row)
      const previous = new Map((await this.rows(table, { keys: selected.map(change => change.key) })).map(row => [rowKey(table, row), row]))
      const seen = new Map<string, string>()
      for (const { key, row } of selected) {
        const old = previous.get(key)
        if (old && (table === 'users' ? ['tenant', 'issuer', 'subject'] : ['tenant', 'installation', 'user_id']).some(column => old[column] !== row![column])) throw new Error('ANALYTICS_IDENTITY_CONFLICT')
        if (table === 'users' && ['tenant', 'issuer', 'subject'].every(column => row![column] !== null)) {
          const identity = JSON.stringify([row!.tenant, row!.issuer, row!.subject])
          if (seen.has(identity) && seen.get(identity) !== key) throw new Error('ANALYTICS_IDENTITY_CONFLICT')
          seen.set(identity, key)
          const existing = await this.rows('users', { predicate: 'tenant={tenant:String} AND issuer={issuer:String} AND subject={subject:String}', params: { tenant: row!.tenant, issuer: row!.issuer, subject: row!.subject } })
          if (existing.some(user => user.id !== row!.id)) throw new Error('ANALYTICS_IDENTITY_CONFLICT')
        }
      }
    }
    const runtime = byTable.get('runtime_facts')!.filter(change => change.row)
    const facts = new Map((await this.rows('activity_facts', { keys: runtime.map(change => change.key) })).map(row => [rowKey('activity_facts', row), row]))
    for (const change of byTable.get('activity_facts')!) { if (change.row) facts.set(change.key, change.row); else facts.delete(change.key) }
    if (runtime.some(change => !facts.has(change.key))) throw new Error('ANALYTICS_RUNTIME_ORPHAN')
    const referencing = changes.filter(change => change.row?.user_id != null)
    const userKeys = referencing.map(change => rowKey('users', { id: change.row!.user_id! }))
    const users = new Map((await this.rows('users', { keys: [...new Set(userKeys)] })).map(row => [String(row.id), row]))
    for (const change of byTable.get('users')!) { if (change.row) users.set(String(change.row.id), change.row); else users.delete(String(JSON.parse(change.key)[0])) }
    if (referencing.some(change => users.get(String(change.row!.user_id))?.tenant !== change.row!.tenant)) throw new Error('ANALYTICS_USER_REFERENCE_INVALID')
  }
  async commit(input: Change[], response: unknown = null) {
    await this.recover()
    if (!input.length) return
    const changes = input.map(change => ({ ...change, row: change.row ? typedRow(change.table, change.row) : null }))
    const seen = new Set<string>()
    for (const change of changes) {
      if (!TABLES.includes(change.table) || seen.has(`${change.table}:${change.key}`) || (change.row && rowKey(change.table, change.row) !== change.key)) throw new Error('ANALYTICS_KEY_MISMATCH')
      keyFilter(change.table, [change.key]); seen.add(`${change.table}:${change.key}`)
    }
    // Mirror SQLite's sole ON DELETE CASCADE, including a child written in an older batch.
    for (const change of [...changes]) if (change.table === 'activity_facts' && !change.row && !seen.has(`runtime_facts:${change.key}`)) changes.push({ table: 'runtime_facts', key: change.key, row: null })
    await this.validate(changes)
    const steps: Step[] = []
    for (const table of deleteOrder) {
      const removed = changes.filter(change => change.table === table && !change.row)
      if (removed.length) steps.push({ table, keys: removed.map(change => change.key), rows: null })
    }
    for (const table of TABLES) {
      const inserted = changes.filter(change => change.table === table && change.row)
      if (inserted.length) steps.push({ table, keys: inserted.map(change => change.key), rows: inserted.map(change => change.row!) })
    }
    const batch: Batch = { format: 1, target: this.target, id: randomUUID(), steps, response }
    this.pending = { batch, hash: hashCanonical(batch), next: 0, activeQuery: null }
    this.save(); await this.recover()
  }
  async maintain() {
    const at = this.now(), before = (days: number) => new Date(at - days * DAY).toISOString()
    const criteria: [TableName, string, QueryParams][] = [
      ['tracking_events', "received_at < parseDateTime64BestEffort({cutoff:String},3,'UTC')", { cutoff: before(90) }],
      ['event_dedup', "received_at < parseDateTime64BestEffort({cutoff:String},3,'UTC')", { cutoff: before(120) }],
      ['identity_sessions', "expires_at < parseDateTime64BestEffort({cutoff:String},3,'UTC')", { cutoff: before(120) }],
      ['operations', `coalesce(JSONExtract(ifNull(terminal,'{}'),'occurredAt','Nullable(String)'),JSONExtract(ifNull(accepted,'{}'),'occurredAt','Nullable(String)')) < {cutoff:String}`, { cutoff: before(120) }],
      ['activity_facts', 'day < {cutoff:Date}', { cutoff: dayAt(at - 400 * DAY) }],
    ]
    for (const [table, predicate, params] of criteria) {
      while (true) {
        const keys = TABLE_META[table].primaryKey.map(identifier).join(',')
        const expired = await this.reader.query(`SELECT ${keys} FROM (${logicalTableSql(this.client.database, table)}) WHERE ${predicate} ORDER BY ${keys} LIMIT 1000`, params)
        if (!expired.length) break
        await this.commit(expired.map(row => ({ table, key: rowKey(table, row as Row), row: null })))
      }
    }
  }
  close() { this.client.close(); this.reader.close() }
}
