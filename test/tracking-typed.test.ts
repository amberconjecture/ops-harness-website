import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout } from 'node:timers/promises'
import { integrationTest as test, createTestDatabase } from './helpers/clickhouse.js'
import { TABLE_META, rowKey, type Row, type TableName } from '../server/tracking/canonical.js'
import { initializeClickHouse } from '../server/tracking/clickhouse.js'
import { qualified } from '../server/tracking/clickhouse-schema.js'
import { event, installation } from './helpers/tracking-events.js'
import { dayAt } from '../server/tracking/types.js'
const row = (table: TableName, values: Row): Row => ({ ...Object.fromEntries(TABLE_META[table].columns.map(column => [column, null])), ...values })
const change = (table: TableName, values: Row) => { const value = row(table, values); return { table, key: rowKey(table, value), row: value } }
const DAY = 86400000

test('maintenance follows SQLite boundaries and terminal precedence, cascades runtime, and removes all versions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-retention-')), at = Date.parse('2026-10-20T06:00:00Z')
  const db = await createTestDatabase(root, () => at), date = (days: number, delta = 0) => new Date(at - days * DAY + delta).toISOString()
  try {
    await initializeClickHouse(db.backend.client) // Idempotent init preserves data and schema.
    const data = []
    for (const [table, column, days] of [['tracking_events','received_at',90],['event_dedup','received_at',120],['identity_sessions','expires_at',120]] as const) {
      for (const [id, time] of [['expired',date(days,-1)],['boundary',date(days)],['null',null]] as const) data.push(change(table, { tenant:'t', ...(table === 'identity_sessions' ? {ref:id} : {id}), [column]:time }))
    }
    for (const [id, day] of [['expired',dayAt(at - 401 * DAY)],['boundary',dayAt(at - 400 * DAY)],['null',null]] as const) {
      data.push(change('activity_facts', {tenant:'t',id,day,pending:0}))
      data.push(change('runtime_facts', {tenant:'t',id,input_tokens:10}))
    }
    const context = (time: string) => JSON.stringify({occurredAt:time})
    data.push(change('operations', {tenant:'t',installation:'i',operation:'terminal-expired',accepted:context(date(1)),terminal:context(date(120,-1))}))
    data.push(change('operations', {tenant:'t',installation:'i',operation:'terminal-boundary',accepted:context(date(121)),terminal:context(date(120))}))
    data.push(change('operations', {tenant:'t',installation:'i',operation:'accepted-expired',accepted:context(date(120,-1))}))
    data.push(change('operations', {tenant:'t',installation:'i',operation:'null'}))
    data.push(change('ingestion_health', {code:'KEEP',count:7}))
    await db.backend.commit(data)
    // Mutable date/receipt changes do not create a second business identity.
    await db.backend.commit([change('tracking_events',{tenant:'t',id:'latest-expired',received_at:date(1)})])
    await db.backend.commit([change('tracking_events',{tenant:'t',id:'latest-expired',received_at:date(91)})])
    await db.backend.commit([change('tracking_events',{tenant:'t',id:'latest-fresh',received_at:date(91)})])
    await db.backend.commit([change('tracking_events',{tenant:'t',id:'latest-fresh',received_at:date(1)})])
    assert.equal((await db.backend.rows('tracking_events')).length,5) // No query-time expiry.
    await db.maintain()
    assert.deepEqual((await db.backend.rows('tracking_events')).map(row=>row.id).sort(),['boundary','latest-fresh','null'])
    for (const table of ['event_dedup','activity_facts','runtime_facts'] as const) assert.deepEqual((await db.backend.rows(table)).map(row=>row.id).sort(),['boundary','null'])
    assert.deepEqual((await db.backend.rows('identity_sessions')).map(row=>row.ref).sort(),['boundary','null'])
    assert.deepEqual((await db.backend.rows('operations')).map(row=>row.operation).sort(),['null','terminal-boundary'])
    assert.equal((await db.backend.rows('ingestion_health'))[0]!.count,7)
    for (const table of ['tracking_events','activity_facts','runtime_facts'] as const) assert.equal((await db.backend.client.query(`SELECT count() AS n FROM ${qualified(db.backend.client.database,table)} WHERE id IN ('expired','latest-expired')`))[0]!.n,'0')
    await db.maintain()
    assert.equal((await db.backend.rows('tracking_events')).length,3)
  } finally { await db.close(); await rm(root,{recursive:true,force:true}) }
})

test('whole analytics request waits for an incomplete write and cannot see partial tables', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-gate-')), db = await createTestDatabase(root)
  let release!: () => void, entered!: () => void
  const blocked = new Promise<void>(resolve => {release=resolve}), started = new Promise<void>(resolve=>{entered=resolve})
  const insert=db.backend.client.insert.bind(db.backend.client)
  try {
    db.backend.client.insert=async(table,rows,options)=>{if(table==='activity_facts'){entered();await blocked} await insert(table,rows,options)}
    const i=installation(), write=db.ingest(i,[event(i)])
    await started
    let finished=false
    const read=db.query('health',{from:dayAt(Date.now()),to:dayAt(Date.now()),environment:'all',offset:0,limit:20}).then(value=>{finished=true;return value})
    await setTimeout(30); assert.equal(finished,false)
    release(); await write; assert.equal((await read).collected,1)
  } finally {release();await db.close();await rm(root,{recursive:true,force:true})}
})

test('global identity conflicts and orphan runtime are refused before any batch is persisted', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tracking-constraints-')), db = await createTestDatabase(root)
  try {
    await db.backend.commit([change('users',{id:'u',tenant:'t',issuer:'sso',subject:'0007'})])
    await assert.rejects(db.backend.commit([change('users',{id:'u',tenant:'other',issuer:'sso',subject:'0007'})]),/ANALYTICS_IDENTITY_CONFLICT/)
    await assert.rejects(db.backend.commit([change('users',{id:'u2',tenant:'t',issuer:'sso',subject:'0007'})]),/ANALYTICS_IDENTITY_CONFLICT/)
    await assert.rejects(db.backend.commit([change('runtime_facts',{tenant:'t',id:'missing'})]),/ANALYTICS_RUNTIME_ORPHAN/)
    assert.equal((await db.backend.rows('users')).length,1)
    assert.equal((await db.backend.rows('runtime_facts')).length,0)
  } finally {await db.close();await rm(root,{recursive:true,force:true})}
})

test('an interrupted cascade blocks readers until the persisted deletion plan completes', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'tracking-delete-recovery-')), at=Date.parse('2026-10-20T06:00:00Z'), db=await createTestDatabase(root,()=>at)
  const command=db.backend.client.command.bind(db.backend.client)
  try {
    await db.backend.commit([change('activity_facts',{tenant:'t',id:'old',day:dayAt(at-401*DAY),pending:0}),change('runtime_facts',{tenant:'t',id:'old',input_tokens:9})])
    db.backend.client.command=async(sql,params,options)=>{if(sql.startsWith('ALTER TABLE')&&sql.includes('`activity_facts`'))throw new Error('SIMULATED_DELETE_FAILURE');return command(sql,params,options)}
    await assert.rejects(db.maintain(),/SIMULATED_DELETE_FAILURE/)
    await assert.rejects(db.query('health',{from:'2025-01-01',to:'2026-10-20',environment:'all',offset:0,limit:10}),/SIMULATED_DELETE_FAILURE/)
    db.backend.client.command=command
    await db.maintain()
    assert.equal((await db.backend.rows('activity_facts')).length,0)
    assert.equal((await db.backend.rows('runtime_facts')).length,0)
  } finally {db.backend.client.command=command;await db.close();await rm(root,{recursive:true,force:true})}
})
