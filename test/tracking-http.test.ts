import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { TrackingStore } from '../server/tracking/store.js'
import { createTrackingHandlers } from '../server/tracking/http.js'
import { createGuideHandler } from '../server/guide-http.js'
import { GuideStore } from '../server/guide-store.js'

async function fixture(t: TestContext, enabled: boolean, defaultEnvironment: 'development' | 'production' = 'development', remoteAddress?: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-http-'))
  const store = new TrackingStore(path.join(root, 'analytics'))
  const tracking = createTrackingHandlers(store, { enabled, defaultEnvironment })
  let origin = ''
  let guide: Awaited<ReturnType<typeof createGuideHandler>>
  const server = createServer(async (req, res) => {
    // Exercise receiver policy deterministically without a routable test NIC.
    if (remoteAddress) Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress, configurable: true })
    const url = new URL(req.url!, origin)
    if (await tracking.collect(req, res, url) || await guide(req, res, url)) return
    res.writeHead(404); res.end()
  })
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await store.close(); await rm(root, { recursive: true, force: true }) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  guide = await createGuideHandler(new GuideStore(path.resolve('content/guide'), path.join(root, 'content')), { origin, password: 'test-admin-password-only', admin: tracking.admin })
  const post = (pathname: string, data: unknown, headers = {}) => fetch(origin + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) })
  const installationId = randomUUID()
  const event = { schemaVersion: 1, eventVersion: 1, eventId: randomUUID(), eventName: 'operation.accepted', module: 'tools', feature: 'tools', action: 'tool.add', occurredAt: new Date().toISOString(), installationId, runtimeId: randomUUID(), sequence: 1, initiator: 'user', interactionId: randomUUID(), operationId: randomUUID(), platform: 'darwin', appVersion: '0.1.0', environment: 'development', properties: {} }
  const batch = { schemaVersion: 1, installationId, environment: 'development', events: [event] }
  return { origin, post, batch, event }
}

test('explicit deployment collection accepts remote production events without dev mode or credentials', async t => {
  const { origin, post, batch, event } = await fixture(t, true, 'production', '192.0.2.20')
  const production = { ...event, environment: 'production', employee: { source: 'welink', employeeId: 'qa-production' } }
  const upload = { ...batch, environment: 'production', events: [production] }
  const endpoint = '/api/tracking/v1/events:batch'
  assert.deepEqual((await (await post(endpoint, upload)).json() as any).acceptedIds, [event.eventId])
  assert.deepEqual((await (await post(endpoint, upload)).json() as any).duplicateIds, [event.eventId])
  assert.equal((await post(endpoint, upload, { Origin: origin })).status, 403)
  assert.equal((await fetch(origin + '/api/admin/analytics/overview')).status, 401)
  const login = await post('/api/admin/login', { password: 'test-admin-password-only' }, { Origin: origin })
  const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]! }
  assert.deepEqual(await (await fetch(origin + '/api/admin/analytics/context', { headers })).json(), { defaultEnvironment: 'production' })
  const overview = await (await fetch(origin + '/api/admin/analytics/overview', { headers })).json() as any
  assert.equal(overview.dau, 1); assert.equal(overview.loginUsers, 1)
  const users = await (await fetch(origin + '/api/admin/analytics/users', { headers })).json() as any
  assert.equal(users.total, 1); assert.equal(users.rows[0].account, 'qa-production')
  const searched=await (await fetch(origin+'/api/admin/analytics/users?search=QA-PROD&sort=interactions&direction=asc&limit=1',{headers})).json() as any
  assert.equal(searched.total,1);assert.equal(searched.rows[0].account,'qa-production')
  for(const query of ['sort=arbitrary','direction=sideways','search='+encodeURIComponent('x'.repeat(81)),'sort=activeDays&sort=lastSeen'])assert.equal((await fetch(origin+'/api/admin/analytics/users?'+query,{headers})).status,400)
  assert.equal((await fetch(origin+'/api/admin/analytics/rankings?sort=totalTokens',{headers})).status,400)
  assert.equal((await fetch(origin+'/api/admin/analytics/overview?search=ignored',{headers})).status,400)
})

test('collection is controlled only by enabled regardless of the default analytics environment', async t => {
  for (const environment of ['development', 'production'] as const) {
    const disabled = await fixture(t, false, environment)
    const denied = await disabled.post('/api/tracking/v1/events:batch', disabled.batch)
    assert.equal(denied.status, 503)
    assert.deepEqual(await denied.json(), { error: 'TRACKING_NOT_ENABLED' })
    const enabled = await fixture(t, true, environment, '192.0.2.20')
    assert.equal((await enabled.post('/api/tracking/v1/events:batch', enabled.batch)).status, 200)
  }
})

test('local development collects without credentials, deduplicates and preserves admin authentication', async t => {
  const { origin, post, batch, event } = await fixture(t, true)
  const accepted = await post('/api/tracking/v1/events:batch', batch)
  assert.equal(accepted.status, 200)
  assert.deepEqual((await accepted.json() as any).acceptedIds, [event.eventId])
  assert.deepEqual((await (await post('/api/tracking/v1/events:batch', batch)).json() as any).duplicateIds, [event.eventId])
  assert.equal((await fetch(origin + '/api/admin/analytics/overview')).status, 401)
  assert.equal((await fetch(origin + '/api/admin/analytics/context')).status, 401)
  const login = await post('/api/admin/login', { password: 'test-admin-password-only' }, { Origin: origin })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const headers = { Cookie: cookie }
  assert.deepEqual(await (await fetch(origin + '/api/admin/analytics/context', { headers })).json(), { defaultEnvironment: 'development' })
  const defaultHealth = await (await fetch(origin + '/api/admin/analytics/health', { headers })).json() as any
  assert.equal(defaultHealth.collected, 1)
  const productionHealth = await (await fetch(origin + '/api/admin/analytics/health?environment=production', { headers })).json() as any
  assert.equal(productionHealth.collected, 0)
  const allHealth = await (await fetch(origin + '/api/admin/analytics/health?environment=all', { headers })).json() as any
  assert.equal(allHealth.collected, 1)
  assert.equal((await fetch(origin + '/api/admin/analytics/health?environment=invalid', { headers })).status, 400)
  const overview = await fetch(origin + '/api/admin/analytics/overview?environment=development', { headers })
  assert.equal(overview.status, 200)
  const data = await overview.json() as any
  assert.equal(data.dau, 0); assert.equal(data.mau, 0); assert.equal(data.loginUsers, 0)
  const health = await (await fetch(origin + '/api/admin/analytics/health?environment=development', { headers })).json() as any
  assert.equal(health.collected, 1); assert.equal(health.anonymousEvents, 1); assert.equal(health.identifiedEvents, 0)
  assert.equal((await fetch(origin + '/api/admin/analytics/overview?from=not-a-date', { headers })).status, 400)
  for (const kind of ['conversations', 'skills']) {
    assert.equal((await fetch(origin + '/api/admin/analytics/' + kind)).status, 401)
    const response = await fetch(origin + '/api/admin/analytics/' + kind + '?environment=development', { headers })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json() as any).rows, [])
  }
})

test('development HTTP attributes the current Host employee across environments without requiring SSO', async t => {
  const { origin, post, batch, event } = await fixture(t, true)
  const employee = { source: 'welink', employeeId: 'qa123' }
  const first = await post('/api/tracking/v1/events:batch', { ...batch, events: [{ ...event, employee }] })
  assert.deepEqual((await first.json() as any).acceptedIds, [event.eventId])
  const second = { ...event, eventId: randomUUID(), operationId: randomUUID(), interactionId: randomUUID(), environment: 'test', employee, platform: 'win32' }
  assert.equal((await post('/api/tracking/v1/events:batch', { ...batch, environment: 'test', events: [second] })).status, 200)
  assert.equal((await post('/api/tracking/v1/events:batch', { ...batch, environment: 'all' })).status, 400)
  const login = await post('/api/admin/login', { password: 'test-admin-password-only' }, { Origin: origin })
  const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]! }
  const users = await (await fetch(origin + '/api/admin/analytics/users?environment=all', { headers })).json() as any
  assert.equal(users.total, 1); assert.equal(users.rows[0].account, 'qa123'); assert.equal(users.rows[0].interactions, 2)
  const overview = await (await fetch(origin + '/api/admin/analytics/overview?environment=all', { headers })).json() as any
  assert.equal(overview.dau, 1); assert.equal(overview.loginUsers, 1)
})

test('collection validates installation/environment and rejects browser requests', async t => {
  const { origin, post, batch, event } = await fixture(t, true)
  const endpoint = '/api/tracking/v1/events:batch'
  assert.equal((await post(endpoint, batch, { Origin: origin })).status, 403)
  assert.equal((await post(endpoint, batch, { 'Sec-Fetch-Site': 'same-origin' })).status, 403)
  assert.equal((await post(endpoint, { ...batch, installationId: undefined })).status, 400)
  assert.equal((await post(endpoint, { ...batch, events: [event, event] })).status, 400)
  const production = { ...event, eventId: randomUUID(), operationId: randomUUID(), interactionId: randomUUID(), environment: 'production' }
  assert.deepEqual((await (await post(endpoint, { ...batch, environment: 'production', events: [production] })).json() as any).acceptedIds, [production.eventId])
  for (const different of [{ installationId: randomUUID() }, { environment: 'test' }]) {
    const response = await post(endpoint, { ...batch, events: [{ ...event, ...different }] })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json() as any).rejected, [{ id: event.eventId, code: 'INSTALLATION_MISMATCH', retryable: false }])
  }
  assert.deepEqual((await (await post(endpoint, { ...batch, environment: 'test', events: [{ ...event, environment: 'test' }] })).json() as any).acceptedIds, [event.eventId])
  const identity = await post('/api/tracking/v1/identity-sessions', { proof: 'not-a-real-proof' })
  assert.equal(identity.status, 503); assert.deepEqual(await identity.json(), { error: 'IDENTITY_NOT_CONFIGURED' })
})

test('employee details travel through collection to authenticated personal views, with bounded fields', async t => {
  const { origin, post, batch, event } = await fixture(t, true)
  const employee = { source: 'welink', employeeId: 'qa-profile', chineseName: '官网验收同事', departmentName: '示例集团 / 数字业务部 / 体验组', deptL1Name: '数字业务部', deptName: '体验组', profileUpdatedAt: new Date().toISOString() }
  const endpoint = '/api/tracking/v1/events:batch'
  assert.deepEqual((await (await post(endpoint, { ...batch, events: [{ ...event, employee }] })).json() as any).acceptedIds, [event.eventId])
  const invalid = { ...event, eventId: randomUUID(), operationId: randomUUID(), employee: { ...employee, departmentName: 'x'.repeat(1025) } }
  assert.deepEqual((await (await post(endpoint, { ...batch, events: [invalid] })).json() as any).rejected, [{ id: invalid.eventId, code: 'INVALID_EVENT', retryable: false }])
  const login = await post('/api/admin/login', { password: 'test-admin-password-only' }, { Origin: origin })
  const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]! }
  let userId = ''
  for (const kind of ['users', 'rankings', 'operations']) {
    const result = await (await fetch(`${origin}/api/admin/analytics/${kind}`, { headers })).json() as any
    const row = result.rows[0]
    userId = row.userId
    assert.equal(row.displayName, employee.chineseName); assert.equal(row.account, employee.employeeId)
    for (const key of ['chineseName', 'departmentName', 'deptL1Name', 'deptName', 'profileUpdatedAt'] as const) assert.equal(row[key], employee[key])
  }
  const detail = await (await fetch(`${origin}/api/admin/analytics/users/${userId}`, { headers })).json() as any
  assert.equal(detail.rows[0].deptL1Name, employee.deptL1Name)
  assert.equal((await fetch(`${origin}/api/admin/analytics/users?sort=deptName`, { headers })).status, 400)
})

test('disabled collection still allows authenticated analytics queries with their configured default', async t => {
  const { origin, post, batch } = await fixture(t, false, 'production')
  const response = await post('/api/tracking/v1/events:batch', batch)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'TRACKING_NOT_ENABLED' })
  const login = await post('/api/admin/login', { password: 'test-admin-password-only' }, { Origin: origin })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  assert.deepEqual(await (await fetch(origin + '/api/admin/analytics/context', { headers: { Cookie: cookie } })).json(), { defaultEnvironment: 'production' })
})
