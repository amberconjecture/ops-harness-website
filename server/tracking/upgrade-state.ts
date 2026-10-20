import { TABLES, type TableName } from './canonical.js'
import { readPrivateJson } from './durable-file.js'

export const MAX_CUTOVER_LAG_MS = 5 * 60 * 1000
export type UpgradeCounts = { read: number; written: number; deleted: number; expired: number }
export type UpgradeTables = Partial<Record<TableName, UpgradeCounts>>
export type UpgradePosition = { seq: number; observedAt: string }
export type UpgradeRound = {
  mode: 'baseline' | 'incremental'; fromSeq: number; through: UpgradePosition
  tableIndex: number; cursor: string; cursorSeq: number; tables: UpgradeTables
}
export type UpgradeCheckpoint = {
  format: 2; binding: string; target: string
  phase: 'copying' | 'ready' | 'armed' | 'active'
  applied: UpgradePosition | null; round: UpgradeRound | null; rounds: number
  lastRound: { mode: UpgradeRound['mode']; fromSeq: number; throughSeq: number; tables: UpgradeTables } | null
  activatedAt: string | null
}
export const sequence = (value: unknown) => {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('INVALID_ANALYTICS_SEQUENCE')
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('INVALID_ANALYTICS_SEQUENCE')
  return result
}
export function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('ANALYTICS_UPGRADE_INVALID_TIME')
  return new Date(value).toISOString()
}
export function cutoverLag(observedAt: string, now: string) {
  const lag = Date.parse(timestamp(now)) - Date.parse(timestamp(observedAt))
  if (lag < 0 || lag > MAX_CUTOVER_LAG_MS) throw new Error('ANALYTICS_UPGRADE_CATCHUP_REQUIRED')
  return lag
}
export function readUpgradeCheckpoint(file: string): UpgradeCheckpoint {
  const value = readPrivateJson(file) as UpgradeCheckpoint
  if (value?.format !== 2) throw new Error('ANALYTICS_UPGRADE_CHECKPOINT_OBSOLETE_USE_NEW_TARGET')
  const tables = (rows: UpgradeTables) => {
    if (!rows || typeof rows !== 'object') throw new Error('ANALYTICS_UPGRADE_INVALID_CHECKPOINT')
    for (const [table, counts] of Object.entries(rows)) {
      if (!TABLES.includes(table as TableName) || !counts || ['read', 'written', 'deleted', 'expired'].some(key => !Number.isSafeInteger(counts[key as keyof UpgradeCounts]) || counts[key as keyof UpgradeCounts] < 0)) throw new Error('ANALYTICS_UPGRADE_INVALID_CHECKPOINT')
    }
  }
  if (typeof value.binding !== 'string' || typeof value.target !== 'string' || !['copying', 'ready', 'armed', 'active'].includes(value.phase) || !Number.isSafeInteger(value.rounds) || value.rounds < 0) throw new Error('ANALYTICS_UPGRADE_INVALID_CHECKPOINT')
  if (value.applied) { sequence(value.applied.seq); timestamp(value.applied.observedAt) }
  if (value.round) {
    const round = value.round
    sequence(round.fromSeq); sequence(round.through.seq); sequence(round.cursorSeq); timestamp(round.through.observedAt); tables(round.tables)
    if (!['baseline', 'incremental'].includes(round.mode) || typeof round.cursor !== 'string' || !Number.isInteger(round.tableIndex) || round.tableIndex < 0 || round.tableIndex > TABLES.length || round.fromSeq > round.cursorSeq || round.cursorSeq > round.through.seq) throw new Error('ANALYTICS_UPGRADE_INVALID_CHECKPOINT')
    if ((round.mode === 'baseline' && value.applied) || (round.mode === 'incremental' && round.fromSeq !== value.applied?.seq)) throw new Error('ANALYTICS_UPGRADE_INVALID_CHECKPOINT')
  }
  if ((value.phase === 'copying') !== Boolean(value.round) || (value.phase !== 'copying' && !value.applied)) throw new Error('ANALYTICS_UPGRADE_INVALID_CHECKPOINT')
  if (value.lastRound) tables(value.lastRound.tables)
  if (value.phase === 'active') timestamp(value.activatedAt)
  return value
}
