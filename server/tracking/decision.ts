import { randomUUID } from 'node:crypto'
import { EventSchema, Id, isActive, isSuccess, type BatchResponse, type TrackingEvent } from '@dsh-ops/tracking-contract'
import { TABLES, canonical, hashCanonical as digest, rowKey, type State, type Row, type TableName, type Change } from './canonical.js'
import type { Installation, Principal } from './types.js'

const DAY = 86400000
const dayAt = (ms: number) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10)
class Overlay {
  private rows: Record<TableName, Map<string, Row>>
  private touched = new Map<string, { table: TableName; key: string; before: Row | undefined }>()
  constructor(state: State) { this.rows = Object.fromEntries(TABLES.map(table => [table, new Map(state[table].map(row => [rowKey(table, row), row]))])) as typeof this.rows }
  all(table: TableName) { return [...this.rows[table].values()] }
  find(table: TableName, predicate: (row: Row) => boolean) { return this.all(table).find(predicate) }
  put(table: TableName, row: Row) {
    const key = rowKey(table, row); this.touch(table, key)
    this.rows[table].set(key, row)
  }
  remove(table: TableName, row: Row) { const key = rowKey(table, row); this.touch(table, key); this.rows[table].delete(key) }
  private touch(table: TableName, key: string) {
    const id = `${table}:${key}`
    if (!this.touched.has(id)) this.touched.set(id, { table, key, before: this.rows[table].get(key) })
  }
  changes(): Change[] {
    return [...this.touched.values()].flatMap(({ table, key, before }) => {
      const row = this.rows[table].get(key)
      return canonical(before ?? null) === canonical(row ?? null) ? [] : [{ table, key, row: row ?? null }]
    })
  }
}
function newUser(id: string, tenant: string, issuer: string, subject: string, displayName: string): Row {
  return { id, tenant, issuer, subject, display_name: displayName, chinese_name: null, department_name: null, dept_l1_name: null, dept_name: null, profile_updated_at: null }
}
function matches(accepted: TrackingEvent, terminal: TrackingEvent) {
  return accepted.action === terminal.action && accepted.module === terminal.module && accepted.identityRef === terminal.identityRef && digest(accepted.employee ?? null) === digest(terminal.employee ?? null) && accepted.initiator === terminal.initiator && accepted.interactionId === terminal.interactionId && digest(accepted.properties) === digest(terminal.properties) && accepted.occurredAt <= terminal.occurredAt
}
/**
 * Pure, non-mutating decision engine. A scoped state must include every referenced
 * identity/user/dedup/operation, existing facts for every input event ID, all pending facts for referenced operations, and
 * matching pending terminal facts. Aggregates are queried directly from ClickHouse facts.
 */
export function decideIngest(state: State, installation: Installation, inputs: unknown[], now: number, uuid: () => string = randomUUID): { result: BatchResponse; changes: Change[] } {
  const view = new Overlay(state)
  const result: BatchResponse = { acceptedIds: [], duplicateIds: [], rejected: [] }
  const receivedAt = new Date(now).toISOString(), tenant = installation.tenantId
  const reject = (id: string, code: string) => {
    result.rejected.push({ id, code, retryable: false })
    const old = view.find('ingestion_health', row => row.code === code)
    const count = BigInt(old?.count ?? 0) + 1n
    view.put('ingestion_health', { code, count: count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : String(count) })
  }
  const oldInstallation = view.find('installations', row => row.tenant === tenant && row.installation === installation.installationId)
  view.put('installations', oldInstallation ? { ...oldInstallation, last_seen: receivedAt } : { tenant, installation: installation.installationId, environment: installation.environment, last_seen: receivedAt })
  for (const input of inputs) {
    const parsed = EventSchema.safeParse(input), rawId = Id.safeParse((input as Record<string, unknown> | null)?.eventId)
    if (!parsed.success) { reject(rawId.success ? rawId.data : 'invalid-event', 'INVALID_EVENT'); continue }
    const event = parsed.data, id = event.eventId, hash = digest(event)
    if (event.installationId !== installation.installationId || event.environment !== installation.environment) { reject(id, 'INSTALLATION_MISMATCH'); continue }
    const time = Date.parse(event.occurredAt)
    if (time < now - 30 * DAY || time > now + 300000) { reject(id, 'EVENT_TIME_OUT_OF_RANGE'); continue }
    const duplicate = view.find('event_dedup', row => row.tenant === tenant && row.id === id)
    if (duplicate) { if (duplicate.digest === hash) result.duplicateIds.push(id); else reject(id, 'EVENT_CONFLICT'); continue }
    let userId: string | null = null, pending = 0, pendingTerminalId: string | undefined
    if (event.identityRef) {
      const session = view.find('identity_sessions', row => row.ref === event.identityRef && row.tenant === tenant && row.installation === installation.installationId)
      if (!session) { reject(id, 'IDENTITY_UNKNOWN'); continue }
      if (event.eventName !== 'operation.finished' && (time < Date.parse(String(session.valid_from)) || time >= Date.parse(String(session.expires_at)))) { reject(id, 'IDENTITY_EXPIRED'); continue }
      userId = String(session.user_id)
    }
    if (event.employee) {
      const { source, employeeId } = event.employee
      const user = view.find('users', row => row.tenant === tenant && row.issuer === source && row.subject === employeeId)
      userId = user ? String(user.id) : uuid()
      // Preserve user creation before operation rejection.
      if (!user) view.put('users', newUser(userId, tenant, source, employeeId, employeeId))
      if (!view.find('user_identities', row => row.tenant === tenant && row.issuer === source && row.subject === employeeId)) view.put('user_identities', { tenant, issuer: source, subject: employeeId, user_id: userId })
    }
    if (event.operationId && event.action) {
      let operation = view.find('operations', row => row.tenant === tenant && row.installation === installation.installationId && row.operation === event.operationId)
      const base = operation ?? { tenant, installation: installation.installationId, operation: event.operationId, accepted: null, terminal: null, terminal_digest: null }
      if (event.eventName === 'operation.accepted') {
        if (operation?.accepted) { reject(id, 'ACCEPTED_OPERATION_CONFLICT'); continue }
        if (operation?.terminal) {
          const terminal = JSON.parse(String(operation.terminal)) as TrackingEvent
          if (!matches(event, terminal)) { reject(id, 'OPERATION_CONTEXT_CONFLICT'); continue }
          pendingTerminalId = terminal.eventId
        }
        view.put('operations', { ...base, accepted: JSON.stringify(event) })
      } else {
        const terminalDigest = digest({ action: event.action, properties: event.properties, identityRef: event.identityRef ?? null, ...(event.employee ? { employee: event.employee } : {}), initiator: event.initiator, interactionId: event.interactionId, outcome: event.outcome, changed: event.changed ?? null })
        if (operation?.terminal_digest) {
          if (operation.terminal_digest === terminalDigest) { view.put('event_dedup', { tenant, id, digest: hash, received_at: receivedAt }); result.duplicateIds.push(id) }
          else reject(id, 'TERMINAL_CONFLICT')
          continue
        }
        if (operation?.accepted) {
          if (!matches(JSON.parse(String(operation.accepted)) as TrackingEvent, event)) { reject(id, 'OPERATION_CONTEXT_CONFLICT'); continue }
        } else { pending = 1; userId = null }
        view.put('operations', { ...base, terminal: JSON.stringify(event), terminal_digest: terminalDigest })
      }
    }
    if (userId && event.employee?.profileUpdatedAt && [event.employee.chineseName, event.employee.departmentName, event.employee.deptL1Name, event.employee.deptName].some(Boolean)) {
      const user = view.find('users', row => row.id === userId)!, profile = event.employee, updatedAt = new Date(profile.profileUpdatedAt!).toISOString()
      if (user.profile_updated_at === null || String(user.profile_updated_at) < updatedAt) view.put('users', { ...user, display_name: profile.chineseName ?? user.display_name!, chinese_name: profile.chineseName ?? user.chinese_name!, department_name: profile.departmentName ?? user.department_name!, dept_l1_name: profile.deptL1Name ?? user.dept_l1_name!, dept_name: profile.deptName ?? user.dept_name!, profile_updated_at: updatedAt })
    }
    view.put('event_dedup', { tenant, id, digest: hash, received_at: receivedAt })
    view.put('tracking_events', { tenant, id, body: JSON.stringify(event), received_at: receivedAt })
    // Facts outlive the 120-day dedup index. Reusing their ID must retain the
    // fact-key conflict semantics instead of overwriting old history.
    if (view.find('activity_facts', row => row.tenant === tenant && row.id === id)) throw new Error('TRACKING_FACT_ID_CONFLICT')
    view.put('activity_facts', { tenant, id, user_id: userId, installation: event.installationId, day: dayAt(time), occurred_at: event.occurredAt, environment: installation.environment, platform: event.platform, app_version: event.appVersion, feature: event.feature, action: event.action ?? '', event_name: event.eventName, initiator: event.initiator, interaction: event.interactionId ?? id, operation: event.operationId ?? id, outcome: event.outcome ?? '', active: Number(isActive(event)), success: Number(isSuccess(event)), pending })
    if (event.eventName.startsWith('conversation.') || event.eventName === 'skill.load.completed') {
      const p = event.properties
      view.put('runtime_facts', { tenant, id, conversation: String(p.conversationId ?? ''), turn: Number(p.turn ?? 0), step: Number(p.step ?? 0), session_kind: String(p.sessionKind ?? 'root'), provider: String(p.provider ?? ''), model: String(p.model ?? ''), usage_reported: Number(p.usageReported ?? false), input_tokens: Number(p.inputTokens ?? 0), output_tokens: Number(p.outputTokens ?? 0), cache_read_tokens: Number(p.cacheReadTokens ?? 0), cache_write_tokens: Number(p.cacheWriteTokens ?? 0), reasoning_tokens: Number(p.reasoningTokens ?? 0), skill_name: String(p.skillName ?? ''), method: String(p.method ?? ''), result: String(p.result ?? '') })
    }
    if (event.eventName === 'operation.accepted' && pendingTerminalId) for (const row of view.all('activity_facts')) {
      if (row.tenant === tenant && row.installation === event.installationId && row.operation === event.operationId && row.id === pendingTerminalId && row.pending === 1) {
        view.put('activity_facts', { ...row, user_id: userId, pending: 0 })
      }
    }
    result.acceptedIds.push(id)
  }
  return { result, changes: view.changes() }
}

export function decideIdentity(state: State, installation: Installation, principal: Principal, now: number, uuid: () => string = randomUUID) {
  const validFrom = new Date(now).toISOString(), expiresAt = new Date(Math.min(principal.expiresAt, now + 8 * 3600000)).toISOString()
  if (Date.parse(expiresAt) <= now) throw new Error('IDENTITY_EXPIRED')
  const view = new Overlay(state), tenant = installation.tenantId
  const old = view.find('users', row => row.tenant === tenant && row.issuer === principal.issuer && row.subject === principal.subject)
  const user = old ? { ...old, display_name: principal.displayName } : newUser(uuid(), tenant, principal.issuer, principal.subject, principal.displayName)
  view.put('users', user)
  if (!view.find('user_identities', row => row.tenant === tenant && row.issuer === principal.issuer && row.subject === principal.subject)) view.put('user_identities', { tenant, issuer: principal.issuer, subject: principal.subject, user_id: user.id! })
  const identityRef = uuid()
  view.put('identity_sessions', { ref: identityRef, tenant, installation: installation.installationId, user_id: user.id!, valid_from: validFrom, expires_at: expiresAt })
  return { result: { identityRef, installationId: installation.installationId, validFrom, expiresAt }, changes: view.changes() }
}
