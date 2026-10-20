import { Worker } from 'node:worker_threads'
import type { TrackingDatabase } from './database.js'
import { AnalyticsConfigSchema, type AnalyticsConfig } from './config.js'
export class TrackingStore {
  private worker: Worker
  private sequence = 0
  private stopped = false
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  constructor(directory: string, private readonly config: AnalyticsConfig = AnalyticsConfigSchema.parse({})) {
    const source = import.meta.url.endsWith('.ts')
    // tsx's API registers TS support inside the worker for local dev. Production runs emitted JS.
    this.worker = source ? new Worker(`const { workerData } = require('node:worker_threads'); import('tsx/esm/api').then(({tsImport}) => tsImport(workerData.entry, workerData.parent));`, { eval: true, workerData: { directory, config, entry: new URL('./worker.ts', import.meta.url).href, parent: import.meta.url } }) : new Worker(new URL('./worker.js', import.meta.url), { workerData: { directory, config } })
    this.worker.on('message', ({ id, value, error }) => {
      const request = this.pending.get(id)
      if (!request) return
      clearTimeout(request.timer); this.pending.delete(id)
      if (error) request.reject(new Error(error)); else request.resolve(value)
    })
    const fail = (error?: unknown) => {
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'ANALYTICS_UNAVAILABLE'
      if (error instanceof Error) console.warn('[tracking]', JSON.stringify({ error: code, phase: 'worker' }))
      this.stopped = true
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(code)) }
      this.pending.clear()
    }
    this.worker.on('error', fail); this.worker.on('exit', fail)
  }
  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.stopped || this.pending.size >= this.config.maxQueuedRequests) return Promise.reject(new Error('ANALYTICS_BUSY'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timeout = method === 'query' || method === 'readiness' ? this.config.queryTimeoutMs : this.config.writeTimeoutMs
      const deadline = Date.now() + timeout
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('ANALYTICS_TIMEOUT')) }, timeout)
      this.pending.set(id, { resolve, reject, timer }); this.worker.postMessage({ id, method, args, deadline })
    })
  }
  ingest(...args: Parameters<TrackingDatabase['ingest']>) { return this.call<Awaited<ReturnType<TrackingDatabase['ingest']>>>('ingest', ...args) }
  identity(...args: Parameters<TrackingDatabase['identity']>) { return this.call<Awaited<ReturnType<TrackingDatabase['identity']>>>('identity', ...args) }
  query(...args: Parameters<TrackingDatabase['query']>) { return this.call<Awaited<ReturnType<TrackingDatabase['query']>>>('query', ...args) }
  maintain() { return this.call<void>('maintain') }
  readiness() { return this.call<void>('readiness') }
  async close() { try { if (!this.stopped) await this.call('close') } finally { this.stopped = true; await this.worker.terminate() } }
}
