import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { TrackingDatabase, dayAt, type Installation, type AnalyticsQuery } from '../server/tracking/database.js'
import { TrackingStore } from '../server/tracking/store.js'
import type { TrackingEvent } from '@dsh-ops/tracking-contract'
const now = Date.parse('2026-09-20T06:00:00.000Z')
const installation = (): Installation => ({ tenantId: 'company', installationId: randomUUID(), environment: 'test' })
function event(i: Installation, extra: Partial<TrackingEvent> = {}): TrackingEvent {
  return { schemaVersion: 1, eventVersion: 1, eventId: randomUUID(), eventName: 'operation.accepted', module: 'tool-market', feature: 'tools', action: 'tool.add', occurredAt: new Date(now).toISOString(), installationId: i.installationId, runtimeId: randomUUID(), sequence: 1, initiator: 'user', interactionId: randomUUID(), operationId: randomUUID(), platform: 'darwin', appVersion: '0.1.0', environment: 'test', properties: {}, ...extra }
}
const q: AnalyticsQuery = { from: '2026-09-01', to: '2026-09-20', environment: 'test', offset: 0, limit: 50 }
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'website-tracking-'))
  let time = now - 31 * 86400000
  const db = new TrackingDatabase(root, () => time)
  return { db, root, setTime: (value: number) => { time = value }, close: async () => { db.close(); await rm(root, { recursive: true, force: true }) } }
}
test('same SSO person across installations counts once; retries and aggregate reruns are idempotent', async () => {
  const f = await fixture()
  try {
    const a = installation(), b = installation()
    f.setTime(now - 1000)
    const principal = { issuer: 'company-sso', subject: 'employee-1', displayName: '测试用户', expiresAt: now + 3600000 }
    const sa = f.db.identity(a, principal), sb = f.db.identity(b, principal)
    f.setTime(now)
    const ea = event(a, { identityRef: sa.identityRef }), eb = event(b, { identityRef: sb.identityRef, platform: 'win32' })
    assert.equal(f.db.ingest(a, [ea]).acceptedIds.length, 1)
    assert.equal(f.db.ingest(a, [ea]).duplicateIds.length, 1)
    f.db.ingest(b, [eb])
    const overview = f.db.query('overview', q) as any
    assert.equal(overview.dau, 1); assert.equal(overview.mau, 1); assert.equal(overview.interactions, 2)
    assert.equal((f.db.query('users', q) as any).rows.length, 1)
    assert.equal((f.db.query('overview', { ...q, platform: 'win32' }) as any).dau, 1)
  } finally { await f.close() }
})
test('anonymous and scheduled events never inflate DAU; pending terminal resolves to original identity', async () => {
  const f = await fixture()
  try {
    const i = installation(); f.setTime(now - 1000)
    const session = f.db.identity(i, { issuer: 'company-sso', subject: 'a', displayName: 'A', expiresAt: now + 1 })
    const accepted = event(i, { identityRef: session.identityRef })
    const terminal = { ...accepted, eventId: randomUUID(), eventName: 'operation.finished' as const, occurredAt: new Date(now + 10000).toISOString(), outcome: 'succeeded' as const, changed: true }
    f.setTime(now + 20000)
    f.db.ingest(i, [terminal, event(i), event(i, { identityRef: session.identityRef, initiator: 'scheduler' })])
    assert.equal((f.db.query('overview', q) as any).dau, 0)
    assert.equal((f.db.query('overview', q) as any).successes, 0)
    f.db.ingest(i, [accepted])
    assert.equal((f.db.query('overview', q) as any).dau, 1)
    assert.equal((f.db.query('overview', q) as any).successes, 1)
    const again = { ...terminal, eventId: randomUUID() }
    assert.equal(f.db.ingest(i, [again]).duplicateIds.length, 1)
  } finally { await f.close() }
})
test('rejects forged identity, event conflict, wrong installation and unapproved properties', async () => {
  const f = await fixture()
  try {
    f.setTime(now); const i = installation(), e = event(i)
    f.db.ingest(i, [e])
    assert.equal(f.db.ingest(i, [{ ...e, initiator: 'system' }]).rejected[0]?.code, 'EVENT_CONFLICT')
    assert.equal(f.db.ingest(i, [event(i, { identityRef: randomUUID() })]).rejected[0]?.code, 'IDENTITY_UNKNOWN')
    assert.equal(f.db.ingest(i, [event(installation())]).rejected[0]?.code, 'INSTALLATION_MISMATCH')
    assert.equal(f.db.ingest(i, [event(i, { properties: { token: 'sensitive' } })]).rejected[0]?.code, 'INVALID_EVENT')
    assert.equal(f.db.ingest(i, [event(i, { occurredAt: new Date(now - 31 * 86400000).toISOString() })]).rejected[0]?.code, 'EVENT_TIME_OUT_OF_RANGE')
  } finally { await f.close() }
})
test('failed accepted actions count as active; next-day completion does not create new DAU', async () => {
  const f = await fixture()
  try {
    const i = installation(); f.setTime(now - 1000)
    const session = f.db.identity(i, { issuer: 'company-sso', subject: 'a', displayName: '', expiresAt: now + 1000 })
    const e = event(i, { identityRef: session.identityRef })
    f.setTime(now); f.db.ingest(i, [e]); f.setTime(now + 86400000)
    f.db.ingest(i, [{ ...e, eventId: randomUUID(), eventName: 'operation.finished', outcome: 'failed', occurredAt: new Date(now + 86400000).toISOString() }])
    assert.equal((f.db.query('overview', q) as any).dau, 1)
    assert.equal((f.db.query('overview', { ...q, to: '2026-09-21' }) as any).dau, 0)
    assert.equal(dayAt(Date.parse('2026-09-20T16:00:00Z')), '2026-09-21')
  } finally { await f.close() }
})
test('worker executes durable queries outside the HTTP event loop and closes cleanly', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-worker-'))
  const worker = new TrackingStore(root)
  try { const result = await worker.query('health', q); assert.equal(result.installations, 0); await worker.maintain() }
  finally { await worker.close(); await rm(root, { recursive: true, force: true }) }
})
