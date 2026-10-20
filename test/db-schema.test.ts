import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CURRENT_MIGRATIONS, MIGRATIONS, migrationStatements } from '../server/tracking/clickhouse-migrations.js'
import { TABLES, TABLE_META } from '../server/tracking/canonical.js'
import { EXPECTED_COLUMNS } from '../server/tracking/clickhouse-schema.js'

const database = 'website_test_schema'
test('typed schema contains precisely the original ten business tables and current views', () => {
  const snapshot = readFileSync(new URL('../db/clickhouse/schema.sql', import.meta.url), 'utf8').replaceAll('{{database}}', `\`${database}\``).split(';').map(sql => sql.trim()).filter(Boolean)
  assert.deepEqual(snapshot, CURRENT_MIGRATIONS.flatMap(name => migrationStatements(name, database)))
  assert.equal(EXPECTED_COLUMNS.length, 76)
  assert.equal(TABLES.length, 10)
  for (const table of TABLES) assert.deepEqual(EXPECTED_COLUMNS.filter(column => column.table === table).map(column => column.name), TABLE_META[table].columns)
  assert.equal(snapshot.filter(sql => sql.includes('CREATE TABLE')).length, 10)
  assert.equal(snapshot.filter(sql => sql.includes('CREATE VIEW')).length, 10)
  assert.doesNotMatch(snapshot.join('\n'), /physical_delete_at|commit_seq|source_epoch|CREATE TABLE[^;]+user_day|PARTITION BY| TTL /)
  assert.equal(MIGRATIONS.length, 3) // Retain the two historical source definitions.
  const sqlOnly = (sql: string) => sql.replace(/^--.*$/gm, '').replace(/\s+/g, ' ').trim()
  const reviewed = ['schema.sql', 'views.sql'].map(file => readFileSync(new URL(`../docs/design/tracking-v2/${file}`, import.meta.url), 'utf8')).join('\n')
  assert.equal(sqlOnly(readFileSync(new URL('../db/clickhouse/schema.sql', import.meta.url), 'utf8')), sqlOnly(reviewed))
})
test('migration loading rejects unsafe database names and unknown migrations', () => {
  for (const database of ['', 'db; DROP DATABASE db', 'db`', '../db']) assert.throws(() => migrationStatements(CURRENT_MIGRATIONS[0], database), /INVALID_CLICKHOUSE_IDENTIFIER/)
  assert.throws(() => migrationStatements('../secret' as typeof MIGRATIONS[number], database), /UNKNOWN_CLICKHOUSE_MIGRATION/)
})
