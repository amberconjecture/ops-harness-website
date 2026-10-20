import { readFileSync } from 'node:fs'
import { identifier } from './clickhouse-schema.js'

export const MIGRATIONS = ['0001_tracking_baseline', '0002_tracking_retention', '0003_tracking_typed'] as const

export const CURRENT_MIGRATIONS = ['0003_tracking_typed'] as const

/** Repository SQL uses one statement per semicolon; no semicolons inside literals/comments. */
export function migrationStatements(name: typeof MIGRATIONS[number], database: string): string[] {
  const target = identifier(database)
  if (!MIGRATIONS.includes(name)) throw new Error('UNKNOWN_CLICKHOUSE_MIGRATION')
  const source = readFileSync(new URL(`../../db/clickhouse/migrations/${name}.sql`, import.meta.url), 'utf8')
  return source.replaceAll('{{database}}', target).split(';').map(sql => sql.trim()).filter(Boolean)
}
