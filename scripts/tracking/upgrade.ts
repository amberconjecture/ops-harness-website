import path from 'node:path'
import { existsSync } from 'node:fs'
import { TABLES, hashCanonical, rowKey, type Change, type Row, type TableName } from '../../server/tracking/canonical.js'
import { ClickHouseBackend, ClickHouseHttpClient, initializeClickHouse, grantTypedAccess } from '../../server/tracking/clickhouse.js'
import { ENTITY_TABLES, identifier, qualified, keyFilter, typedRow } from '../../server/tracking/clickhouse-schema.js'
import { atomicJson } from '../../server/tracking/durable-file.js'
import { replicaTailSql, type ReplicaTail } from '../../server/tracking/replica-tail.js'
import { dayAt } from '../../server/tracking/types.js'
import { acquireTrackingLock } from '../../server/tracking/lock.js'
import { MAX_CUTOVER_LAG_MS, cutoverLag, readUpgradeCheckpoint, sequence, timestamp, type UpgradeCheckpoint, type UpgradePosition, type UpgradeTables } from '../../server/tracking/upgrade-state.js'
import type { AnalyticsConfig } from '../../server/tracking/config.js'

const DAY = 86400000
type Version = { source_epoch: string; commit_seq: string; key: string; deleted: number; payload: string; payload_hash: string }
type LegacyCommit = { epoch: string; seq: number; createdAt: string; versions: Partial<Record<TableName | 'user_day', Version[]>> }
const countsFor = (tables: UpgradeTables, table: TableName) => tables[table] ??= { read: 0, written: 0, deleted: 0, expired: 0 }
async function serverTime(client: ClickHouseHttpClient) { return timestamp((await client.query("SELECT now64(3,'UTC') AS observedAt"))[0]?.observedAt) }
function expired(table: TableName, row: Row, at: string) {
  const cutoff = (days: number) => new Date(Date.parse(at) - days * DAY).toISOString()
  if (table === 'tracking_events' || table === 'event_dedup') return row.received_at !== null && String(row.received_at) < cutoff(table === 'tracking_events' ? 90 : 120)
  if (table === 'identity_sessions') return row.expires_at !== null && String(row.expires_at) < cutoff(120)
  if (table === 'activity_facts') return row.day !== null && String(row.day) < dayAt(Date.parse(at) - 400 * DAY)
  if (table === 'operations') {
    const time = row.terminal ? JSON.parse(String(row.terminal)).occurredAt : row.accepted ? JSON.parse(String(row.accepted)).occurredAt : null
    return time !== null && time < cutoff(120)
  }
  return false
}
function nextSequence(after: number, excluded: ReplicaTail[]) {
  let next = after + 1
  for (const range of [...excluded].sort((a, b) => a.after - b.after)) if (next > range.after && next <= range.through) next = range.through + 1
  return sequence(next)
}

/** Source stays online. The target is exclusively owned by this CLI until explicitly armed for cutover. */
export async function upgradeClickHouse(directory: string, config: AnalyticsConfig, sourceDatabase: string, options: { batchSize?: number; finalize?: boolean; progress?: (row: unknown) => void } = {}) {
  identifier(sourceDatabase)
  if (sourceDatabase === config.clickhouse.database) throw new Error('ANALYTICS_UPGRADE_REQUIRES_NEW_DATABASE')
  const batchSize = options.batchSize ?? 500
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2000) throw new Error('INVALID_BATCH_SIZE')
  const unlock = acquireTrackingLock(directory, 'typed-upgrade')
  const connection = config.clickhouse
  const adminConfig = { ...config, clickhouse: { ...connection, writerUser: connection.adminUser, writerPasswordEnv: connection.adminPasswordEnv, readerUser: connection.adminUser, readerPasswordEnv: connection.adminPasswordEnv } }
  const source = new ClickHouseHttpClient({ ...adminConfig.clickhouse, database: sourceDatabase })
  const target = new ClickHouseBackend(directory, adminConfig)
  const file = path.join(directory, 'typed-upgrade.json')
  try {
    let checkpoint = existsSync(file) ? readUpgradeCheckpoint(file) : undefined
    if (checkpoint?.phase === 'active') throw new Error('ANALYTICS_UPGRADE_TARGET_ACTIVE')
    const tables = new Set((await source.query('SELECT name FROM system.tables WHERE database={database:String}', { database: sourceDatabase })).map(row => String(row.name)))
    if (['projection_manifest', 'published_watermarks', 'tracking_runtime', 'tracking_commits', ...Object.values(ENTITY_TABLES)].some(table => !tables.has(table))) throw new Error('ANALYTICS_ONLINE_UPGRADE_SOURCE_UNSUPPORTED')
    const lineage = async () => {
      const manifest = await source.query(`SELECT DISTINCT epoch,ttl_grace_seconds FROM ${qualified(sourceDatabase, 'projection_manifest')}`)
      const states = await source.query(`SELECT DISTINCT payload FROM ${qualified(sourceDatabase, 'tracking_runtime')}`)
      if (manifest.length !== 1 || states.length !== 1) throw new Error('ANALYTICS_RUNTIME_CONFLICT')
      const runtime = JSON.parse(String(states[0]!.payload)) as { epoch: string; startSeq: number; excluded: ReplicaTail[]; ttlGraceSeconds: number }
      if (runtime.epoch !== manifest[0]!.epoch || !Array.isArray(runtime.excluded)) throw new Error('ANALYTICS_RUNTIME_CONFLICT')
      sequence(runtime.startSeq); replicaTailSql(runtime.excluded)
      const excluded = [...runtime.excluded]
      if (tables.has('authority_manifest')) {
        const rows = await source.query(`SELECT payload FROM ${qualified(sourceDatabase, 'authority_manifest')} ORDER BY revision DESC LIMIT 1`)
        if (rows.length) {
          const state = JSON.parse(String(rows[0]!.payload)) as { epoch: string; replicaTail?: ReplicaTail }
          if (state.epoch === runtime.epoch && state.replicaTail) excluded.push(state.replicaTail)
        }
      }
      replicaTailSql(excluded)
      const uuid = String((await source.query('SELECT uuid FROM system.databases WHERE name={database:String}', { database: sourceDatabase }))[0]?.uuid)
      const graceSeconds = Math.min(sequence(runtime.ttlGraceSeconds), sequence(manifest[0]!.ttl_grace_seconds))
      if (graceSeconds < 60) throw new Error('ANALYTICS_UPGRADE_SOURCE_RETENTION_UNSAFE')
      return { uuid, runtime, excluded, graceSeconds }
    }
    const origin = await lineage(), epoch = origin.runtime.epoch, tail = replicaTailSql(origin.excluded)
    const head = async (): Promise<UpgradePosition> => {
      const rows = await source.query(`SELECT count() AS n,max(seq) AS seq,now64(3,'UTC') AS observedAt FROM ${qualified(sourceDatabase, 'published_watermarks')} WHERE epoch={epoch:UUID}`, { epoch })
      if (!Number(rows[0]?.n)) throw new Error('ANALYTICS_BASELINE_NOT_READY')
      return { seq: sequence(rows[0]!.seq), observedAt: timestamp(rows[0]!.observedAt) }
    }
    const initialized = await initializeClickHouse(target.client)
    await grantTypedAccess(target.client, connection)
    const targetId = `${connection.url}/${initialized.database}/${initialized.uuid}`
    // Stable identity excludes the advancing publication watermark.
    const binding = hashCanonical({ sourceUrl: connection.url, sourceDatabase, origin, target: targetId })
    const position = await head()
    if (checkpoint) {
      if (checkpoint.binding !== binding || checkpoint.target !== targetId || position.seq < (checkpoint.round?.through.seq ?? checkpoint.applied!.seq)) throw new Error('ANALYTICS_UPGRADE_SOURCE_CHANGED')
    } else {
      if (existsSync(path.join(directory, 'typed-pending.json'))) throw new Error('ANALYTICS_UPGRADE_TARGET_NOT_EMPTY')
      for (const table of TABLES) if ((await target.client.query(`SELECT 1 FROM ${qualified(connection.database, table)} LIMIT 1`)).length) throw new Error('ANALYTICS_UPGRADE_TARGET_NOT_EMPTY')
      checkpoint = { format: 2, binding, target: targetId, phase: 'copying', applied: null, rounds: 0, lastRound: null, activatedAt: null, round: null }
    }
    if (!checkpoint.round) checkpoint.round = {
      mode: checkpoint.applied ? 'incremental' : 'baseline', fromSeq: checkpoint.applied?.seq ?? 0, through: position,
      tableIndex: 0, cursor: '', cursorSeq: checkpoint.applied?.seq ?? 0, tables: {},
    }
    checkpoint.phase = 'copying'; atomicJson(file, checkpoint)
    await target.open(true)
    const round = checkpoint.round
    const ensureSource = async () => {
      if (hashCanonical(await lineage()) !== hashCanonical(origin)) throw new Error('ANALYTICS_UPGRADE_SOURCE_CHANGED')
      const now = await serverTime(source), elapsed = Date.parse(now) - Date.parse(round.through.observedAt)
      if (elapsed < 0) throw new Error('ANALYTICS_UPGRADE_INVALID_TIME')
      // Active baseline rows can disappear only after the legacy TTL grace has elapsed.
      if (round.mode === 'baseline' && elapsed >= (origin.graceSeconds - 1) * 1000) throw new Error('ANALYTICS_UPGRADE_BASELINE_EXPIRED_USE_NEW_TARGET')
      return now
    }
    const convert = (table: TableName, key: string, payload: string, deleted: number, hash: string, tables = round.tables): Change => {
      const counts = countsFor(tables, table); counts.read++
      try {
        keyFilter(table, [key])
        if (deleted !== 0 && deleted !== 1) throw new Error()
        const raw = JSON.parse(payload) as Row | null
        if (hashCanonical(raw) !== hash) throw new Error()
        if (deleted) { counts.deleted++; return { table, key, row: null } }
        if (!raw || rowKey(table, raw) !== key) throw new Error()
        const row = typedRow(table, raw)
        if (expired(table, row, round.through.observedAt)) { counts.expired++; return { table, key, row: null } }
        return { table, key, row }
      } catch {
        options.progress?.({ table, keyHash: hashCanonical(key), error: 'ANALYTICS_UPGRADE_INVALID_ROW' })
        throw new Error('ANALYTICS_UPGRADE_INVALID_ROW')
      }
    }
    const apply = async (input: Change[]) => {
      const changes = new Map(input.map(change => [`${change.table}:${change.key}`, change]))
      const children = input.filter(change => change.table === 'runtime_facts' && change.row)
      if (children.length) {
        const parents = new Map((await target.rows('activity_facts', { keys: children.map(change => change.key) })).map(row => [rowKey('activity_facts', row), row]))
        for (const change of input) if (change.table === 'activity_facts') {
          if (change.row) parents.set(change.key, change.row); else parents.delete(change.key)
        }
        const missing = children.filter(change => !parents.has(change.key))
        const removed = new Set(input.filter(change => change.table === 'activity_facts' && !change.row).map(change => change.key))
        const lookup = missing.filter(change => !removed.has(change.key)).map(change => change.key)
        if (lookup.length) for (const parent of await source.query(`SELECT key,argMax(tuple(payload,deleted,payload_hash),commit_seq) AS latest
          FROM ${qualified(sourceDatabase, ENTITY_TABLES.activity_facts)}
          WHERE source_epoch={epoch:UUID} AND commit_seq<={watermark:UInt64}${tail} AND key IN {keys:Array(String)} GROUP BY key`, { epoch, watermark: round.through.seq, keys: lookup })) {
          const [payload, deleted, hash] = parent.latest as [string, number, string]
          const raw = JSON.parse(payload) as Row
          if (!deleted && hashCanonical(raw) === hash && rowKey('activity_facts', raw) === parent.key && expired('activity_facts', typedRow('activity_facts', raw), round.through.observedAt)) removed.add(String(parent.key))
        }
        for (const child of missing) {
          if (!removed.has(child.key)) throw new Error('ANALYTICS_RUNTIME_ORPHAN')
          countsFor(round.tables, 'runtime_facts').expired++
          changes.set(`runtime_facts:${child.key}`, { ...child, row: null })
        }
      }
      const batch = [...changes.values()]
      // The baseline target starts empty; tombstones/expired rows need no physical mutation.
      const selected = round.mode === 'baseline' ? batch.filter(change => change.row) : batch
      await target.commit(selected)
      for (const change of selected) if (change.row) countsFor(round.tables, change.table).written++
    }
    await ensureSource()
    if (round.mode === 'baseline') {
      for (; round.tableIndex < TABLES.length;) {
        const table = TABLES[round.tableIndex]!
        countsFor(round.tables, table)
        const from = `FROM ${qualified(sourceDatabase, ENTITY_TABLES[table])}
          WHERE source_epoch={epoch:UUID} AND commit_seq<={watermark:UInt64}${tail} AND key>{cursor:String}`
        // Find the next key boundary using the sorting index before reading wide JSON payloads.
        const keyPage = `SELECT key ${from} ORDER BY key LIMIT {limit:UInt64}`
        const sql = `SELECT key,argMax(tuple(payload,deleted,payload_hash),commit_seq) AS latest
          ${from} AND key<={throughKey:String} GROUP BY key ORDER BY key`
        while (true) {
          // Drain a bounded response before writing: target work must not consume the source HTTP deadline.
          const params = { epoch, watermark: round.through.seq, cursor: round.cursor }
          const keys = await source.query(keyPage, { ...params, limit: batchSize }, { operation: 'table_export' })
          if (!keys.length) break
          const throughKey = String(keys.at(-1)!.key)
          const records = await source.query(sql, { ...params, throughKey }, { operation: 'table_export' })
          const batch = records.map(record => {
            const [payload, deleted, hash] = record.latest as [string, number, string]
            return convert(table, String(record.key), payload, deleted, hash)
          })
          await apply(batch)
          round.cursor = throughKey; atomicJson(file, checkpoint)
          options.progress?.({ mode: round.mode, table, ...round.tables[table] })
        }
        await ensureSource()
        round.tableIndex++; round.cursor = ''; atomicJson(file, checkpoint)
      }
    } else {
      // The old journal is indexed by (source_epoch,seq), so catch-up never rescans all entity versions.
      // Read every copy within a bounded sequence interval, including conflicts at the page boundary.
      const sql = `SELECT seq,any(tuple(payload,hash)) AS content,uniqExact(tuple(payload,hash)) AS variants FROM ${qualified(sourceDatabase, 'tracking_commits')}
        WHERE source_epoch={epoch:UUID} AND seq>{after:UInt64} AND seq<={through:UInt64}${tail.replaceAll('commit_seq', 'seq')}
        GROUP BY seq ORDER BY seq`
      // One journal row contains a whole original commit, potentially many business rows.
      const pageSize = Math.min(batchSize, 32)
      let cursor = round.cursorSeq, scanned = 0
      const batch = new Map<string, Change>()
      const flush = async () => {
        await apply([...batch.values()])
        round.cursorSeq = cursor; atomicJson(file, checkpoint)
        options.progress?.({ mode: round.mode, appliedSeq: cursor, throughSeq: round.through.seq, tables: round.tables })
        batch.clear(); scanned = 0
      }
      while (nextSequence(cursor, origin.excluded) <= round.through.seq) {
        const through = Math.min(round.through.seq, nextSequence(cursor, origin.excluded) + pageSize - 1)
        const records = await source.query(sql, { epoch, after: cursor, through }, { operation: 'table_export' })
        if (!records.length) break
        for (const record of records) {
          const seq = sequence(record.seq)
          if (seq !== nextSequence(cursor, origin.excluded)) throw new Error('ANALYTICS_UPGRADE_COMMIT_GAP')
          let commit: LegacyCommit
          try {
            if (sequence(record.variants) !== 1 || !Array.isArray(record.content) || record.content.length !== 2) throw new Error()
            const [payload, hash] = record.content
            commit = JSON.parse(String(payload)) as LegacyCommit
            if (hashCanonical(commit) !== hash || commit.epoch !== epoch || commit.seq !== seq || !commit.versions || typeof commit.versions !== 'object' || Array.isArray(commit.versions)) throw new Error()
            timestamp(commit.createdAt)
            if (Object.keys(commit.versions).some(table => table !== 'user_day' && !TABLES.includes(table as TableName))) throw new Error()
          } catch { throw new Error('ANALYTICS_UPGRADE_INVALID_COMMIT') }
          const seen = new Set<string>()
          const commitChanges: Change[] = [], commitTables: UpgradeTables = {}
          for (const table of TABLES) {
            const versions = commit.versions[table] ?? []
            if (!Array.isArray(versions)) throw new Error('ANALYTICS_UPGRADE_INVALID_COMMIT')
            for (const version of versions) {
              const key = `${table}:${version.key}`
              if (version.source_epoch !== epoch || sequence(version.commit_seq) !== seq || seen.has(key)) throw new Error('ANALYTICS_UPGRADE_INVALID_COMMIT')
              seen.add(key)
              commitChanges.push(convert(table, version.key, version.payload, version.deleted, version.payload_hash, commitTables))
            }
          }
          // Never coalesce across a deletion: a later parent reinsertion must not resurrect its old child.
          const removes = commitChanges.some(change => !change.row)
          if (removes && cursor !== round.cursorSeq) await flush()
          for (const [table, counts] of Object.entries(commitTables)) {
            const total = countsFor(round.tables, table as TableName)
            total.read += counts.read; total.deleted += counts.deleted; total.expired += counts.expired
          }
          for (const change of commitChanges) batch.set(`${change.table}:${change.key}`, change)
          scanned += commitChanges.length
          cursor = seq
          if (removes || scanned >= batchSize) await flush()
        }
        if (cursor !== round.cursorSeq) await flush()
      }
      if (nextSequence(cursor, origin.excluded) <= round.through.seq) throw new Error('ANALYTICS_UPGRADE_COMMIT_GAP')
      if (cursor !== round.cursorSeq) await flush()
    }
    const finishedAt = await ensureSource()
    if ((await head()).seq < round.through.seq) throw new Error('ANALYTICS_UPGRADE_SOURCE_CHANGED')
    checkpoint.applied = round.through; checkpoint.rounds++
    checkpoint.lastRound = { mode: round.mode, fromSeq: round.fromSeq, throughSeq: round.through.seq, tables: round.tables }
    checkpoint.round = null; checkpoint.phase = 'ready'; atomicJson(file, checkpoint)
    const lagMs = Date.parse(finishedAt) - Date.parse(checkpoint.applied.observedAt)
    if (options.finalize) {
      cutoverLag(checkpoint.applied.observedAt, finishedAt)
      checkpoint.phase = 'armed'; atomicJson(file, checkpoint)
    }
    return {
      phase: checkpoint.phase, round: checkpoint.rounds, ...checkpoint.lastRound, observedAt: checkpoint.applied.observedAt, finishedAt, lagMs,
      cutoverDeadline: new Date(Date.parse(checkpoint.applied.observedAt) + MAX_CUTOVER_LAG_MS).toISOString(),
    }
  } finally { source.close(); target.close(); unlock() }
}
