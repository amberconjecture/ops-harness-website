// Runs the actual pre-ClickHouse SQLite implementation against synthetic local data.
// Never reads website.json, a production database, or any external runtime directory.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const revision = 'da75d733891a38ed936aa182f37e91aa734cb291'
const historical = file => execFileSync('git', ['show', `${revision}:${file}`], { cwd: root, encoding: 'utf8' })
const source = historical('server/tracking/database.ts')
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
let assertions = 0
const equal = (actual, expected) => { assert.deepEqual(actual, expected); assertions++ }
const runtime = join(root, '.runtime')
mkdirSync(runtime, { recursive: true })
const directory = mkdtempSync(join(runtime, 'sqlite-user-day-review-'))
let db, inspect
try {
  // The contract artifact has not changed since the historical revision.
  equal(historical('vendor/tracking.json'), execFileSync('git', ['show', 'HEAD:vendor/tracking.json'], { cwd: root, encoding: 'utf8' }))
  writeFileSync(join(directory, 'analytics.mjs'), compile(historical('shared/analytics.ts')), { mode: 0o600 })
  writeFileSync(join(directory, 'database.mjs'), compile(source).replace('../../shared/analytics.js', './analytics.mjs'), { mode: 0o600 })
  const { TrackingDatabase } = await import(pathToFileURL(join(directory, 'database.mjs')).href)
  const now = Date.parse('2026-10-19T06:00:00.000Z')
  db = new TrackingDatabase(join(directory, 'data'), () => now)
  inspect = new DatabaseSync(join(directory, 'data', 'analytics.sqlite'))
  const install = environment => ({ tenantId: 'fixture', installationId: randomUUID(), environment })
  const a = install('development'), b = install('test')
  const event = (installation, employeeId, extra = {}) => ({
    schemaVersion: 1, eventVersion: 1, eventId: randomUUID(), eventName: 'operation.accepted',
    module: 'tool-market', feature: 'tools', action: 'tool.add', occurredAt: new Date(now).toISOString(),
    installationId: installation.installationId, runtimeId: randomUUID(), sequence: 1,
    initiator: 'user', interactionId: randomUUID(), operationId: randomUUID(), platform: 'darwin',
    appVersion: '0.1.0', environment: installation.environment, properties: {},
    ...(employeeId ? { employee: { source: 'welink', employeeId } } : {}), ...extra,
  })
  const send = (installation, events) => equal(db.ingest(installation, events).acceptedIds.length, events.length)
  const daily = () => inspect.prepare('SELECT * FROM user_day ORDER BY tenant,day,user_id,environment').all().map(row => ({ ...row }))
  const shared = event(a, 'shared')
  send(a, [shared, event(a, 'shared', { appVersion: '0.2.0' }), event(a), event(a, 'background', { initiator: 'scheduler' })])
  send(b, [event(b, 'shared', { platform: 'win32' })])
  const { action, operationId, ...page } = event(a, 'page-only')
  send(a, [{ ...page, eventName: 'page.view', properties: { pageKey: 'tool-market' } }])
  const sharedInteraction = randomUUID()
  send(a, [
    event(a, 'cross-day', { interactionId: sharedInteraction, occurredAt: '2026-10-18T06:00:00.000Z' }),
    event(a, 'cross-day', { interactionId: sharedInteraction }),
  ])
  const { action: ignoredAction, operationId: ignoredOperation, ...conversation } = event(a, 'conversation-user')
  const context = { conversationId: 'a'.repeat(64), turn: 1, sessionKind: 'root' }
  send(a, [
    { ...conversation, eventName: 'conversation.message.accepted', feature: 'conversation', properties: context },
    { ...conversation, eventId: randomUUID(), eventName: 'conversation.model.usage', feature: 'conversation', properties: { ...context, step: 1, provider: 'test', model: 'mock', usageReported: true, inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 0, reasoningTokens: 1 } },
    { ...conversation, eventId: randomUUID(), eventName: 'skill.load.completed', feature: 'skills', properties: { ...context, step: 1, skillName: 'fixture-skill', method: 'model', result: 'succeeded' } },
  ])
  const accepted = event(a, 'late', { occurredAt: '2026-10-18T06:00:00.000Z' })
  const terminal = { ...accepted, eventId: randomUUID(), eventName: 'operation.finished', outcome: 'succeeded', changed: true, occurredAt: '2026-10-19T05:00:00.000Z' }
  send(a, [terminal])
  const userId = subject => inspect.prepare('SELECT id FROM users WHERE subject=?').get(subject).id
  equal(inspect.prepare('SELECT count(*) AS n FROM user_day WHERE user_id=?').get(userId('late')).n, 0)
  send(a, [accepted])
  equal(inspect.prepare('SELECT day,active,successes FROM user_day WHERE user_id=? ORDER BY day').all(userId('late')).map(row => ({ ...row })), [
    { day: '2026-10-18', active: 1, successes: 0 }, { day: '2026-10-19', active: 0, successes: 1 },
  ])
  const beforeRetry = daily()
  equal(db.ingest(a, [shared]).duplicateIds, [shared.eventId])
  equal(daily(), beforeRetry)

  const q = { from: '2026-10-18', to: '2026-10-19', environment: 'all', offset: 0, limit: 50 }
  const sharedQuery = { ...q, from: q.to, userId: userId('shared') }
  equal(db.query('overview', sharedQuery).dau, 1)
  equal(inspect.prepare('SELECT count(*) AS n FROM user_day WHERE day=? AND user_id=? AND active=1').get(q.to, sharedQuery.userId).n, 2)
  equal(inspect.prepare('SELECT count(DISTINCT user_id) AS n FROM user_day WHERE day=? AND user_id=? AND active=1').get(q.to, sharedQuery.userId).n, 1)
  const pageQuery = { ...q, userId: userId('page-only') }
  equal(db.query('overview', pageQuery).loginUsers, 1)
  equal(inspect.prepare('SELECT logins,active FROM user_day WHERE user_id=?').get(pageQuery.userId), Object.assign(Object.create(null), { logins: 0, active: 0 }))
  equal(db.query('overview', { ...q, userId: userId('background') }).loginUsers, 0)
  equal(db.query('overview', { ...q, userId: userId('cross-day') }).interactions, 1)
  equal(inspect.prepare('SELECT sum(interactions) AS n FROM user_day WHERE user_id=?').get(userId('cross-day')).n, 2)

  const kinds = ['overview', 'trends', 'users', 'rankings', 'features', 'operations', 'health', 'conversations', 'skills']
  const filters = [q, { ...q, environment: 'development' }, { ...q, environment: 'test' }, { ...q, platform: 'win32' }, { ...q, appVersion: '0.2.0' }, sharedQuery]
  const capture = () => filters.flatMap(query => kinds.map(kind => ({ kind, result: db.query(kind, query) })))
  const baseline = capture()
  inspect.exec('DELETE FROM user_day')
  equal(daily(), [])
  capture().forEach((item, index) => equal(item, baseline[index]))
  inspect.exec('DROP TABLE user_day')
  capture().forEach((item, index) => equal(item, baseline[index]))

  // Removing the table without removing its write/maintenance hooks is invalid.
  const next = event(a, 'after-drop')
  assert.throws(() => db.ingest(a, [next]), /no such table: user_day/); assertions++
  equal(inspect.prepare('SELECT count(*) AS n FROM activity_facts WHERE id=?').get(next.eventId).n, 0)
  assert.throws(() => db.maintain(), /no such table: user_day/); assertions++
  console.log(`SQLite revision ${revision}: ${assertions} assertions passed.`)
  console.log('9 query kinds × 6 filter combinations unchanged after clearing AND dropping user_day.')
  console.log('Daily rebuild, late acceptance, retries, cross-environment distinct users and login-metric mismatch verified.')
  console.log('Unmodified historical ingestion/maintenance correctly fail after DROP; the table cannot be removed alone.')
} finally {
  try { inspect?.close() } finally {
    try { db?.close() } finally { rmSync(directory, { recursive: true, force: true }) }
  }
}
