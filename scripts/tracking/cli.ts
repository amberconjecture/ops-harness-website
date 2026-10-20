import { parseArgs } from 'node:util'
import path from 'node:path'
import { getHeapStatistics } from 'node:v8'
import { loadConfig } from '../../server/config.js'
import { ClickHouseHttpClient, initializeClickHouse, grantTypedAccess } from '../../server/tracking/clickhouse.js'
import { TrackingDatabase } from '../../server/tracking/database.js'
import { acquireTrackingLock } from '../../server/tracking/lock.js'
import { parseBackfillSince } from './backfill-time.js'
import { parseTrackingTimeout, trackingAnalyticsConfig } from './resources.js'
import { trackingCommandFailure, type TrackingCommandContext } from './errors.js'

const context: TrackingCommandContext = { stage: 'arguments' }
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { config: { type: 'string' }, sqlite: { type: 'string' }, since: { type: 'string' }, 'source-database': { type: 'string' }, finalize: { type: 'boolean' }, 'batch-size': { type: 'string' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean' } } })
  if (values.help) {
    console.log([
      'pnpm tracking upgrade --source-database OLD_DB [--config /path/website.next.json] [--batch-size 500] [--timeout-ms 300000] [--finalize]',
      'pnpm tracking maintain [--config /path/website.json]',
      'pnpm tracking init [--config /path/website.json] [--timeout-ms 300000]',
      'pnpm tracking backfill --sqlite /path/analytics.sqlite --since "2026-10-18T10:00:00+08:00" [--config /path/website.json] [--batch-size 500] [--timeout-ms 300000]',
      'upgrade keeps the old ClickHouse writer online. Use a new target database and analyticsDirectory; keep the target service stopped while copying.',
      'Repeat upgrade for incremental catch-up. --finalize arms cutover only when lag is at most five minutes. Start the new instance, check GET /api/tracking/ready, and switch/drain old traffic before cutoverDeadline.',
      'Startup/readiness does not activate the target. The first business write rechecks the deadline and permanently prevents further imports from the old database.',
      'A baseline can resume beyond the old TTL grace using its existing target and checkpoint. A retention warning does not stop copying; source rows already removed by TTL may be missing.',
      '--since is required, timezone-qualified and inclusive. Related identities/context are included; user_day is not imported; undated health counters are skipped in SQLite time-window backfill.',
      'pnpm tracking starts Node with a 16384 MiB old-space limit. --timeout-ms sets each ClickHouse request/read budget (1000-300000 ms, default 300000). Incremental logs must still be retained; journal gaps and the five-minute cutover limit remain enforced.',
      'init, maintain and SQLite backfill require the target website writer to be stopped. The SQLite source is opened read-only.',
    ].join('\n')); return
  }
  const command = positionals[0]
  if (positionals.length !== 1 || !['init', 'backfill', 'upgrade', 'maintain'].includes(command!)) throw new Error('EXPECTED_INIT_BACKFILL_UPGRADE_OR_MAINTAIN')
  if (command === 'upgrade' && !values['source-database']) throw new Error('SOURCE_DATABASE_REQUIRED')
  if (values.finalize && command !== 'upgrade') throw new Error('FINALIZE_REQUIRES_UPGRADE')
  if (command === 'backfill' && !values.sqlite) throw new Error('SQLITE_SOURCE_REQUIRED')
  const since = command === 'backfill' ? parseBackfillSince(values.since) : undefined
  const timeoutMs = parseTrackingTimeout(values['timeout-ms'])
  context.stage = 'config'
  context.configPath = path.resolve(values.config ?? process.env.DSH_OPS_WEBSITE_CONFIG ?? 'config/website.json')
  const config = await loadConfig(values.config)
  const analytics = trackingAnalyticsConfig(config.analytics, timeoutMs)
  console.log(JSON.stringify({ step: 'starting', command, heapLimitMiB: Math.floor(getHeapStatistics().heap_size_limit / 1024 / 1024), requestTimeoutMs: analytics.clickhouse.requestTimeoutMs, queryTimeoutMs: analytics.queryTimeoutMs, ...(since ? { since } : {}) }))
  if (command === 'init') {
    context.stage = 'lock'
    const unlock = acquireTrackingLock(config.analyticsDirectory, 'clickhouse-init')
    const connection = analytics.clickhouse
    const client = new ClickHouseHttpClient({ ...connection, writerUser: connection.adminUser, writerPasswordEnv: connection.adminPasswordEnv })
    try {
      context.stage = 'init'
      const state = await initializeClickHouse(client)
      await grantTypedAccess(client, connection)
      console.log(JSON.stringify({ step: 'initialized', database: connection.database, uuid: state.uuid }))
    } finally { client.close(); unlock() }
    return
  }
  if (command === 'upgrade') {
    context.stage = 'upgrade'
    const { upgradeClickHouse } = await import('./upgrade.js')
    const report = await upgradeClickHouse(config.analyticsDirectory, analytics, values['source-database']!, { batchSize: Number(values['batch-size'] ?? 500), finalize: values.finalize ?? false, progress: counts => console.log(JSON.stringify({ step: 'upgrade', ...counts as object })) })
    console.log(JSON.stringify({ step: 'complete', database: analytics.clickhouse.database, ...report })); return
  }
  context.stage = command === 'maintain' ? 'maintain' : 'backfill'
  const store = new TrackingDatabase(config.analyticsDirectory, analytics)
  try {
    await store.ready
    if (command === 'maintain') { await store.maintain(); console.log(JSON.stringify({ step: 'complete', command })); return }
    // SQLite is loaded only for this explicit offline command, never by the website or init.
    await store.backend.beforeRequest(true)
    const { backfillSqlite } = await import('./backfill.js')
    const report = await backfillSqlite(path.resolve(values.sqlite!), store.backend, {
      since: since!,
      batchSize: Number(values['batch-size'] ?? 500),
      progress: counts => console.log(JSON.stringify({ step: 'backfill', ...counts })),
    })
    console.log(JSON.stringify({ step: 'complete', since, tables: report }))
  } finally { await store.close() }
}
main().catch(error => {
  console.error(JSON.stringify(trackingCommandFailure(error, context))); process.exitCode = 1
})
