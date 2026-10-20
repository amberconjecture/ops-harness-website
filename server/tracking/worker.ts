import { parentPort, workerData } from 'node:worker_threads'
import { TrackingDatabase } from './database.js'
const db = new TrackingDatabase(workerData.directory, workerData.config)
parentPort!.on('message', async ({ id, method, args, deadline }) => {
  try {
    const value = await (method === 'ingest' ? db.ingest(args[0], args[1], deadline) : method === 'identity' ? db.identity(args[0], args[1], deadline) : method === 'query' ? db.query(args[0], args[1]) : method === 'maintain' ? db.maintain() : method === 'readiness' ? db.readiness() : method === 'close' ? db.close() : undefined)
    parentPort!.postMessage({ id, value })
    if (method === 'close') parentPort!.close()
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'ANALYTICS_UNAVAILABLE'
    const diagnostics = error && typeof error === 'object' && 'diagnostics' in error ? error.diagnostics : undefined
    console.warn('[tracking]', JSON.stringify({ method, error: code, ...(diagnostics ? { diagnostics } : {}) }))
    parentPort!.postMessage({ id, error: code })
  }
})
