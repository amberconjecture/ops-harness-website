import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, lstatSync, existsSync } from 'node:fs'
import path from 'node:path'
import { userSortKeys, type UserSortKey } from '../../shared/analytics.js'
import { EventSchema, Id, isActive, isSuccess, type BatchResponse, type TrackingEvent } from '@dsh-ops/tracking-contract'
export type Installation = { tenantId: string; installationId: string; environment: 'production' | 'development' | 'test' }
export type Principal = { issuer: string; subject: string; displayName: string; expiresAt: number }
export type AnalyticsQuery = { from: string; to: string; environment: string; platform?: string | undefined; appVersion?: string | undefined; userId?: string | undefined; offset: number; limit: number; search?: string | undefined; sort?: UserSortKey | undefined; direction?: 'asc' | 'desc' | undefined }
const DAY = 86400000
export function dayAt(ms: number) { return new Date(ms + 8 * 3600000).toISOString().slice(0, 10) }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
export class TrackingDatabase {
  private db: DatabaseSync
  constructor(directory: string, private now = Date.now) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (lstatSync(directory).isSymbolicLink() || (existsSync(path.join(directory, 'analytics.sqlite')) && lstatSync(path.join(directory, 'analytics.sqlite')).isSymbolicLink())) throw new Error('UNSAFE_ANALYTICS_PATH')
    this.db = new DatabaseSync(path.join(directory, 'analytics.sqlite'))
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_version VALUES(1);
      CREATE TABLE IF NOT EXISTS installations(tenant TEXT, installation TEXT, environment TEXT, last_seen TEXT, PRIMARY KEY(tenant,installation));
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, tenant TEXT, issuer TEXT, subject TEXT, display_name TEXT, UNIQUE(tenant,issuer,subject));
      CREATE TABLE IF NOT EXISTS user_identities(tenant TEXT,issuer TEXT,subject TEXT,user_id TEXT,PRIMARY KEY(tenant,issuer,subject));
      CREATE TABLE IF NOT EXISTS identity_sessions(ref TEXT PRIMARY KEY,tenant TEXT,installation TEXT,user_id TEXT,valid_from TEXT,expires_at TEXT);
      CREATE TABLE IF NOT EXISTS event_dedup(tenant TEXT,id TEXT,digest TEXT,received_at TEXT,PRIMARY KEY(tenant,id));
      CREATE TABLE IF NOT EXISTS tracking_events(tenant TEXT,id TEXT,body TEXT,received_at TEXT,PRIMARY KEY(tenant,id));
      CREATE TABLE IF NOT EXISTS operations(tenant TEXT,installation TEXT,operation TEXT,accepted TEXT,terminal TEXT,terminal_digest TEXT,PRIMARY KEY(tenant,installation,operation));
      CREATE TABLE IF NOT EXISTS activity_facts(tenant TEXT,id TEXT,user_id TEXT,installation TEXT,day TEXT,occurred_at TEXT,environment TEXT,platform TEXT,app_version TEXT,feature TEXT,action TEXT,event_name TEXT,initiator TEXT,interaction TEXT,operation TEXT,outcome TEXT,active INTEGER,success INTEGER,pending INTEGER,PRIMARY KEY(tenant,id));
      CREATE INDEX IF NOT EXISTS facts_window ON activity_facts(environment,day,user_id);
      CREATE INDEX IF NOT EXISTS facts_operation ON activity_facts(tenant,installation,operation);
      CREATE TABLE IF NOT EXISTS user_day(tenant TEXT,day TEXT,user_id TEXT,environment TEXT,active INTEGER,logins INTEGER,interactions INTEGER,successes INTEGER,PRIMARY KEY(tenant,day,user_id,environment));
      CREATE TABLE IF NOT EXISTS ingestion_health(code TEXT PRIMARY KEY,count INTEGER);
    `)
    const version = Number(this.db.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version)
    if (![1, 2, 3].includes(version)) throw new Error('UNSUPPORTED_ANALYTICS_SCHEMA')
    if (version === 1) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(`CREATE TABLE runtime_facts(
          tenant TEXT,id TEXT,conversation TEXT,turn INTEGER,step INTEGER,session_kind TEXT,
          provider TEXT,model TEXT,usage_reported INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER,
          skill_name TEXT,method TEXT,result TEXT,PRIMARY KEY(tenant,id),FOREIGN KEY(tenant,id) REFERENCES activity_facts(tenant,id) ON DELETE CASCADE);
          CREATE INDEX runtime_skill ON runtime_facts(skill_name);
          INSERT INTO runtime_facts SELECT tenant,id,'',0,0,'root','','',0,0,0,0,0,0,'','','' FROM activity_facts WHERE event_name='conversation.message.accepted';
          INSERT INTO schema_version VALUES(2); COMMIT;`)
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    }
    if (version < 3) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(`ALTER TABLE users ADD COLUMN chinese_name TEXT;
          ALTER TABLE users ADD COLUMN department_name TEXT;
          ALTER TABLE users ADD COLUMN dept_l1_name TEXT;
          ALTER TABLE users ADD COLUMN dept_name TEXT;
          ALTER TABLE users ADD COLUMN profile_updated_at TEXT;
          INSERT INTO schema_version VALUES(3); COMMIT;`)
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    }
  }
  identity(installation: Installation, principal: Principal) {
    const now = this.now()
    const validFrom = new Date(now).toISOString(), expiresAt = new Date(Math.min(principal.expiresAt, now + 8 * 3600000)).toISOString()
    if (Date.parse(expiresAt) <= now) throw new Error('IDENTITY_EXPIRED')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const { tenantId, installationId } = installation
      let user = this.db.prepare('SELECT id FROM users WHERE tenant=? AND issuer=? AND subject=?').get(tenantId, principal.issuer, principal.subject)
      if (!user) {
        const id = randomUUID()
        this.db.prepare('INSERT INTO users(id,tenant,issuer,subject,display_name) VALUES(?,?,?,?,?)').run(id, tenantId, principal.issuer, principal.subject, principal.displayName)
        user = { id }
      } else this.db.prepare('UPDATE users SET display_name=? WHERE id=?').run(principal.displayName, user.id!)
      this.db.prepare('INSERT OR IGNORE INTO user_identities VALUES(?,?,?,?)').run(tenantId, principal.issuer, principal.subject, user.id!)
      const identityRef = randomUUID()
      this.db.prepare('INSERT INTO identity_sessions VALUES(?,?,?,?,?,?)').run(identityRef, tenantId, installationId, user.id!, validFrom, expiresAt)
      this.db.exec('COMMIT')
      return { identityRef, installationId, validFrom, expiresAt }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  ingest(installation: Installation, inputs: unknown[]): BatchResponse {
    const result: BatchResponse = { acceptedIds: [], duplicateIds: [], rejected: [] }
    const receivedAt = new Date(this.now()).toISOString()
    const dirtyDays = new Set<string>()
    const reject = (id: string, code: string) => {
      result.rejected.push({ id, code, retryable: false })
      this.db.prepare('INSERT INTO ingestion_health VALUES(?,1) ON CONFLICT(code) DO UPDATE SET count=count+1').run(code)
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO installations VALUES(?,?,?,?) ON CONFLICT(tenant,installation) DO UPDATE SET last_seen=excluded.last_seen').run(installation.tenantId, installation.installationId, installation.environment, receivedAt)
      for (const input of inputs) {
        const parsed = EventSchema.safeParse(input)
        const rawId = Id.safeParse((input as Record<string, unknown> | null)?.eventId)
        if (!parsed.success) { reject(rawId.success ? rawId.data : 'invalid-event', 'INVALID_EVENT'); continue }
        const event = parsed.data, id = event.eventId, hash = digest(event), tenant = installation.tenantId
        if (event.installationId !== installation.installationId || event.environment !== installation.environment) { reject(id, 'INSTALLATION_MISMATCH'); continue }
        const time = Date.parse(event.occurredAt)
        if (time < this.now() - 30 * DAY || time > this.now() + 300000) { reject(id, 'EVENT_TIME_OUT_OF_RANGE'); continue }
        const duplicate = this.db.prepare('SELECT digest FROM event_dedup WHERE tenant=? AND id=?').get(tenant, id)
        if (duplicate) { if (duplicate.digest === hash) result.duplicateIds.push(id); else reject(id, 'EVENT_CONFLICT'); continue }
        let userId: string | null = null
        let pending = 0
        if (event.identityRef) {
          const session = this.db.prepare('SELECT * FROM identity_sessions WHERE ref=? AND tenant=? AND installation=?').get(event.identityRef, tenant, installation.installationId)
          if (!session) { reject(id, 'IDENTITY_UNKNOWN'); continue }
          if (event.eventName !== 'operation.finished' && (time < Date.parse(String(session.valid_from)) || time >= Date.parse(String(session.expires_at)))) { reject(id, 'IDENTITY_EXPIRED'); continue }
          userId = String(session.user_id)
        }
        if (event.employee) {
          const { source, employeeId } = event.employee
          const user = this.db.prepare('SELECT id FROM users WHERE tenant=? AND issuer=? AND subject=?').get(tenant, source, employeeId)
          userId = user ? String(user.id) : randomUUID()
          if (!user) this.db.prepare('INSERT INTO users(id,tenant,issuer,subject,display_name) VALUES(?,?,?,?,?)').run(userId, tenant, source, employeeId, employeeId)
          this.db.prepare('INSERT OR IGNORE INTO user_identities VALUES(?,?,?,?)').run(tenant, source, employeeId, userId)
        }
        let accepted: TrackingEvent | undefined
        if (event.operationId && event.action) {
          const operation = this.db.prepare('SELECT * FROM operations WHERE tenant=? AND installation=? AND operation=?').get(tenant, installation.installationId, event.operationId)
          if (event.eventName === 'operation.accepted') {
            if (operation?.accepted) { reject(id, 'ACCEPTED_OPERATION_CONFLICT'); continue }
            if (operation?.terminal) {
              const terminal = JSON.parse(String(operation.terminal)) as TrackingEvent
              if (!this.matches(event, terminal)) { reject(id, 'OPERATION_CONTEXT_CONFLICT'); continue }
            }
            this.db.prepare('INSERT INTO operations(tenant,installation,operation,accepted) VALUES(?,?,?,?) ON CONFLICT(tenant,installation,operation) DO UPDATE SET accepted=excluded.accepted').run(tenant, installation.installationId, event.operationId, JSON.stringify(event))
          } else {
            const terminalDigest = digest({ action: event.action, properties: event.properties, identityRef: event.identityRef ?? null, ...(event.employee ? { employee: event.employee } : {}), initiator: event.initiator, interactionId: event.interactionId, outcome: event.outcome, changed: event.changed ?? null })
            if (operation?.terminal_digest) {
              if (operation.terminal_digest === terminalDigest) { this.db.prepare('INSERT INTO event_dedup VALUES(?,?,?,?)').run(tenant, id, hash, receivedAt); result.duplicateIds.push(id) }
              else reject(id, 'TERMINAL_CONFLICT')
              continue
            }
            if (operation?.accepted) {
              accepted = JSON.parse(String(operation.accepted)) as TrackingEvent
              if (!this.matches(accepted, event)) { reject(id, 'OPERATION_CONTEXT_CONFLICT'); continue }
            } else { pending = 1; userId = null }
            this.db.prepare('INSERT INTO operations(tenant,installation,operation,terminal,terminal_digest) VALUES(?,?,?,?,?) ON CONFLICT(tenant,installation,operation) DO UPDATE SET terminal=excluded.terminal,terminal_digest=excluded.terminal_digest').run(tenant, installation.installationId, event.operationId, JSON.stringify(event), terminalDigest)
          }
        }
        // Update only after operation validation; rejected or older offline events
        // must not change the user's current profile. Missing values retain known data.
        if (userId && event.employee?.profileUpdatedAt && [event.employee.chineseName, event.employee.departmentName, event.employee.deptL1Name, event.employee.deptName].some(Boolean)) {
          const profile = event.employee
          const updatedAt = new Date(profile.profileUpdatedAt!).toISOString()
          this.db.prepare(`UPDATE users SET display_name=COALESCE(?,display_name),chinese_name=COALESCE(?,chinese_name),
            department_name=COALESCE(?,department_name),dept_l1_name=COALESCE(?,dept_l1_name),dept_name=COALESCE(?,dept_name),profile_updated_at=?
            WHERE id=? AND (profile_updated_at IS NULL OR profile_updated_at<?)`)
            .run(profile.chineseName ?? null, profile.chineseName ?? null, profile.departmentName ?? null, profile.deptL1Name ?? null, profile.deptName ?? null, updatedAt, userId, updatedAt)
        }
        this.db.prepare('INSERT INTO event_dedup VALUES(?,?,?,?)').run(tenant, id, hash, receivedAt)
        this.db.prepare('INSERT INTO tracking_events VALUES(?,?,?,?)').run(tenant, id, JSON.stringify(event), receivedAt)
        this.db.prepare('INSERT INTO activity_facts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(tenant, id, userId, event.installationId, dayAt(time), event.occurredAt, installation.environment, event.platform, event.appVersion, event.feature, event.action ?? '', event.eventName, event.initiator, event.interactionId ?? id, event.operationId ?? id, event.outcome ?? '', Number(isActive(event)), Number(isSuccess(event)), pending)
        if (event.eventName.startsWith('conversation.') || event.eventName === 'skill.load.completed') {
          const p = event.properties
          this.db.prepare('INSERT INTO runtime_facts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(tenant, id, String(p.conversationId ?? ''), Number(p.turn ?? 0), Number(p.step ?? 0), String(p.sessionKind ?? 'root'), String(p.provider ?? ''), String(p.model ?? ''), Number(p.usageReported ?? false), Number(p.inputTokens ?? 0), Number(p.outputTokens ?? 0), Number(p.cacheReadTokens ?? 0), Number(p.cacheWriteTokens ?? 0), Number(p.reasoningTokens ?? 0), String(p.skillName ?? ''), String(p.method ?? ''), String(p.result ?? ''))
        }
        dirtyDays.add(dayAt(time))
        if (event.eventName === 'operation.accepted') {
          for (const row of this.db.prepare('SELECT day FROM activity_facts WHERE tenant=? AND installation=? AND operation=? AND pending=1').all(tenant, event.installationId, event.operationId!)) dirtyDays.add(String(row.day))
          this.db.prepare('UPDATE activity_facts SET user_id=?,pending=0 WHERE tenant=? AND installation=? AND operation=? AND pending=1').run(userId, tenant, event.installationId, event.operationId!)
        }
        result.acceptedIds.push(id)
      }
      this.rebuildDays(installation.tenantId, dirtyDays)
      this.db.exec('COMMIT')
      return result
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private matches(accepted: TrackingEvent, terminal: TrackingEvent) {
    return accepted.action === terminal.action && accepted.module === terminal.module && accepted.identityRef === terminal.identityRef && digest(accepted.employee ?? null) === digest(terminal.employee ?? null) && accepted.initiator === terminal.initiator && accepted.interactionId === terminal.interactionId && digest(accepted.properties) === digest(terminal.properties) && accepted.occurredAt <= terminal.occurredAt
  }
  private rebuildDays(tenant: string, days: Set<string>) {
    // Each batch only rebuilds dates it changed; replays never increment aggregates.
    for (const day of days) {
      this.db.prepare('DELETE FROM user_day WHERE tenant=? AND day=?').run(tenant, day)
      this.db.prepare(`INSERT INTO user_day SELECT tenant,day,user_id,environment,MAX(active),COUNT(DISTINCT CASE WHEN event_name='auth.login.succeeded' THEN operation END),COUNT(DISTINCT CASE WHEN active=1 THEN installation||':'||interaction END),COUNT(DISTINCT CASE WHEN success=1 THEN installation||':'||operation END) FROM activity_facts WHERE tenant=? AND day=? AND user_id IS NOT NULL AND pending=0 GROUP BY tenant,day,user_id,environment`).run(tenant, day)
    }
  }
  query(kind: string, q: AnalyticsQuery) {
    const values: SQLInputValue[] = [q.from, q.to]
    let where = 'f.day>=? AND f.day<=? AND f.pending=0'
    if (q.environment !== 'all') { where += ' AND f.environment=?'; values.push(q.environment) }
    if (q.platform) { where += ' AND f.platform=?'; values.push(q.platform) }
    if (q.appVersion) { where += ' AND f.app_version=?'; values.push(q.appVersion) }
    if (q.userId) { where += ' AND f.user_id=?'; values.push(q.userId) }
    const run = (sql: string, extra: SQLInputValue[] = []) => this.db.prepare(sql).all(...values, ...extra)
    const userKey = `f.tenant||':'||f.user_id`
    const meta = { asOf: new Date(this.now()).toISOString(), dataThrough: run(`SELECT MAX(e.received_at) AS value FROM tracking_events e JOIN activity_facts f ON e.tenant=f.tenant AND e.id=f.id WHERE ${where}`)[0]?.value ?? null, metricVersion: 3, timezone: 'Asia/Shanghai', from: q.from, to: q.to, environment: q.environment }
    const foreground = "f.initiator='user' AND f.event_name IN ('page.view','feature.view','operation.accepted','conversation.message.accepted','auth.login.succeeded')"
    const runtimeJoin = 'activity_facts f JOIN runtime_facts r ON r.tenant=f.tenant AND r.id=f.id'
    const tokens = 'r.input_tokens+r.output_tokens+r.cache_read_tokens+r.cache_write_tokens'
    const message = "f.event_name='conversation.message.accepted' AND f.initiator='user'"
    if (kind === 'conversations') {
      const measures = `COALESCE(SUM(${message}),0) AS messages,COUNT(DISTINCT CASE WHEN ${message} AND r.conversation<>'' THEN f.tenant||':'||r.conversation END) AS conversations,
        COUNT(DISTINCT CASE WHEN ${message} THEN ${userKey} END) AS users,
        COALESCE(SUM(f.event_name='conversation.model.usage'),0) AS modelSteps,COALESCE(SUM(f.event_name='conversation.model.usage' AND r.usage_reported=0),0) AS missingUsage,
        COALESCE(SUM(${tokens}),0) AS totalTokens,COALESCE(SUM(r.input_tokens),0) AS inputTokens,COALESCE(SUM(r.output_tokens),0) AS outputTokens,
        COALESCE(SUM(r.cache_read_tokens),0) AS cacheReadTokens,COALESCE(SUM(r.cache_write_tokens),0) AS cacheWriteTokens,COALESCE(SUM(r.reasoning_tokens),0) AS reasoningTokens,
        COALESCE(SUM(CASE WHEN f.user_id IS NULL THEN ${tokens} ELSE 0 END),0) AS anonymousTokens`
      const clause = `${where} AND f.event_name IN ('conversation.message.accepted','conversation.model.usage')`
      return { ...meta, ...run(`SELECT ${measures} FROM ${runtimeJoin} WHERE ${clause}`)[0], rows: run(`SELECT f.initiator,r.session_kind AS sessionKind,${measures} FROM ${runtimeJoin} WHERE ${clause} GROUP BY f.initiator,r.session_kind ORDER BY messages DESC,totalTokens DESC,f.initiator,r.session_kind`) }
    }
    if (kind === 'skills') {
      const measures = `COALESCE(SUM(r.result='succeeded'),0) AS loads,COALESCE(SUM(r.result='failed'),0) AS failures,
        COALESCE(SUM(r.result='succeeded' AND r.method='explicit'),0) AS explicitLoads,COALESCE(SUM(r.result='succeeded' AND r.method='model'),0) AS modelLoads,
        COALESCE(SUM(r.result='succeeded' AND f.initiator='user'),0) AS userLoads,
        COUNT(DISTINCT CASE WHEN r.result='succeeded' THEN ${userKey} END) AS users,
        COUNT(DISTINCT CASE WHEN r.result='succeeded' THEN f.tenant||':'||r.conversation END) AS conversations,
        COUNT(DISTINCT CASE WHEN r.result='succeeded' THEN f.tenant||':'||f.installation END) AS installations`
      const clause = `${where} AND f.event_name='skill.load.completed'`
      return { ...meta, ...run(`SELECT ${measures},COUNT(DISTINCT r.skill_name) AS total FROM ${runtimeJoin} WHERE ${clause}`)[0], rows: run(`SELECT r.skill_name AS skillName,${measures} FROM ${runtimeJoin} WHERE ${clause} GROUP BY r.skill_name ORDER BY loads DESC,r.skill_name LIMIT ? OFFSET ?`, [q.limit, q.offset]), limit: q.limit, offset: q.offset }
    }
    if (kind === 'health') return { ...meta, ...run(`SELECT COUNT(*) AS collected,COUNT(DISTINCT f.tenant||':'||f.installation) AS installations,COALESCE(SUM(user_id IS NULL),0) AS anonymousEvents,COALESCE(SUM(user_id IS NOT NULL),0) AS identifiedEvents FROM activity_facts f WHERE ${where}`)[0], rows: this.db.prepare('SELECT * FROM ingestion_health ORDER BY count DESC').all() }
    if (kind === 'overview') {
      const row = this.db.prepare(`SELECT COUNT(DISTINCT CASE WHEN ${foreground} THEN ${userKey} END) AS loginUsers, COUNT(DISTINCT CASE WHEN ${foreground} THEN ${userKey} END) AS signedInUsers, COUNT(DISTINCT CASE WHEN f.active=1 THEN ${userKey} END) AS activeUsers, COUNT(DISTINCT CASE WHEN f.active=1 AND f.day=? THEN ${userKey} END) AS dau, COUNT(DISTINCT CASE WHEN f.active=1 THEN f.tenant||':'||f.installation||':'||f.interaction END) AS interactions, COUNT(DISTINCT CASE WHEN f.success=1 THEN f.tenant||':'||f.installation||':'||f.operation END) AS successes FROM activity_facts f WHERE ${where} AND f.user_id IS NOT NULL`).get(q.to, ...values)!
      const mauFrom = dayAt(Date.parse(`${q.to}T00:00:00+08:00`) - 29 * DAY)
      const mauValues = [...values]; mauValues[0] = mauFrom
      const mau = this.db.prepare(`SELECT COUNT(DISTINCT ${userKey}) AS value FROM activity_facts f WHERE ${where} AND f.active=1 AND f.user_id IS NOT NULL`).get(...mauValues)?.value ?? 0
      return { ...meta, ...row, mau, stickiness: Number(mau) ? Number(row.dau) / Number(mau) : null }
    }
    if (kind === 'trends') return { ...meta, rows: run(`SELECT day,COUNT(DISTINCT CASE WHEN active=1 THEN ${userKey} END) AS dau,COUNT(DISTINCT CASE WHEN ${foreground} THEN ${userKey} END) AS loginUsers FROM activity_facts f WHERE ${where} AND user_id IS NOT NULL GROUP BY day ORDER BY day`) }
    if (kind === 'features') return { ...meta, rows: run(`SELECT feature,COUNT(DISTINCT CASE WHEN active=1 THEN ${userKey} END) AS users,COUNT(DISTINCT CASE WHEN event_name IN ('page.view','feature.view') THEN ${userKey} END) AS visitors,COUNT(DISTINCT CASE WHEN active=1 THEN tenant||':'||installation||':'||interaction END) AS uses,COUNT(DISTINCT CASE WHEN success=1 THEN tenant||':'||installation||':'||operation END) AS successes,SUM(outcome='failed' AND initiator='user') AS failures FROM activity_facts f WHERE ${where} AND user_id IS NOT NULL GROUP BY feature ORDER BY users DESC,feature`) }
    if (kind === 'users' || kind === 'rankings') {
      if (q.search) {
        where += ' AND (instr(lower(u.display_name),lower(?))>0 OR instr(lower(u.subject),lower(?))>0)'
        values.push(q.search, q.search)
      }
      // Only allow known SELECT aliases in ORDER BY; user input remains bound.
      const order = kind === 'users' && q.sort && userSortKeys.includes(q.sort)
        ? `${q.sort} ${q.direction === 'asc' ? 'ASC' : 'DESC'},f.user_id`
        : 'activeDays DESC,successes DESC,features DESC,f.user_id'
      const rows = run(`SELECT f.user_id AS userId,u.display_name AS displayName,u.subject AS account,u.chinese_name AS chineseName,u.department_name AS departmentName,u.dept_l1_name AS deptL1Name,u.dept_name AS deptName,u.profile_updated_at AS profileUpdatedAt,MIN(occurred_at) AS firstSeen,MAX(occurred_at) AS lastSeen,COUNT(DISTINCT CASE WHEN active=1 THEN day END) AS activeDays,COUNT(DISTINCT CASE WHEN active=1 THEN f.tenant||':'||installation||':'||interaction END) AS interactions,COUNT(DISTINCT CASE WHEN success=1 THEN f.tenant||':'||installation||':'||operation END) AS successes,COUNT(DISTINCT CASE WHEN active=1 THEN feature END) AS features,
        SUM(${message}) AS messages,COUNT(DISTINCT CASE WHEN ${message} AND r.conversation<>'' THEN f.tenant||':'||r.conversation END) AS conversations,COALESCE(SUM(${tokens}),0) AS totalTokens,COALESCE(SUM(r.result='succeeded'),0) AS skillLoads
        FROM activity_facts f JOIN users u ON u.id=f.user_id LEFT JOIN runtime_facts r ON r.tenant=f.tenant AND r.id=f.id WHERE ${where} GROUP BY f.user_id ORDER BY ${order} LIMIT ? OFFSET ?`, [q.limit, q.offset])
      const total = run(`SELECT COUNT(DISTINCT ${userKey}) AS value FROM activity_facts f JOIN users u ON u.id=f.user_id WHERE ${where}`)[0]?.value ?? 0
      return { ...meta, rows, total, offset: q.offset, limit: q.limit }
    }
    if (kind === 'operations') return { ...meta, rows: run(`SELECT f.id AS eventId,f.occurred_at AS occurredAt,f.user_id AS userId,u.display_name AS displayName,u.subject AS account,u.chinese_name AS chineseName,u.department_name AS departmentName,u.dept_l1_name AS deptL1Name,u.dept_name AS deptName,u.profile_updated_at AS profileUpdatedAt,f.feature,f.action,f.event_name AS eventName,f.initiator,f.outcome, e.body FROM activity_facts f JOIN tracking_events e ON e.tenant=f.tenant AND e.id=f.id LEFT JOIN users u ON u.id=f.user_id WHERE ${where} ORDER BY occurred_at DESC,f.id LIMIT ? OFFSET ?`, [q.limit, q.offset]).map(({ body, ...row }) => ({ ...row, durationMs: (JSON.parse(String(body)) as TrackingEvent).durationMs ?? null })), limit: q.limit, offset: q.offset, retentionDays: 90 }
    throw new Error('UNKNOWN_ANALYTICS_QUERY')
  }
  maintain() {
    const before = (days: number) => new Date(this.now() - days * DAY).toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM tracking_events WHERE received_at<?').run(before(90))
      this.db.prepare('DELETE FROM event_dedup WHERE received_at<?').run(before(120))
      this.db.prepare('DELETE FROM identity_sessions WHERE expires_at<?').run(before(120))
      this.db.prepare('DELETE FROM activity_facts WHERE day<?').run(dayAt(this.now() - 400 * DAY))
      this.db.prepare('DELETE FROM user_day WHERE day<?').run(dayAt(this.now() - 400 * DAY))
      this.db.prepare("DELETE FROM operations WHERE COALESCE(json_extract(terminal,'$.occurredAt'),json_extract(accepted,'$.occurredAt'))<?").run(before(120))
      this.db.exec('COMMIT; PRAGMA wal_checkpoint(PASSIVE)')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  close() { this.db.close() }
}
