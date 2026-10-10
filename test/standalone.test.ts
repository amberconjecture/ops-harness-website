import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { readFile, mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../server/config.js'

const externalConfig = { schemaVersion: 1, websiteUrl: 'http://127.0.0.1:4197', host: '127.0.0.1', port: 4197, releaseDirectory: '../data/packages', contentDirectory: '../data/docs', adminPasswordEnv: 'DSH_OPS_WEBSITE_ADMIN_PASSWORD' }

test('standalone defaults and external configuration keep state relative to their own config', async t => {
  const project = fileURLToPath(new URL('../', import.meta.url))
  const keys = ['DSH_OPS_WEBSITE_CONFIG', 'DSH_OPS_RELEASE_CONFIG', 'DSH_OPS_WEBSITE_CONTENT_CONFIG']
  const previous = keys.map(key => process.env[key])
  keys.forEach(key => { delete process.env[key] })
  t.after(() => keys.forEach((key, index) => {
    const value = previous[index]
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }))
  assert.deepEqual(await readdir(path.join(project, 'config')), ['website.json'])
  const defaults = await loadConfig()
  assert.equal(defaults.configPath, path.join(project, 'config/website.json'))
  assert.equal(defaults.releaseDirectory, path.join(project, '.runtime/website-releases'))
  assert.equal(defaults.contentDirectory, path.join(project, '.runtime/website-content'))
  assert.equal(defaults.adminPasswordEnv, 'DSH_OPS_WEBSITE_ADMIN_PASSWORD')
  assert.equal(defaults.trackingEnabled, true)
  const root = await mkdtemp(path.join(tmpdir(), 'standalone website '))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'config'))
  const website = path.join(root, 'config/website.json')
  await writeFile(website, '\uFEFF' + JSON.stringify(externalConfig))
  for (const key of ['DSH_OPS_RELEASE_CONFIG', 'DSH_OPS_WEBSITE_CONTENT_CONFIG']) {
    process.env[key] = 'obsolete.json'
    await assert.rejects(loadConfig(), /Set DSH_OPS_WEBSITE_CONFIG/)
    delete process.env[key]
  }
  process.env.DSH_OPS_WEBSITE_CONFIG = website
  const config = await loadConfig()
  assert.equal(config.releaseDirectory, path.join(root, 'data/packages'))
  assert.equal(config.contentDirectory, path.join(root, 'data/docs'))
  assert.equal(config.websiteUrl, externalConfig.websiteUrl)
  assert.equal(config.port, externalConfig.port)
  assert.equal(config.trackingEnabled, false)
  const explicit = path.join(root, 'explicit.json'), releases = path.join(root, 'absolute releases'), content = path.join(root, 'absolute docs')
  await writeFile(explicit, JSON.stringify({ ...externalConfig, releaseDirectory: releases, contentDirectory: content }))
  const selected = await loadConfig(explicit)
  assert.equal(selected.configPath, explicit)
  assert.equal(selected.releaseDirectory, releases)
  assert.equal(selected.contentDirectory, content)
})

test('unified configuration preserves strict release and content validation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'website-config-validation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configPath = path.join(root, 'website.json')
  for (const websiteUrl of [
    'http://7.192.170.132:4173/', 'http://192.168.1.20:4173', 'http://intranet.example:80/',
    'http://intranet.example:443/', 'http://[fd00::1]:4173/', 'https://EXAMPLE.com:443/',
  ]) {
    await writeFile(configPath, JSON.stringify({ ...externalConfig, websiteUrl }))
    assert.equal((await loadConfig(configPath)).websiteUrl, new URL(websiteUrl).origin)
  }
  for (const invalid of [
    { schemaVersion: 2 }, { websiteUrl: 'ftp://example.com' }, { websiteUrl: 'https://example.com/guide' },
    { websiteUrl: 'http://7.192.170.132:4173/guide' }, { websiteUrl: 'http://user:pass@example.com' },
    { websiteUrl: 'http://example.com?query=1' }, { websiteUrl: 'http://example.com#fragment' },
    { websiteUrl: '[http://example.com](http://example.com)' }, { websiteUrl: '7.192.170.132:4173' },
    { websiteUrl: 'https://user:pass@example.com' }, { websiteUrl: 'https://example.com?query=1' },
    { websiteUrl: 'https://example.com#fragment' }, { websiteUrl: 'http://' + 'a'.repeat(2048) },
    { port: 0 }, { releaseDirectory: '' }, { contentDirectory: undefined }, { contentDirectory: '  ' },
    { adminPasswordEnv: undefined }, { adminPasswordEnv: 'invalid-name' }, { password: 'must-not-be-stored' }, { trackingEnabled: 'true' }, { trackingDevelopment: true },
  ]) {
    await writeFile(configPath, JSON.stringify({ ...externalConfig, ...invalid }))
    await assert.rejects(loadConfig(configPath))
  }
  await writeFile(configPath, '{')
  await assert.rejects(loadConfig(configPath), SyntaxError)
})

test('release CLI uses unified environment configuration and an explicit override without loading administrator credentials', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'website-cli-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = fileURLToPath(new URL('../', import.meta.url))
  const envConfig = path.join(root, 'environment.json'), explicitConfig = path.join(root, 'explicit.json')
  await writeFile(envConfig, JSON.stringify({ ...externalConfig, websiteUrl: 'http://7.192.170.132:4173', releaseDirectory: 'env-releases', contentDirectory: 'docs' }))
  await writeFile(explicitConfig, JSON.stringify({ ...externalConfig, releaseDirectory: 'explicit-releases', contentDirectory: 'docs' }))
  const input = path.join(root, 'input'), notes = path.join(root, 'notes.json')
  await mkdir(input)
  await writeFile(path.join(input, 'WiseOperation Assistant Setup 9.9.9.exe'), 'isolated test fixture')
  await writeFile(notes, JSON.stringify({ title: '配置测试', notes: ['隔离的 CLI 配置验收'] }))
  const args = ['--import', 'tsx', 'scripts/publish-release.ts', '--version', '9.9.9', '--platform', 'windows-x64', '--input', input, '--notes', notes]
  const options = { cwd: project, env: { ...process.env, DSH_OPS_WEBSITE_CONFIG: envConfig, DSH_OPS_WEBSITE_ADMIN_PASSWORD: 'short' }, timeout: 30_000 }
  await promisify(execFile)(process.execPath, args, options)
  await promisify(execFile)(process.execPath, [...args, '--config', explicitConfig], options)
  for (const directory of ['env-releases', 'explicit-releases']) {
    const catalog = JSON.parse(await readFile(path.join(root, directory, 'catalog.json'), 'utf8'))
    assert.equal(catalog.releases[0].version, '9.9.9')
  }
  await assert.rejects(readFile(path.join(root, 'docs/guide/current/start.md')), { code: 'ENOENT' })
})

test('bundled release contract matches its provenance and installed package', async () => {
  const record = JSON.parse(await readFile(new URL('../vendor/release-contract.json', import.meta.url), 'utf8'))
  const bytes = await readFile(new URL(`../vendor/${record.artifact}`, import.meta.url))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256)
  const source = new URL('../node_modules/@dsh-ops/release-contract/', import.meta.url)
  const installed = JSON.parse(await readFile(new URL('package.json', source), 'utf8'))
  assert.equal(installed.name, record.name)
  assert.equal(installed.version, record.version)
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dependencies[record.name], `file:vendor/${record.artifact}`)
})

test('bundled tracking contract matches its provenance and contains no DSH import in the pure entry', async () => {
  const provenance = JSON.parse(await readFile(new URL('../vendor/tracking.json', import.meta.url), 'utf8'))
  const artifact = await readFile(new URL(`../vendor/${provenance.artifact}`, import.meta.url))
  assert.equal(createHash('sha256').update(artifact).digest('hex'), provenance.sha256)
  const contracts = await import('@dsh-ops/tracking-contract')
  assert.equal(contracts.CATALOG_VERSION, provenance.protocolCatalogVersion)
  assert.equal(contracts.CATALOG_VERSION, 4)
  assert.equal(contracts.featureFor('page.view', undefined, { pageKey: 'tool-market' }), 'tools')
  const manifest = JSON.parse(await readFile(new URL('../node_modules/@dsh-ops/tracking-contract/package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.name, provenance.name)
  assert.equal(manifest.version, provenance.version)
  assert.deepEqual(manifest.dependencies, { zod: '4.4.3' })
  assert.equal(manifest.peerDependencies, undefined)
  const website = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(website.dependencies[provenance.name], `file:vendor/${provenance.artifact}`)
  assert.equal(website.dependencies['@dsh-ops/tracking'], undefined)
  const source = await readFile(new URL('../node_modules/@dsh-ops/tracking-contract/lib/index.js', import.meta.url), 'utf8')
  assert.equal(/(?:@deepseek-ai|cordis|node:|host-fs|host-connection)/.test(source), false)
})

test('bundled expert distribution contract matches its provenance and installed package', async () => {
  const record = JSON.parse(await readFile(new URL('../vendor/expert-distribution-contract.json', import.meta.url), 'utf8'))
  const bytes = await readFile(new URL(`../vendor/${record.artifact}`, import.meta.url))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256)
  assert.ok(record.artifact.endsWith(`-${record.sha256.slice(0, 12)}.tgz`))
  const installed = JSON.parse(await readFile(new URL('../node_modules/@dsh-ops/expert-distribution-contract/package.json', import.meta.url), 'utf8'))
  assert.equal(installed.name, record.name)
  assert.equal(installed.version, record.version)
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dependencies[record.name], `file:vendor/${record.artifact}`)
  const contract = await import('@dsh-ops/expert-distribution-contract')
  assert.equal(contract.CONTRACT_VERSION, record.contractVersion)
  // 0.1.1: scenarios, the built-in expert list and the features header; the scenario helpers load without zod.
  assert.equal(contract.SCENARIO_LIMITS.perExpert, 8)
  assert.deepEqual(contract.BUILTIN_EXPERTS.map(expert => expert.id), ['product-default', 'data-analyst', 'push-expert', 'marketing-compliance', 'browser-content-compliance'])
  assert.equal(contract.EXPERT_FEATURES_HEADER, 'x-ops-expert-features')
  const scenarios = await import('@dsh-ops/expert-distribution-contract/scenarios')
  assert.equal(scenarios.scenarioIssues([{ id: 'a', title: '场景', prompt: '提问' }]).length, 0)
})
