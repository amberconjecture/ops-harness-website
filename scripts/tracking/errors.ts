import { ZodError } from 'zod'
import { ClickHouseHttpError, ClickHouseTransportError } from '../../server/tracking/clickhouse-errors.js'

export type TrackingCommandContext = {
  stage: 'arguments' | 'config' | 'lock' | 'init' | 'backfill' | 'upgrade' | 'maintain'
  configPath?: string
}

const fileCodes = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EIO', 'EMFILE', 'ENFILE'])
const argumentCodes = new Set(['ERR_PARSE_ARGS_UNKNOWN_OPTION', 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE', 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL'])
const fieldName = (value: PropertyKey) => typeof value === 'number' ? String(value) : typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(value) ? value : '[redacted]'

/** Report fields and bounded codes, never configuration values, raw errors or stacks. */
export function trackingCommandFailure(error: unknown, context: TrackingCommandContext) {
  const base = { ...context }
  if (context.stage === 'config') {
    if (error instanceof ZodError) return {
      error: 'WEBSITE_CONFIG_INVALID', ...base,
      issues: error.issues.slice(0, 20).map(issue => ({
        field: issue.path.map(fieldName).join('.') || '(root)', code: issue.code,
        ...(issue.code === 'unrecognized_keys' ? { keys: issue.keys.slice(0, 20).map(fieldName) } : {}),
      })),
    }
    if (error instanceof SyntaxError) return { error: 'WEBSITE_CONFIG_INVALID_JSON', ...base }
  }
  const nativeCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (context.stage === 'config' && nativeCode === 'WEBSITE_CONFIG_LEGACY_ENV') return { error: nativeCode, ...base }
  if (typeof nativeCode === 'string' && fileCodes.has(nativeCode)) return {
    error: context.stage === 'config' ? `WEBSITE_CONFIG_${nativeCode}` : `TRACKING_FILESYSTEM_${nativeCode}`, ...base,
  }
  if (typeof nativeCode === 'string' && argumentCodes.has(nativeCode)) return { error: nativeCode, ...base }
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.message)
    ? error.message : context.stage === 'config' ? 'WEBSITE_CONFIG_LOAD_FAILED' : 'TRACKING_COMMAND_FAILED'
  const diagnostics = error instanceof ClickHouseHttpError || error instanceof ClickHouseTransportError ? error.diagnostics : undefined
  return { error: code, ...base, ...(diagnostics ? { diagnostics } : {}) }
}
