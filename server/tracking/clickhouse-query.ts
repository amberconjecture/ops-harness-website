import { userSortKeys } from '../../shared/analytics.js'
import { type TableName } from './canonical.js'
import type { AnalyticsQuery } from './types.js'
import { qualified } from './clickhouse-schema.js'

export type QueryParams = Record<string, unknown>
export type QueryTime = string | number | Date
const DAY = 86_400_000
export function queryTime(value: QueryTime): string {
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) throw new Error('INVALID_ANALYTICS_TIME')
  return new Date(time).toISOString()
}
export function shanghaiDay(time: number): string { return new Date(time + 8 * 3_600_000).toISOString().slice(0, 10) }

/** FINAL selects complete current rows before applying mutable predicates. */
export function logicalTableSql(database: string, table: TableName): string {
  return `SELECT * FROM ${qualified(database, table)} FINAL`
}

const numericOutput = new Set(['count', 'value', 'total', 'loginUsers', 'signedInUsers', 'activeUsers', 'dau', 'mau', 'interactions', 'successes', 'users', 'visitors', 'uses', 'failures', 'activeDays', 'features', 'messages', 'conversations', 'totalTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'anonymousTokens', 'modelSteps', 'missingUsage', 'loads', 'explicitLoads', 'modelLoads', 'userLoads', 'installations', 'skillLoads', 'collected', 'anonymousEvents', 'identifiedEvents'])
export function normalizeQueryRow(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (numericOutput.has(key) && value !== null) {
      if ((typeof value !== 'number' && typeof value !== 'string') || !/^-?\d+$/.test(String(value))) throw new Error('ANALYTICS_INVALID_INTEGER')
      const exact = BigInt(value)
      if (exact > BigInt(Number.MAX_SAFE_INTEGER) || exact < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('ANALYTICS_INTEGER_OVERFLOW')
      result[key] = Number(exact)
    } else result[key] = value
  }
  return result
}

export interface AnalyticsSqlPlan {
  params: QueryParams
  queries: string[]
  finish(results: Record<string, unknown>[][]): Record<string, unknown>
}

export function analyticsSql(database: string, time: QueryTime, kind: string, q: AnalyticsQuery): AnalyticsSqlPlan {
  const params = { from: q.from, to: q.to, environment: q.environment, offset: q.offset, limit: q.limit, platform: q.platform ?? '', appVersion: q.appVersion ?? '', userId: q.userId ?? '', search: q.search ?? '' }
  const where = `f.day>={from:Date} AND f.day<={to:Date} AND f.pending=0
    ${q.environment !== 'all' ? 'AND f.environment={environment:String}' : ''}
    ${q.platform ? 'AND f.platform={platform:String}' : ''}
    ${q.appVersion ? 'AND f.app_version={appVersion:String}' : ''}
    ${q.userId ? 'AND f.user_id={userId:String}' : ''}`
  const ctes = `WITH facts AS (${logicalTableSql(database, 'activity_facts')}),
    users_state AS (${logicalTableSql(database, 'users')}),
    runtime_state AS (${logicalTableSql(database, 'runtime_facts')}),
    events_state AS (${logicalTableSql(database, 'tracking_events')})`
  const rawMeta = `${ctes} SELECT maxOrNull(e.received_at) AS dataThrough FROM events_state e INNER JOIN facts f ON e.tenant=f.tenant AND e.id=f.id WHERE ${where}`
  const queries = [rawMeta]
  const add = (sql: string) => { queries.push(`${ctes} ${sql}`) }
  const meta = (results: Record<string, unknown>[][]) => ({ asOf: queryTime(time), dataThrough: results[0]?.[0]?.dataThrough ?? null, metricVersion: 3, timezone: 'Asia/Shanghai', from: q.from, to: q.to, environment: q.environment })
  const userKey = `concat(f.tenant,':',f.user_id)`
  const interactionKey = `concat(f.tenant,':',f.installation,':',f.interaction)`
  const operationKey = `concat(f.tenant,':',f.installation,':',f.operation)`
  const foreground = `f.initiator='user' AND f.event_name IN ('page.view','feature.view','operation.accepted','conversation.message.accepted','auth.login.succeeded')`
  const message = `f.event_name='conversation.message.accepted' AND f.initiator='user'`
  // Promote every operand before addition and SUM; converting an overflowed sum is too late.
  const bucket = (name: string) => `toInt128(r.${name})`
  const tokens = `(${['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'].map(bucket).join('+')})`
  const runtimeJoin = 'facts f INNER JOIN runtime_state r ON r.tenant=f.tenant AND r.id=f.id'
  let finish: AnalyticsSqlPlan['finish']

  if (kind === 'conversations') {
    const measures = `countIf(${message}) AS messages,
      uniqExactIf(concat(f.tenant,':',r.conversation),${message} AND r.conversation!='') AS conversations,
      uniqExactIf(${userKey},${message}) AS users,
      countIf(f.event_name='conversation.model.usage') AS modelSteps,
      countIf(f.event_name='conversation.model.usage' AND r.usage_reported=0) AS missingUsage,
      coalesce(sumOrNull(${tokens}),0) AS totalTokens,coalesce(sumOrNull(${bucket('input_tokens')}),0) AS inputTokens,coalesce(sumOrNull(${bucket('output_tokens')}),0) AS outputTokens,
      coalesce(sumOrNull(${bucket('cache_read_tokens')}),0) AS cacheReadTokens,coalesce(sumOrNull(${bucket('cache_write_tokens')}),0) AS cacheWriteTokens,
      coalesce(sumOrNull(${bucket('reasoning_tokens')}),0) AS reasoningTokens,coalesce(sumIf(${tokens},isNull(f.user_id)),0) AS anonymousTokens`
    const clause = `${where} AND f.event_name IN ('conversation.message.accepted','conversation.model.usage')`
    add(`SELECT ${measures} FROM ${runtimeJoin} WHERE ${clause}`)
    add(`SELECT f.initiator,r.session_kind AS sessionKind,${measures} FROM ${runtimeJoin} WHERE ${clause} GROUP BY f.initiator,r.session_kind ORDER BY messages DESC,totalTokens DESC,f.initiator,r.session_kind`)
    finish = r => ({ ...meta(r), ...r[1]?.[0], rows: r[2] })
  } else if (kind === 'skills') {
    const measures = `countIf(r.result='succeeded') AS loads,countIf(r.result='failed') AS failures,
      countIf(r.result='succeeded' AND r.method='explicit') AS explicitLoads,countIf(r.result='succeeded' AND r.method='model') AS modelLoads,
      countIf(r.result='succeeded' AND f.initiator='user') AS userLoads,
      uniqExactIf(${userKey},r.result='succeeded') AS users,
      uniqExactIf(concat(f.tenant,':',r.conversation),r.result='succeeded') AS conversations,
      uniqExactIf(concat(f.tenant,':',f.installation),r.result='succeeded') AS installations`
    const clause = `${where} AND f.event_name='skill.load.completed'`
    add(`SELECT ${measures},uniqExact(r.skill_name) AS total FROM ${runtimeJoin} WHERE ${clause}`)
    add(`SELECT r.skill_name AS skillName,${measures} FROM ${runtimeJoin} WHERE ${clause} GROUP BY r.skill_name ORDER BY loads DESC,r.skill_name LIMIT {limit:UInt32} OFFSET {offset:UInt32}`)
    finish = r => ({ ...meta(r), ...r[1]?.[0], rows: r[2], limit: q.limit, offset: q.offset })
  } else if (kind === 'health') {
    add(`SELECT count() AS collected,uniqExact(concat(f.tenant,':',f.installation)) AS installations,countIf(isNull(f.user_id)) AS anonymousEvents,countIf(isNotNull(f.user_id)) AS identifiedEvents FROM facts f WHERE ${where}`)
    queries.push(`SELECT code,count FROM (${logicalTableSql(database, 'ingestion_health')}) ORDER BY count DESC,code`)
    finish = r => ({ ...meta(r), ...r[1]?.[0], rows: r[2] })
  } else if (kind === 'overview') {
    add(`SELECT uniqExactIf(${userKey},${foreground}) AS loginUsers,uniqExactIf(${userKey},${foreground}) AS signedInUsers,
      uniqExactIf(${userKey},f.active=1) AS activeUsers,uniqExactIf(${userKey},f.active=1 AND f.day={to:Date}) AS dau,
      uniqExactIf(${interactionKey},f.active=1) AS interactions,uniqExactIf(${operationKey},f.success=1) AS successes
      FROM facts f WHERE ${where} AND isNotNull(f.user_id)`)
    const mauFrom = shanghaiDay(Date.parse(`${q.to}T00:00:00+08:00`) - 29 * DAY)
    Object.assign(params, { mauFrom })
    add(`SELECT uniqExact(${userKey}) AS mau FROM facts f WHERE ${where.replace('f.day>={from:Date}', 'f.day>={mauFrom:Date}')} AND f.active=1 AND isNotNull(f.user_id)`)
    finish = r => {
      const row = r[1]?.[0] ?? {}, mau = Number(r[2]?.[0]?.mau ?? 0)
      return { ...meta(r), ...row, mau, stickiness: mau ? Number(row.dau) / mau : null }
    }
  } else if (kind === 'trends') {
    add(`SELECT f.day AS day,uniqExactIf(${userKey},f.active=1) AS dau,uniqExactIf(${userKey},${foreground}) AS loginUsers FROM facts f WHERE ${where} AND isNotNull(f.user_id) GROUP BY f.day ORDER BY f.day`)
    finish = r => ({ ...meta(r), rows: r[1] })
  } else if (kind === 'features') {
    add(`SELECT f.feature AS feature,uniqExactIf(${userKey},f.active=1) AS users,
      uniqExactIf(${userKey},f.event_name IN ('page.view','feature.view')) AS visitors,
      uniqExactIf(${interactionKey},f.active=1) AS uses,uniqExactIf(${operationKey},f.success=1) AS successes,
      sumOrNull(toInt64(f.outcome='failed' AND f.initiator='user')) AS failures
      FROM facts f WHERE ${where} AND isNotNull(f.user_id) GROUP BY f.feature ORDER BY users DESC,f.feature`)
    finish = r => ({ ...meta(r), rows: r[1] })
  } else if (kind === 'users' || kind === 'rankings') {
    // Preserve the existing ASCII-only case-insensitive search contract.
    const search = q.search ? `AND (position(lower(u.display_name),lower({search:String}))>0 OR position(lower(u.subject),lower({search:String}))>0)` : ''
    const order = kind === 'users' && q.sort && userSortKeys.includes(q.sort)
      ? `${q.sort} ${q.direction === 'asc' ? 'ASC' : 'DESC'},f.user_id` : 'activeDays DESC,successes DESC,features DESC,f.user_id'
    const userColumns = ['display_name', 'subject', 'chinese_name', 'department_name', 'dept_l1_name', 'dept_name', 'profile_updated_at']
    add(`SELECT f.user_id AS userId,u.display_name AS displayName,u.subject AS account,u.chinese_name AS chineseName,
      u.department_name AS departmentName,u.dept_l1_name AS deptL1Name,u.dept_name AS deptName,u.profile_updated_at AS profileUpdatedAt,
      min(f.occurred_at) AS firstSeen,max(f.occurred_at) AS lastSeen,uniqExactIf(f.day,f.active=1) AS activeDays,
      uniqExactIf(${interactionKey},f.active=1) AS interactions,uniqExactIf(${operationKey},f.success=1) AS successes,
      uniqExactIf(f.feature,f.active=1) AS features,countIf(${message}) AS messages,
      uniqExactIf(concat(f.tenant,':',r.conversation),${message} AND r.conversation!='') AS conversations,
      coalesce(sumOrNull(${tokens}),0) AS totalTokens,countIf(r.result='succeeded') AS skillLoads
      FROM facts f INNER JOIN users_state u ON u.id=f.user_id AND u.tenant=f.tenant LEFT JOIN runtime_state r ON r.tenant=f.tenant AND r.id=f.id
      WHERE ${where} ${search} GROUP BY f.user_id,${userColumns.map(c => `u.${c}`).join(',')}
      ORDER BY ${order} LIMIT {limit:UInt32} OFFSET {offset:UInt32}`)
    add(`SELECT uniqExact(${userKey}) AS total FROM facts f INNER JOIN users_state u ON u.id=f.user_id AND u.tenant=f.tenant WHERE ${where} ${search}`)
    finish = r => ({ ...meta(r), rows: r[1], total: r[2]?.[0]?.total ?? 0, limit: q.limit, offset: q.offset })
  } else if (kind === 'operations') {
    add(`SELECT f.id AS eventId,f.occurred_at AS occurredAt,f.user_id AS userId,u.display_name AS displayName,u.subject AS account,
      u.chinese_name AS chineseName,u.department_name AS departmentName,u.dept_l1_name AS deptL1Name,u.dept_name AS deptName,
      u.profile_updated_at AS profileUpdatedAt,f.feature AS feature,f.action AS action,f.event_name AS eventName,
      f.initiator AS initiator,f.outcome AS outcome,e.body AS body
      FROM facts f INNER JOIN events_state e ON e.tenant=f.tenant AND e.id=f.id LEFT JOIN users_state u ON u.id=f.user_id AND u.tenant=f.tenant
      WHERE ${where} ORDER BY f.occurred_at DESC,f.id LIMIT {limit:UInt32} OFFSET {offset:UInt32}`)
    finish = r => ({ ...meta(r), rows: (r[1] ?? []).map(({ body, ...row }) => {
      const event = (body === null ? {} : JSON.parse(String(body))) as { durationMs?: number }
      return { ...row, durationMs: event.durationMs ?? null }
    }), limit: q.limit, offset: q.offset, retentionDays: 90 })
  } else throw new Error('UNKNOWN_ANALYTICS_QUERY')
  return { params, queries, finish }
}
