import { TABLE_META, TABLES, normalizeRow, type Row, type TableName } from './canonical.js'
import { readFileSync } from 'node:fs'

/** Used only by the offline legacy importer; never used by online reads/writes. */
export const ENTITY_TABLES: Record<TableName, string> = {
  installations: 'installation_versions', users: 'user_versions', user_identities: 'user_identity_versions',
  identity_sessions: 'identity_session_versions', event_dedup: 'event_dedup_versions', tracking_events: 'tracking_event_versions',
  operations: 'operation_versions', activity_facts: 'activity_fact_versions', runtime_facts: 'runtime_fact_versions',
  ingestion_health: 'ingestion_health_versions',
}
export function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) throw new Error('INVALID_CLICKHOUSE_IDENTIFIER')
  return `\`${value}\``
}
export function qualified(database: string, table: string) { return `${identifier(database)}.${identifier(table)}` }
export const INTEGER_COLUMNS = new Set(['turn', 'step', 'usage_reported', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'active', 'success', 'pending', 'count'])
// Legacy fixture / SQLite profile defaults; actual nullability is determined per table's key below.
export const NULLABLE_COLUMNS = new Set(['user_id', 'accepted', 'terminal', 'terminal_digest', 'chinese_name', 'department_name', 'dept_l1_name', 'dept_name', 'profile_updated_at'])
export const TIME_COLUMNS = new Set(['profile_updated_at', 'last_seen', 'valid_from', 'expires_at', 'received_at', 'occurred_at'])
const source = readFileSync(new URL('../../db/clickhouse/schema.sql', import.meta.url), 'utf8')
export const EXPECTED_COLUMNS = TABLES.flatMap(table => {
  const definition = source.match(new RegExp(`CREATE TABLE IF NOT EXISTS \\{\\{database\\}\\}\\.${table} \\(([\\s\\S]+?)\\n\\) ENGINE`))?.[1]
  if (!definition) throw new Error('INVALID_TRACKING_SCHEMA_ASSET')
  const columns = [...definition.matchAll(/^    (\w+) (.+?) COMMENT /gm)].map(match => ({ table, name: match[1]!, type: match[2]! }))
  if (columns.map(column => column.name).join(',') !== TABLE_META[table].columns.join(',')) throw new Error('INVALID_TRACKING_SCHEMA_ASSET')
  return columns
})

export function typedRow(table: TableName, input: Row): Row {
  const row = normalizeRow(table, input)
  for (const [column, value] of Object.entries(row)) {
    if (value === null) continue
    if (INTEGER_COLUMNS.has(column)) {
      if (!/^-?\d+$/.test(String(value))) throw new Error('ANALYTICS_INVALID_INTEGER')
      const exact = BigInt(value)
      if (exact < -(1n << 63n) || exact >= (1n << 63n)) throw new Error('ANALYTICS_INTEGER_OVERFLOW')
      row[column] = exact >= BigInt(Number.MIN_SAFE_INTEGER) && exact <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(exact) : String(exact)
    } else {
      if (typeof value !== 'string') throw new Error('INVALID_TRACKING_ROW')
      if (TIME_COLUMNS.has(column)) {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || /\.\d{3}\d*[1-9]\d*(?:Z|[+-])/.test(value)) throw new Error('INVALID_TRACKING_TIME')
        if (new Date(`${value.slice(0,10)}T00:00:00Z`).toISOString().slice(0,10) !== value.slice(0,10)) throw new Error('INVALID_TRACKING_TIME')
        const time = Date.parse(value)
        if (!Number.isFinite(time) || time < Date.parse('1900-01-01T00:00:00Z') || time >= Date.parse('2300-01-01T00:00:00Z')) throw new Error('INVALID_TRACKING_TIME')
        row[column] = new Date(time).toISOString()
      }
      if (column === 'day' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1970-01-01' || value > '2149-06-06' || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) throw new Error('INVALID_TRACKING_DAY')
    }
  }
  for (const column of table === 'operations' ? ['accepted','terminal'] : table === 'tracking_events' ? ['body'] : []) {
    if (row[column] === null) continue
    let json: unknown
    try { json = JSON.parse(String(row[column])) } catch { throw new Error('INVALID_TRACKING_JSON') }
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('INVALID_TRACKING_JSON')
    if (table === 'operations' && (typeof (json as { occurredAt?: unknown }).occurredAt !== 'string' || !Number.isFinite(Date.parse((json as { occurredAt: string }).occurredAt)))) throw new Error('INVALID_TRACKING_OPERATION_TIME')
  }
  return row
}
/** Composite keys use aligned parameter arrays, so each tuple is matched exactly. */
export function keyFilter(table: TableName, keys: string[], prefix = 'keys') {
  const columns = TABLE_META[table].primaryKey
  const tuples: unknown[] = keys.map(key => JSON.parse(key))
  if (tuples.some(tuple => !Array.isArray(tuple) || tuple.length !== columns.length || tuple.some(value => typeof value !== 'string'))) throw new Error('INVALID_TRACKING_PRIMARY_KEY')
  const params = Object.fromEntries(columns.map((_, i) => [`${prefix}${i}`, tuples.map(tuple => (tuple as string[])[i]!)]))
  const args = columns.map((_, i) => `{${prefix}${i}:Array(String)}`).join(',')
  return { predicate: columns.length === 1 ? `${identifier(columns[0]!)} IN ${args}` : `(${columns.map(identifier).join(',')}) IN arrayZip(${args})`, params }
}
