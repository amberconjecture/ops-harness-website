import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseTrackingTimeout, trackingAnalyticsConfig } from '../scripts/tracking/resources.js'
import { AnalyticsConfigSchema } from '../server/tracking/config.js'
import { ClickHouseBackend, ClickHouseHttpClient, initializeClickHouse } from '../server/tracking/clickhouse.js'
import { rowKey } from '../server/tracking/canonical.js'

test('offline timeout has a bounded five-minute default and does not mutate website settings', () => {
  assert.equal(parseTrackingTimeout(undefined), 300000)
  assert.equal(parseTrackingTimeout('45000'), 45000)
  for (const value of ['0', '999', '300001', 'Infinity', 'invalid', '1000.5']) assert.throws(() => parseTrackingTimeout(value), /TRACKING_TIMEOUT_MUST_BE_1000_TO_300000_MS/)
  const online = AnalyticsConfigSchema.parse({}), original = structuredClone(online)
  const offline = trackingAnalyticsConfig(online, parseTrackingTimeout(undefined))
  assert.equal(offline.clickhouse.requestTimeoutMs, 300000)
  assert.equal(offline.queryTimeoutMs, 300000)
  assert.deepEqual(online, original)
  assert.equal(online.clickhouse.requestTimeoutMs, 30000)
  assert.equal(online.queryTimeoutMs, 60000)
  assert.equal(offline.writeTimeoutMs, online.writeTimeoutMs)
})

test('offline HTTP budget reaches commands, buffered reads and inserts', async t => {
  const variable = 'CH_RESOURCE_TEST_PASSWORD'; process.env[variable] = 'fixture-only'
  const config = AnalyticsConfigSchema.parse({ clickhouse: { writerPasswordEnv: variable, readerPasswordEnv: variable } })
  const nativeTimeout = AbortSignal.timeout, budgets: number[] = []
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { budgets.push(milliseconds); return nativeTimeout(milliseconds) })
  t.mock.method(globalThis, 'fetch', async () => new Response(''))
  try {
    for (const timeout of [300000, 45000]) {
      budgets.length = 0
      const client = new ClickHouseHttpClient(trackingAnalyticsConfig(config, timeout).clickhouse)
      try {
        await client.command('CREATE DATABASE fixture')
        await client.query('SELECT * FROM fixture.users FINAL')
        await client.insert('event_dedup', [{ tenant: 't', id: 'e', digest: 'fixture', received_at: null }])
        assert.equal(budgets.length, 3)
        assert.ok(budgets.every(value => value > timeout - 1000 && value <= timeout))
      } finally { client.close() }
    }
  } finally { delete process.env[variable] }
})

test('the package tracking command runs with a 16 GiB heap and reports the effective offline budgets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-cli-resources-'))
  try {
    const config = path.join(root, 'website.json'), variable = 'CH_UNSET_RESOURCE_FIXTURE_PASSWORD'
    await writeFile(config, JSON.stringify({ schemaVersion: 1, websiteUrl: 'http://127.0.0.1:4173', host: '127.0.0.1', port: 4173, releaseDirectory: './releases', contentDirectory: './content', analyticsDirectory: './analytics', adminPasswordEnv: 'WEBSITE_RESOURCE_FIXTURE_PASSWORD', analytics: { clickhouse: { adminPasswordEnv: variable } } }))
    const pkg = JSON.parse(await readFile('package.json', 'utf8'))
    const args: string[] = pkg.scripts.tracking.split(' ').slice(1)
    const env = { ...process.env }; delete env[variable]; delete env.NODE_OPTIONS
    for (const [extra, timeout] of [[[], 300000], [['--timeout-ms', '150000'], 150000]] as const) {
      const result = spawnSync(process.execPath, [...args, 'init', '--config', config, ...extra], { env, encoding: 'utf8' })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /CLICKHOUSE_PASSWORD_NOT_CONFIGURED/)
      const start = JSON.parse(result.stdout.trim())
      assert.equal(start.step, 'starting')
      assert.ok(start.heapLimitMiB >= 16384)
      assert.equal(start.requestTimeoutMs, timeout)
      assert.equal(start.queryTimeoutMs, timeout)
    }
    const invalid = spawnSync(process.execPath, [...args, 'init', '--config', 'missing-config.json', '--timeout-ms', '0'], { env, encoding: 'utf8' })
    assert.equal(invalid.status, 1)
    assert.equal(invalid.stdout, '')
    assert.match(invalid.stderr, /TRACKING_TIMEOUT_MUST_BE_1000_TO_300000_MS/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
