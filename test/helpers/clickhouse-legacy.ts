import { readFileSync } from 'node:fs'
import { identifier } from '../../server/tracking/clickhouse-schema.js'

/** Test-only source schema for legacy-to-typed migration coverage. */
export function legacySchemaStatements(database: string): string[] {
  const target = identifier(database)
  const source = readFileSync(new URL('../fixtures/clickhouse-legacy-schema.sql', import.meta.url), 'utf8')
  return source.replaceAll('{{database}}', target).split(';').map(sql => sql.trim()).filter(Boolean)
}
