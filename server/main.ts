import { scheduleTrackingMaintenance } from './tracking/maintenance.js'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createHandler } from './app.js'
import { loadConfig } from './config.js'
import { readAdminPassword } from './guide-config.js'
import { GuideStore } from './guide-store.js'
import { MediaStore } from './media-store.js'
import { ReleaseAdmin } from './release-admin.js'
import { KnowledgeStore } from './knowledge-store.js'
import { ExpertStore } from './expert-store.js'
import { createAdminHandler } from './admin-http.js'
import { createGuideHandler } from './guide-http.js'
import { TrackingStore } from './tracking/store.js'
import { createTrackingHandlers } from './tracking/http.js'
import { ContentSync } from './content-sync.js'
import { VideoStore } from './videos-store.js'
import { createVideoHandler } from './videos-http.js'

const config = await loadConfig()
const dev = process.argv.includes('--dev')
// Vditor loads its fixed icon script as inline text. Permit only the shipped bytes.
const adminIconHash = dev ? undefined : createHash('sha256').update(await readFile('dist/client/assets/vendor/vditor-4.0.0/dist/js/icons/ant.js')).digest('base64')
const password = readAdminPassword(config, dev)
const seedContent = path.resolve(dev ? 'content' : 'dist/content')
const media = new MediaStore(config.contentDirectory, seedContent)
const guides = new GuideStore(path.join(seedContent, 'guide'), config.contentDirectory)
const sync = new ContentSync(guides, media, path.resolve('content'))
const knowledge = new KnowledgeStore(config.contentDirectory)
const experts = new ExpertStore(config.contentDirectory, knowledge)
const videos = new VideoStore(config.contentDirectory)
const videoApi = createVideoHandler(videos)
const analytics = new TrackingStore(config.analyticsDirectory, config.analytics)
const tracking = createTrackingHandlers(analytics, { enabled: config.trackingEnabled, defaultEnvironment: dev ? 'development' : 'production' })
const contentAdmin = createAdminHandler(new ReleaseAdmin(config.releaseDirectory), media, sync, knowledge, experts, videos)
await analytics.maintain()
const stopMaintenance = scheduleTrackingMaintenance(analytics, error => console.warn('[tracking]', JSON.stringify({ phase: 'maintenance', error })))
const guideApi = await createGuideHandler(guides, { origin: config.websiteUrl, password, admin: async (...args) => await tracking.admin(...args) || await contentAdmin(...args) })
const guide: typeof guideApi = async (req, res, url) => await tracking.collect(req, res, url) || await videoApi(req, res, url) || await media.serve(req, res, url) || await guideApi(req, res, url)
const server = createServer()
const vite = dev ? await (await import('vite')).createServer({
  server: { middlewareMode: true, hmr: { server } }, appType: 'spa',
}) : undefined
server.on('request', createHandler(config, {
  clientRoot: path.resolve('dist/client'),
  guide,
  knowledge,
  experts,
  ...(adminIconHash ? { adminIconHash } : {}),
  ...(vite ? { dev: vite.middlewares } : {}),
  onError: error => console.error('[website] request failed:', error instanceof Error ? error.name : 'UnknownError'),
}))
server.requestTimeout = 30 * 60 * 1000
server.headersTimeout = 15_000
server.keepAliveTimeout = 5_000
server.on('error', error => { console.error('[website] server failed:', error.message); process.exitCode = 1 })
server.listen(config.port, config.host, () => {
  console.log(`Website: http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port}`)
  console.log(`Public website URL: ${config.websiteUrl}`)
  console.log(`Release directory: ${config.releaseDirectory}`)
  console.log(`[tracking] collection=${tracking.configured ? 'enabled' : 'disabled'} scope=host authentication=none endpoint=/api/tracking/v1/events:batch`)
})
let closing = false
async function close() {
  if (closing) return
  closing = true
  const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1) }, 5000)
  deadline.unref()
  stopMaintenance()
  await analytics.close()
  await vite?.close()
  server.close(() => { clearTimeout(deadline) })
  server.closeIdleConnections()
}
process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())
