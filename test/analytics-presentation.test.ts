import test from 'node:test'
import assert from 'node:assert/strict'
import { columnsFor, defaultColumns, restoreColumns } from '../client/analytics/presentation.js'
import { userSortKeys } from '../shared/analytics.js'

test('department is visible for personal tables without changing supported sort keys', () => {
  for (const view of ['users', 'rankings', 'operations'] as const) {
    assert.ok(defaultColumns(view).includes('deptName'))
    assert.equal(columnsFor(view).find(column => column.key === 'deptName')?.numeric, false)
  }
  assert.equal((userSortKeys as readonly string[]).includes('deptName'), false)
})

test('column upgrade preserves prior choices and adds department only once', () => {
  assert.deepEqual(restoreColumns('users', ['displayName', 'totalTokens', 'unknown'], true), ['displayName', 'deptName', 'totalTokens'])
  assert.deepEqual(restoreColumns('users', ['displayName', 'totalTokens']), ['displayName', 'totalTokens'])
  assert.deepEqual(restoreColumns('operations', ['displayName', 'feature'], true), ['occurredAt', 'displayName', 'deptName', 'feature'])
  assert.equal(restoreColumns('users', null, true), undefined)
})
