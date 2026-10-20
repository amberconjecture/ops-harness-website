import { randomUUID } from 'node:crypto'
import type { AnalyticsConfig } from './config.js'
import type { QueryParams } from './clickhouse-query.js'
import { identifier, qualified } from './clickhouse-schema.js'
import { ClickHouseHttpError, ClickHouseTransportError, transportFailure, type ClickHouseOperation, type RequestContext } from './clickhouse-errors.js'

type HttpOptions = { timeoutMs?: number; database?: string; queryId?: string; deadline?: number; operation?: ClickHouseOperation; retryOnConnectionLoss?: boolean; attempt?: number }
type HttpConnection = Pick<AnalyticsConfig['clickhouse'], 'url' | 'database' | 'writerUser' | 'writerPasswordEnv' | 'readerUser' | 'readerPasswordEnv' | 'requestTimeoutMs'>
function arrayParameter(values: string[]): string {
  return `[${values.map(value => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t').replaceAll('\0', '\\0')}'`).join(',')}]`
}
export class ClickHouseHttpClient {
  private readonly stopped = new AbortController()
  private readonly url: URL
  readonly database: string
  constructor(private readonly config: HttpConnection, private readonly role: 'writer' | 'reader' = 'writer') {
    this.url = new URL(config.url)
    if (!['http:', 'https:'].includes(this.url.protocol) || this.url.username || this.url.password || this.url.search || this.url.hash) throw new Error('INVALID_CLICKHOUSE_URL')
    identifier(config.database)
    this.database = config.database
  }
  private async request(sql: string, params: QueryParams, options: HttpOptions = {}, data?: string) {
    const started = Date.now()
    const user = this.role === 'writer' ? this.config.writerUser : this.config.readerUser
    const passwordEnv = this.role === 'writer' ? this.config.writerPasswordEnv : this.config.readerPasswordEnv
    const password = process.env[passwordEnv]
    if (password === undefined) throw new Error('CLICKHOUSE_PASSWORD_NOT_CONFIGURED')
    const timeoutMs = Math.min(options.timeoutMs ?? this.config.requestTimeoutMs, (options.deadline ?? Infinity) - Date.now())
    if (timeoutMs <= 0) throw new Error('ANALYTICS_QUERY_TIMEOUT')
    const url = new URL(this.url)
    url.searchParams.set('database', options.database ?? this.database)
    url.searchParams.set('date_time_input_format', 'best_effort')
    url.searchParams.set('date_time_output_format', 'iso')
    url.searchParams.set('optimize_move_to_prewhere_if_final', '0')
    url.searchParams.set('input_format_null_as_default', '0')
    url.searchParams.set('input_format_skip_unknown_fields', '0')
    url.searchParams.set('output_format_json_quote_64bit_integers', '1')
    url.searchParams.set('join_use_nulls', '1')
    url.searchParams.set('async_insert', '0')
    url.searchParams.set('wait_end_of_query', '1')
    url.searchParams.set('input_format_parallel_parsing', '0')
    url.searchParams.set('max_insert_block_size', '1000000')
    url.searchParams.set('max_insert_block_size_bytes', '0')
    const queryId = options.queryId ?? randomUUID()
    url.searchParams.set('query_id', queryId)
    for (const [name, value] of Object.entries(params)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error('INVALID_CLICKHOUSE_PARAMETER')
      if (Array.isArray(value) ? value.some(item => typeof item !== 'string') : !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('INVALID_CLICKHOUSE_PARAMETER')
      url.searchParams.set(`param_${name}`, Array.isArray(value) ? arrayParameter(value as string[]) : String(value))
    }
    if (data !== undefined) url.searchParams.set('query', sql)
    const signal = AbortSignal.any([this.stopped.signal, AbortSignal.timeout(timeoutMs)])
    const context = (phase: RequestContext['phase']): RequestContext => ({ phase, operation: options.operation ?? 'query', queryId, requestElapsedMs: Date.now() - started, attempt: options.attempt ?? 1 })
    const failure = (error: unknown, phase: RequestContext['phase']) => transportFailure(error, signal, context(phase))
    let response: Response
    try {
      response = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'X-ClickHouse-User': user, 'X-ClickHouse-Key': password, 'Content-Type': 'text/plain; charset=utf-8', ...((options.attempt ?? 1) > 1 ? { Connection: 'close' } : {}) }, body: data ?? sql, signal })
    } catch (error) { throw failure(error, 'headers') }
    if (!response.ok) {
      // Server diagnostics may contain rows or credentials. Never forward its body to ordinary logs.
      const error = new ClickHouseHttpError(response.status, response.headers.get('x-clickhouse-exception-code'), context('headers'))
      await response.body?.cancel().catch(() => {})
      throw error
    }
    return { response, failure }
  }
  async text(sql: string, params: QueryParams = {}, options: HttpOptions = {}): Promise<string> {
    const { response, failure } = await this.request(sql, params, { ...options, operation: options.operation ?? 'command' })
    return response.text().catch(error => { throw failure(error, 'body') })
  }
  async command(sql: string, params: QueryParams = {}, options: HttpOptions = {}): Promise<void> {
    const body = await this.text(sql, params, options)
    // A late exception can be delivered after HTTP headers. DDL commands have an empty success body.
    if (body.trim()) throw new Error('CLICKHOUSE_COMMAND_FAILED')
  }
  async *iterate(sql: string, params: QueryParams = {}, options: HttpOptions = {}): AsyncGenerator<Record<string, unknown>> {
    const { response, failure } = await this.request(`${sql}\nFORMAT JSONEachRow`, params, options)
    if (!response.body) throw new Error('CLICKHOUSE_EMPTY_RESPONSE')
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let pending = ''
    try {
      while (true) {
        const { done, value } = await reader.read().catch(error => { throw failure(error, 'body') })
        pending += decoder.decode(value, { stream: !done })
        let newline: number
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
          if (line.trim()) yield parseResponseLine(line)
        }
        if (pending.length > 16 * 1024 * 1024) throw new Error('CLICKHOUSE_RESPONSE_ROW_TOO_LARGE')
        if (done) break
      }
      if (pending.trim()) yield parseResponseLine(pending)
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
  async query(sql: string, params: QueryParams = {}, options: HttpOptions = {}): Promise<Record<string, unknown>[]> {
    const deadline = Math.min(options.deadline ?? Infinity, Date.now() + (options.timeoutMs ?? this.config.requestTimeoutMs))
    for (let attempt = 1; ; attempt++) {
      try {
        const rows: Record<string, unknown>[] = []
        for await (const row of this.iterate(sql, params, { ...options, deadline, attempt })) rows.push(row)
        return rows
      } catch (error) {
        // Only explicit, fully buffered reads can be replayed. Commands and a
        // streaming export never retry after an unknown result or yielded row.
        if (!options.retryOnConnectionLoss || attempt !== 1 || !(error instanceof ClickHouseTransportError) || !error.retryableRead || Date.now() >= deadline || this.stopped.signal.aborted) throw error
        console.warn(JSON.stringify({ step: 'clickhouse_read_retry', error: error.message, ...error.diagnostics }))
      }
    }
  }
  async insert(table: string, rows: readonly Record<string, unknown>[], options: HttpOptions = {}): Promise<void> {
    if (!rows.length) return
    await this.command(`INSERT INTO ${qualified(this.database, table)} FORMAT JSONEachRow\n${rows.map(row => JSON.stringify(row)).join('\n')}\n`, {}, options)
  }
  close() { this.stopped.abort() }
}
function parseResponseLine(line: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(line)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch { throw new Error('CLICKHOUSE_INVALID_RESPONSE') }
}
