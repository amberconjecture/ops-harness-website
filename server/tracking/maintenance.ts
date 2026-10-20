/** One hourly run at a time; the store itself serializes maintenance with complete requests. */
export function scheduleTrackingMaintenance(store: { maintain(): Promise<void> }, report: (code: string) => void, intervalMs = 3600000) {
  let running = false, stopped = false
  const timer = setInterval(() => {
    if (running || stopped) return
    running = true
    void store.maintain().catch(error => report(error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'ANALYTICS_MAINTENANCE_FAILED')).finally(() => { running = false })
  }, intervalMs)
  timer.unref()
  return () => { stopped = true; clearInterval(timer) }
}
