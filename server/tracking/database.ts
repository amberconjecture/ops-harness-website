import { EventSchema } from '@dsh-ops/tracking-contract'
import { emptyState, rowKey, type Row } from './canonical.js'
import { ClickHouseBackend } from './clickhouse.js'
import { decideIdentity, decideIngest } from './decision.js'
import { acquireTrackingLock } from './lock.js'
import type { AnalyticsConfig } from './config.js'
import type { AnalyticsQuery, Installation, Principal } from './types.js'
export { dayAt, type AnalyticsQuery, type Installation, type Principal } from './types.js'

export class TrackingDatabase {
  readonly backend: ClickHouseBackend
  readonly ready: Promise<void>
  private tail: Promise<unknown> = Promise.resolve()
  private queued = 0
  private closing = false
  private readonly unlock: () => void
  constructor(directory: string, private readonly config: AnalyticsConfig, private readonly now = Date.now) {
    this.unlock = acquireTrackingLock(directory, 'clickhouse-writer')
    this.backend = new ClickHouseBackend(directory, config, now)
    this.ready = this.backend.open().catch(error => { this.backend.close(); this.unlock(); throw error })
    void this.ready.catch(() => {})
  }
  private exclusive<T>(work: () => Promise<T>, deadline = Date.now() + this.config.writeTimeoutMs): Promise<T> {
    if (this.closing || this.queued >= this.config.maxQueuedRequests) return Promise.reject(new Error('ANALYTICS_BUSY'))
    this.queued++
    const result = this.tail.then(async () => {
      if (Date.now() >= deadline) throw new Error('ANALYTICS_QUEUE_TIMEOUT')
      await this.ready
      await this.backend.recover()
      return work()
    })
    this.tail = result.catch(() => {}).finally(() => { this.queued-- })
    return result
  }
  ingest(installation: Installation, inputs: unknown[], deadline?: number) {
    return this.exclusive(async () => {
      await this.backend.beforeRequest(true)
      const at = this.now(), state = emptyState(), tenant = installation.tenantId
      const events = inputs.flatMap(input => { const parsed = EventSchema.safeParse(input); return parsed.success ? [parsed.data] : [] })
      const identities = events.flatMap(event => event.employee ? [{ tenant, issuer: event.employee.source, subject: event.employee.employeeId }] : [])
      const ids = events.map(event => rowKey('event_dedup', { tenant, id: event.eventId }))
      await Promise.all([
        this.backend.rows('installations', { keys: [rowKey('installations', { tenant, installation: installation.installationId })] }, at).then(rows => { state.installations = rows }),
        this.backend.rows('ingestion_health', {}, at).then(rows => { state.ingestion_health = rows }),
        this.backend.rows('event_dedup', { keys: ids }, at).then(rows => { state.event_dedup = rows }),
        this.backend.rows('identity_sessions', { keys: events.flatMap(event => event.identityRef ? [rowKey('identity_sessions', { ref: event.identityRef })] : []) }, at).then(rows => { state.identity_sessions = rows }),
        this.backend.rows('operations', { keys: events.flatMap(event => event.operationId ? [rowKey('operations', { tenant, installation: installation.installationId, operation: event.operationId })] : []) }, at).then(rows => { state.operations = rows }),
        this.backend.rows('user_identities', { keys: identities.map(identity => rowKey('user_identities', identity)) }, at).then(rows => { state.user_identities = rows }),
      ])
      const userIds = [...new Set([...state.identity_sessions, ...state.user_identities].map(row => String(row.user_id)))]
      const factIds = new Set(ids)
      for (const operation of state.operations) if (operation.terminal) factIds.add(rowKey('activity_facts', { tenant, id: String(JSON.parse(String(operation.terminal)).eventId) }))
      await Promise.all([
        this.backend.rows('users', { keys: userIds.map(id => rowKey('users', { id })) }, at).then(rows => { state.users = rows }),
        this.backend.rows('activity_facts', { keys: [...factIds] }, at).then(rows => { state.activity_facts = rows }),
      ])
      // Older imports can have a user without its identity lookup row.
      const missing = identities.filter(identity => !state.user_identities.some(row => rowKey('user_identities', row) === rowKey('user_identities', identity)))
      if (missing.length) {
        const recovered = await this.backend.rows('users', { predicate: 'tenant={tenant:String} AND subject IN {subjects:Array(String)}', params: { tenant, subjects: missing.map(row => row.subject) } }, at)
        const users = new Map<string, Row>(state.users.map(row => [String(row.id), row]))
        for (const row of recovered) users.set(String(row.id), row)
        state.users = [...users.values()]
      }
      const decision = decideIngest(state, installation, inputs, at)
      await this.backend.commit(decision.changes, decision.result)
      return decision.result
    }, deadline)
  }
  identity(installation: Installation, principal: Principal, deadline?: number) {
    return this.exclusive(async () => {
      await this.backend.beforeRequest(true)
      const at = this.now(), state = emptyState(), params = { tenant: installation.tenantId, issuer: principal.issuer, subject: principal.subject }
      const predicate = 'tenant={tenant:String} AND issuer={issuer:String} AND subject={subject:String}'
      ;[state.users, state.user_identities] = await Promise.all([
        this.backend.rows('users', { predicate, params }, at),
        this.backend.rows('user_identities', { keys: [rowKey('user_identities', params)] }, at),
      ])
      const decision = decideIdentity(state, installation, principal, at)
      await this.backend.commit(decision.changes, decision.result)
      return decision.result
    }, deadline)
  }
  query(kind: string, query: AnalyticsQuery) {
    return this.exclusive(async () => { await this.backend.beforeRequest(); return this.backend.query(kind, query) }, Date.now() + this.config.queryTimeoutMs)
  }
  readiness() {
    return this.exclusive(async () => {
      await this.backend.beforeRequest()
      await Promise.all([this.backend.client.query('SELECT 1'), this.backend.reader.query('SELECT 1')])
    }, Date.now() + this.config.queryTimeoutMs)
  }
  maintain() { return this.exclusive(() => this.backend.maintain()) }
  async close() {
    if (this.closing) return
    this.closing = true
    try { await this.ready; await this.tail } finally { this.backend.close(); this.unlock() }
  }
}
