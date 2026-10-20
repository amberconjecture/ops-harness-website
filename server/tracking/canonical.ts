import { createHash } from 'node:crypto'

export type Row = Record<string, string | number | null>
const definition = (columns: string, primaryKey: string) => ({ columns: columns.split(','), primaryKey: primaryKey.split(','), pk: primaryKey.split(',') })
export const TABLE_META = {
  users: definition('id,tenant,issuer,subject,display_name,chinese_name,department_name,dept_l1_name,dept_name,profile_updated_at', 'id'),
  user_identities: definition('tenant,issuer,subject,user_id', 'tenant,issuer,subject'),
  installations: definition('tenant,installation,environment,last_seen', 'tenant,installation'),
  identity_sessions: definition('ref,tenant,installation,user_id,valid_from,expires_at', 'ref'),
  event_dedup: definition('tenant,id,digest,received_at', 'tenant,id'),
  operations: definition('tenant,installation,operation,accepted,terminal,terminal_digest', 'tenant,installation,operation'),
  activity_facts: definition('tenant,id,user_id,installation,day,occurred_at,environment,platform,app_version,feature,action,event_name,initiator,interaction,operation,outcome,active,success,pending', 'tenant,id'),
  runtime_facts: definition('tenant,id,conversation,turn,step,session_kind,provider,model,usage_reported,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,skill_name,method,result', 'tenant,id'),
  tracking_events: definition('tenant,id,body,received_at', 'tenant,id'),
  ingestion_health: definition('code,count', 'code'),
} as const
export type TableName = keyof typeof TABLE_META
export const TABLES = Object.keys(TABLE_META) as TableName[]
export const tableNames = TABLES
export type State = Record<TableName, Row[]>
export type Change = { table: TableName; key: string; row: Row | null }
export type Changeset = { epoch: string; seq: number; createdAt: string; changes: Change[]; hash: string }

/** Preserve the existing event digest ordering; persisted digests must not change. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  const result = JSON.stringify(value)
  if (result === undefined) throw new Error('INVALID_CANONICAL_VALUE')
  return result
}
export const hashCanonical = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
export function rowKey(table: TableName, row: Row): string {
  const values = TABLE_META[table].primaryKey.map(column => {
    const value = row[column]
    if (value === undefined || value === null) throw new Error('INVALID_TRACKING_PRIMARY_KEY')
    return value
  })
  return JSON.stringify(values)
}
export function emptyState(): State { return Object.fromEntries(TABLES.map(table => [table, [] as Row[]])) as State }
export function normalizeRow(table: TableName, row: Row): Row {
  if (Object.keys(row).some(column => !TABLE_META[table].columns.includes(column))) throw new Error('UNKNOWN_TRACKING_COLUMN')
  const result: Row = {}
  for (const column of TABLE_META[table].columns) {
    const value = row[column]
    if (value === undefined || (value !== null && typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'number' && !Number.isSafeInteger(value))) throw new Error('INVALID_TRACKING_ROW')
    result[column] = value
  }
  rowKey(table, result)
  return result
}
export function applyChanges(state: State, changes: readonly Change[]): State {
  const result = emptyState()
  for (const table of TABLES) {
    const rows = new Map(state[table].map(row => [rowKey(table, row), { ...row }]))
    for (const change of changes) {
      if (change.table !== table) continue
      if (change.row === null) rows.delete(change.key)
      else {
        const row = normalizeRow(table, change.row)
        if (rowKey(table, row) !== change.key) throw new Error('TRACKING_KEY_MISMATCH')
        rows.set(change.key, row)
      }
    }
    result[table] = [...rows.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row]) => row)
  }
  return result
}
export function makeChangeset(epoch: string, seq: number, createdAt: string, changes: readonly Change[]): Changeset {
  if (!Number.isSafeInteger(seq) || seq < 0 || !Number.isFinite(Date.parse(createdAt))) throw new Error('INVALID_CHANGESET_METADATA')
  const ordered = [...changes].sort((a, b) => a.table < b.table ? -1 : a.table > b.table ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  const seen = new Set<string>()
  for (const change of ordered) {
    const key = `${change.table}:${change.key}`
    if (seen.has(key) || !TABLES.includes(change.table)) throw new Error('DUPLICATE_CHANGESET_KEY')
    seen.add(key)
    if (change.row && rowKey(change.table, normalizeRow(change.table, change.row)) !== change.key) throw new Error('TRACKING_KEY_MISMATCH')
  }
  const body = { epoch, seq, createdAt, changes: ordered }
  return { ...body, hash: hashCanonical(body) }
}
