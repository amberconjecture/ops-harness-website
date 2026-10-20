// The only production import of node:sqlite: an offline, read-only source adapter.
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import { TABLES, TABLE_META, canonical, rowKey, type Change, type Row, type TableName } from '../../server/tracking/canonical.js'
import type { ClickHouseBackend } from '../../server/tracking/clickhouse.js'
import { INTEGER_COLUMNS, typedRow } from '../../server/tracking/clickhouse-schema.js'
import { parseBackfillSince } from './backfill-time.js'

export type BackfillProgress = { table: TableName; read: number; written: number; unchanged: number; skipped: number; missingTable?: boolean; skipReason?: 'NO_TIME_COLUMN' }
type SourceSchema = Map<TableName, Set<string>>

function sourceFilters(schema: SourceSchema): Record<TableName, string> {
  const has = (table: TableName, ...columns: string[]) => columns.every(column => schema.get(table)?.has(column))
  const dated = (table: TableName, alias: string, column: string) => has(table, column) ? `julianday(${alias}."${column}") >= julianday(:since)` : '0'
  // Receipt time includes events uploaded after rollback even when they occurred earlier.
  // Facts outlive the receipt tables; their own event time is the remaining fallback.
  const received = (tenant: string, id: string, fallback: string) => {
    const times = (['event_dedup', 'tracking_events'] as const).filter(table => has(table, 'tenant', 'id', 'received_at'))
      .map(table => `(SELECT julianday(receipt.received_at) FROM "${table}" receipt WHERE receipt.tenant=${tenant} AND receipt.id=${id})`)
    times.push(`julianday(${fallback})`)
    return times.length > 1 ? `COALESCE(${times.join(',')})` : times[0]!
  }
  const operation = (alias: string) => (['accepted', 'terminal'] as const).filter(column => has('operations', 'tenant', column)).map(column => {
    const json = `${alias}."${column}"`
    // Malformed JSON is a skipped source row, never a reason to abort the table scan.
    return `(CASE WHEN json_valid(${json}) THEN ${received(`${alias}.tenant`, `json_extract(${json},'$.eventId')`, `json_extract(${json},'$.occurredAt')`)} >= julianday(:since) ELSE 0 END)`
  }).join(' OR ') || '0'
  const fact = (alias: string) => {
    if (!has('activity_facts', 'tenant', 'id', 'occurred_at')) return '0'
    const recent = `${received(`${alias}.tenant`, `${alias}.id`, `${alias}.occurred_at`)} >= julianday(:since)`
    // A newly received acceptance can resolve an older pending terminal fact.
    const context = has('activity_facts', 'installation', 'operation') && has('operations', 'tenant', 'installation', 'operation')
      ? ` OR EXISTS (SELECT 1 FROM operations o WHERE o.tenant=${alias}.tenant AND o.installation=${alias}.installation AND o.operation=${alias}.operation AND (${operation('o')}))` : ''
    return `(${recent}${context})`
  }
  const relatedUsers: string[] = []
  if (has('activity_facts', 'user_id')) relatedUsers.push(`SELECT f.user_id FROM activity_facts f WHERE f.user_id IS NOT NULL AND (${fact('f')})`)
  if (has('identity_sessions', 'user_id')) relatedUsers.push(`SELECT i.user_id FROM identity_sessions i WHERE i.user_id IS NOT NULL AND (${dated('identity_sessions', 'i', 'valid_from')})`)
  const user = (alias: string) => `(${dated('users', alias, 'profile_updated_at')}${relatedUsers.length ? ` OR ${alias}.id IN (${relatedUsers.join(' UNION ')})` : ''})`
  const identityUsers = has('users', 'id') ? `SELECT u.id FROM users u WHERE ${user('u')}` : relatedUsers.join(' UNION ')
  return {
    users: user('s'),
    user_identities: has('user_identities', 'user_id') && identityUsers ? `s.user_id IN (${identityUsers})` : '0',
    installations: dated('installations', 's', 'last_seen'),
    identity_sessions: dated('identity_sessions', 's', 'valid_from'),
    event_dedup: dated('event_dedup', 's', 'received_at'),
    operations: operation('s'),
    activity_facts: fact('s'),
    runtime_facts: has('runtime_facts', 'tenant', 'id') && has('activity_facts', 'tenant', 'id')
      ? `EXISTS (SELECT 1 FROM activity_facts f WHERE f.tenant=s.tenant AND f.id=s.id AND (${fact('f')}))` : '0',
    tracking_events: dated('tracking_events', 's', 'received_at'),
    ingestion_health: '0',
  }
}

function* sourceBatches(statement: StatementSync, since: string, filtered: boolean, batchSize: number) {
  let batch: Row[] = []
  statement.setReadBigInts(true)
  // Keep a single SQLite cursor: subqueries selecting related users are not rerun per page.
  for (const row of statement.iterate(filtered ? { ':since': since } : {})) {
    batch.push(Object.fromEntries(Object.entries(row).map(([column, value]) => [column,
      typeof value === 'bigint' && INTEGER_COLUMNS.has(column) ? String(value) : value,
    ])) as Row)
    if (batch.length === batchSize) { yield batch; batch = [] }
  }
  if (batch.length) yield batch
}
function sourceRow(table: TableName, value: Row): Row {
  const row = typedRow(table, value)
  if (table === 'operations') for (const field of ['accepted', 'terminal']) if (row[field] !== null && !Number.isFinite(Date.parse(String(JSON.parse(String(row[field])).occurredAt)))) throw new Error('INVALID_SOURCE_OPERATION')
  return row
}
/** Select rows since the inclusive cutoff and required context in SQLite, then write missing/changed keys in bounded chunks. */
export async function backfillSqlite(file: string, target: Pick<ClickHouseBackend, 'rows' | 'commit'>, options: { since: string; batchSize?: number; progress?: (value: BackfillProgress) => void }) {
  const since = parseBackfillSince(options.since)
  if (!statSync(file).isFile()) throw new Error('SQLITE_SOURCE_NOT_A_FILE')
  const batchSize = options.batchSize ?? 500
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2000) throw new Error('INVALID_BATCH_SIZE')
  const source = new DatabaseSync(file, { readOnly: true })
  const mapping = new Map<string, string>(), report: BackfillProgress[] = []
  try {
    source.exec('PRAGMA query_only=ON; BEGIN')
    const schema: SourceSchema = new Map()
    for (const table of TABLES) if (source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      schema.set(table, new Set(source.prepare(`PRAGMA table_info("${table}")`).all().map(row => String(row.name))))
    }
    const filters = sourceFilters(schema)
    for (const table of TABLES) {
      const counts: BackfillProgress = { table, read: 0, written: 0, unchanged: 0, skipped: 0 }
      report.push(counts)
      const columns = schema.get(table)
      if (!columns) {
        counts.missingTable = true; options.progress?.({ ...counts }); continue
      }
      if (table === 'ingestion_health') {
        counts.skipReason = 'NO_TIME_COLUMN'; options.progress?.({ ...counts }); continue
      }
      const select = TABLE_META[table].columns.map(column => columns.has(column) ? `s."${column}"` : `NULL AS "${column}"`).join(',')
      const statement = source.prepare(`SELECT ${select} FROM "${table}" s WHERE ${filters[table]} ORDER BY s.rowid`)
      for (const batch of sourceBatches(statement, since, filters[table].includes(':since'), batchSize)) {
        counts.read += batch.length
        const rows: Row[] = []
        for (const value of batch) {
          try {
            const row = sourceRow(table, value as Row)
            rows.push(row)
          } catch { counts.skipped++ }
        }
        // Reuse an already migrated employee's ID even if the two writers created different UUIDs.
        if (table === 'users' && rows.length) {
          const keys = rows.map(row => rowKey('user_identities', row))
          const identities = new Map((await target.rows('user_identities', { keys })).map(row => [rowKey('user_identities', row), String(row.user_id)]))
          for (const row of rows) {
            const sourceId = String(row.id), id = identities.get(rowKey('user_identities', row)) ?? sourceId
            // Most migrated IDs already match; only retain actual remaps across batches.
            if (sourceId !== id) mapping.set(sourceId, id)
            row.id = id
          }
        } else for (const row of rows) if (row.user_id !== null && row.user_id !== undefined) row.user_id = mapping.get(String(row.user_id)) ?? row.user_id
        const old = new Map((await target.rows(table, { keys: rows.map(row => rowKey(table, row)) })).map(row => [rowKey(table, row), row]))
        // Orphan runtime rows are not useful without their corresponding facts.
        const facts = table === 'runtime_facts' ? new Set((await target.rows('activity_facts', { keys: rows.map(row => rowKey('activity_facts', row)) })).map(row => rowKey('activity_facts', row))) : undefined
        const changes: Change[] = []
        for (let row of rows) {
          const key = rowKey(table, row), previous = old.get(key)
          if (facts && !facts.has(key)) { counts.skipped++; continue }
          if (table === 'users' && previous) {
            const newer = String(previous.profile_updated_at ?? '') > String(row.profile_updated_at ?? '')
            if (newer) row = { ...row, display_name: previous.display_name!, chinese_name: previous.chinese_name!, department_name: previous.department_name!, dept_l1_name: previous.dept_l1_name!, dept_name: previous.dept_name!, profile_updated_at: previous.profile_updated_at! }
          }
          if (previous && canonical(previous) === canonical(row)) { counts.unchanged++; continue }
          changes.push({ table, key, row })
        }
        await target.commit(changes)
        counts.written += changes.length
        options.progress?.({ ...counts })
      }
      options.progress?.({ ...counts })
    }
    source.exec('COMMIT')
    return report
  } finally { source.close() }
}
