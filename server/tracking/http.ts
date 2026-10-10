import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { userSortKeys } from '../../shared/analytics.js'
import { BatchSchema, MAX_BATCH_BYTES } from '@dsh-ops/tracking-contract'
import { GuideError } from '../guide-store.js'
import type { AdminHandler } from '../admin-files.js'
import { dayAt, type Installation } from './database.js'
import type { TrackingStore } from './store.js'
export type TrackingHttpConfig = { enabled: boolean; defaultEnvironment: 'development' | 'production' }
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v)
const Query = z.object({ from: date, to: date, environment: z.enum(['all', 'production', 'development', 'test']).default('production'), platform: z.enum(['darwin','win32','linux','other']).optional(), appVersion: z.string().regex(/^[0-9][a-zA-Z0-9.+-]{0,63}$/).optional(), userId: z.uuid().optional(), offset: z.coerce.number().int().min(0).max(100000).default(0), limit: z.coerce.number().int().min(1).max(100).default(50), search: z.string().trim().max(80).optional(), sort: z.enum(userSortKeys).optional(), direction: z.enum(['asc','desc']).optional() }).strict().refine(q => q.from <= q.to && Date.parse(q.to) - Date.parse(q.from) <= 399 * 86400000)
function json(res: ServerResponse, value: unknown, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
async function body(req: IncomingMessage, limit: number) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json' || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) throw new GuideError('JSON_REQUIRED', 415)
  if (Number(req.headers['content-length'] ?? 0) > limit) throw new GuideError('BATCH_TOO_LARGE', 413)
  const timer = setTimeout(() => req.destroy(), 15000)
  const chunks: Buffer[] = []; let size = 0
  try {
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw new GuideError('BATCH_TOO_LARGE', 413); chunks.push(Buffer.from(chunk)) }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { throw new GuideError('INVALID_REQUEST', 400) }
  } finally { clearTimeout(timer) }
}
export function createTrackingHandlers(store: TrackingStore, config: TrackingHttpConfig) {
  let budget = { window: 0, count: 0 }
  let inflight = 0
  const collect = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (!url.pathname.startsWith('/api/tracking/')) return false
    try {
      if (req.method !== 'POST') throw new GuideError('METHOD_NOT_ALLOWED', 405)
      if (!config.enabled) throw new GuideError('TRACKING_NOT_ENABLED', 503)
      if (req.headers.origin || req.headers['sec-fetch-site']) throw new GuideError('HOST_UPLOAD_REQUIRED', 403)
      if (url.pathname === '/api/tracking/v1/identity-sessions') throw new GuideError('IDENTITY_NOT_CONFIGURED', 503)
      if (url.pathname !== '/api/tracking/v1/events:batch') throw new GuideError('NOT_FOUND', 404)
      if (Date.now() - budget.window > 60000) budget = { window: Date.now(), count: 0 }
      if (++budget.count > 120 || inflight >= 32) throw new GuideError('RATE_LIMITED', 429)
      inflight++
      try {
        const parsed = BatchSchema.safeParse(await body(req, MAX_BATCH_BYTES))
        if (!parsed.success) throw new GuideError('INVALID_BATCH', 400)
        const { installationId, environment, events } = parsed.data
        const ids = events.map(e => (e as { eventId?: unknown } | null)?.eventId)
        if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new GuideError('INVALID_BATCH_IDS', 400)
        // Keep the historical single-tenant namespace for identity/dedup
        // continuity. Its name is independent of the event environment.
        // Host employee metadata attributes analytics only; it grants no access.
        const installation: Installation = { tenantId: 'development', installationId, environment }
        json(res, await store.ingest(installation, events))
      } finally { inflight-- }
    } catch (error) {
      const known = error instanceof GuideError
      if (known && error.status === 429) res.setHeader('Retry-After', '60')
      json(res, { error: known ? error.code : 'ANALYTICS_UNAVAILABLE' }, known ? error.status : 503)
    }
    return true
  }
  const admin: AdminHandler = async (req, res, url, context) => {
    if (!url.pathname.startsWith('/api/admin/analytics/')) return false
    context.method(req, ['GET'])
    if (url.pathname === '/api/admin/analytics/context') {
      context.json(res, { defaultEnvironment: config.defaultEnvironment })
      return true
    }
    const match = /^\/api\/admin\/analytics\/(overview|trends|users|rankings|features|conversations|skills|operations|health)(?:\/([a-f0-9-]{36}))?$/.exec(url.pathname)
    if (!match || (match[2] && match[1] !== 'users')) throw new GuideError('NOT_FOUND', 404)
    const input = Object.fromEntries(url.searchParams)
    const query = Query.safeParse({ from: dayAt(Date.now() - 29 * 86400000), to: dayAt(Date.now()), environment: config.defaultEnvironment, ...input, ...(match[2] ? { userId: match[2] } : {}) })
    if (!query.success || [...url.searchParams.keys()].length !== Object.keys(input).length) throw new GuideError('INVALID_ANALYTICS_QUERY', 400)
    if ((query.data.search !== undefined && !['users','rankings'].includes(match[1]!)) || ((query.data.sort !== undefined || query.data.direction !== undefined) && match[1] !== 'users')) throw new GuideError('INVALID_ANALYTICS_QUERY', 400)
    try { context.json(res, await store.query(match[1]!, query.data)) }
    catch { throw new GuideError('ANALYTICS_UNAVAILABLE', 503) }
    return true
  }
  return { collect, admin, configured: config.enabled }
}
