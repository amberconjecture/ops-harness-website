import test, { after, type TestFn } from 'node:test'
import { randomUUID } from 'node:crypto'
import { AnalyticsConfigSchema, type AnalyticsConfig } from '../../server/tracking/config.js'
import { ClickHouseHttpClient, initializeClickHouse } from '../../server/tracking/clickhouse.js'
import { TrackingDatabase } from '../../server/tracking/database.js'
import { TrackingStore } from '../../server/tracking/store.js'
import { identifier } from '../../server/tracking/clickhouse-schema.js'

export const integrationTest = (name: string, fn: TestFn) => test(name, { skip: !process.env.CH_TEST_URL && 'Set CH_TEST_URL to run against an isolated real ClickHouse database' }, fn)
const databases: { client: ClickHouseHttpClient; database: string }[] = []
const configs = new Map<string, AnalyticsConfig>()
after(async () => {
  for (const { client, database } of databases) {
    try { await client.command(`DROP DATABASE ${identifier(database)} SYNC`, {}, { database: 'default' }) } finally { client.close() }
  }
})
export async function prepareTestDatabase(directory: string) {
  if (configs.has(directory)) return configs.get(directory)!
  if (!process.env.CH_TEST_URL) throw new Error('CH_TEST_URL_REQUIRED')
  process.env.CH_TEST_PASSWORD ??= ''
  const database = `website_test_${randomUUID().replaceAll('-', '')}`
  const user = process.env.CH_TEST_USER ?? 'default'
  const config = AnalyticsConfigSchema.parse({ clickhouse: {
    url: process.env.CH_TEST_URL, database, writerUser: user, readerUser: user, adminUser: user,
    writerPasswordEnv: 'CH_TEST_PASSWORD', readerPasswordEnv: 'CH_TEST_PASSWORD', adminPasswordEnv: 'CH_TEST_PASSWORD',
  } })
  const client = new ClickHouseHttpClient(config.clickhouse)
  databases.push({ client, database })
  await initializeClickHouse(client)
  configs.set(directory, config)
  return config
}
export async function createTestDatabase(directory: string, now = Date.now) {
  const db = new TrackingDatabase(directory, await prepareTestDatabase(directory), now)
  await db.ready
  return db
}
export async function createTestStore(directory: string) {
  const store = new TrackingStore(directory, await prepareTestDatabase(directory))
  try { await store.maintain(); return store } catch (error) { await store.close(); throw error }
}
