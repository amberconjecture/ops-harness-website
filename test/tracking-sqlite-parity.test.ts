import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { integrationTest as test, createTestDatabase } from './helpers/clickhouse.js'
import { TrackingDatabase as SqliteDatabase } from './fixtures/sqlite-v3-database.js'
import { TABLES, rowKey, canonical, type Row } from '../server/tracking/canonical.js'
import { event, installation } from './helpers/tracking-events.js'

// Frozen SQLite v3 source: da75d733891a38ed936aa182f37e91aa734cb291:server/tracking/database.ts.
// It is only imported by this differential test, never by the application.
test('all nine analytics APIs match the original SQLite implementation before and after retention', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'tracking-sqlite-parity-'))
  let at=Date.parse('2026-10-20T06:00:00Z')
  const sqlite=new SqliteDatabase(path.join(root,'old'),()=>at), target=await createTestDatabase(path.join(root,'new'),()=>at)
  const source=new DatabaseSync(path.join(root,'old','analytics.sqlite'))
  try {
    const a=installation(), b={...installation(),environment:'development' as const}
    const accepted=event(a,{occurredAt:new Date(at).toISOString(),durationMs:0.125})
    const terminal={...accepted,eventId:randomUUID(),eventName:'operation.finished' as const,outcome:'succeeded' as const,changed:true}
    sqlite.ingest(a,[terminal]);sqlite.ingest(a,[accepted])
    sqlite.ingest(b,[event(b,{occurredAt:new Date(at).toISOString(),platform:'win32',appVersion:'0.2.0'})])
    const {action,operationId,...base}=event(a,{occurredAt:new Date(at).toISOString()})
    const context={conversationId:'a'.repeat(64),turn:1,sessionKind:'root'}
    sqlite.ingest(a,[{...base,eventName:'conversation.message.accepted',feature:'conversation',properties:context},
      {...base,eventId:randomUUID(),eventName:'conversation.model.usage',feature:'conversation',properties:{...context,step:1,provider:'test',model:'mock',usageReported:true,inputTokens:10,outputTokens:2,cacheReadTokens:5,cacheWriteTokens:0,reasoningTokens:1}},
      {...base,eventId:randomUUID(),eventName:'skill.load.completed',feature:'skills',properties:{...context,step:1,skillName:'test-skill',method:'model',result:'succeeded'}}])
    const anonymous={...base,eventId:randomUUID(),employee:undefined,eventName:'page.view' as const,properties:{pageKey:'tool-market'}}
    sqlite.ingest(a,[anonymous,{invalid:true}])
    for(const table of TABLES) {
      const rows=source.prepare(`SELECT * FROM ${table}`).all() as Row[]
      await target.backend.commit(rows.map(row=>({table,key:rowKey(table,row),row})))
    }
    const q={from:'2026-10-01',to:'2026-10-20',environment:'all',offset:0,limit:100}
    const userId=String(source.prepare('SELECT id FROM users LIMIT 1').get()!.id)
    const filters=[q,{...q,environment:'test'},{...q,environment:'development'},{...q,platform:'win32'},{...q,userId},{...q,appVersion:'missing'}]
    const kinds=['overview','trends','users','rankings','features','operations','health','conversations','skills']
    const normalize=(value:any)=>{const result=JSON.parse(JSON.stringify(value));if(Array.isArray(result.rows))result.rows.sort((a:any,b:any)=>canonical(a).localeCompare(canonical(b)));return result}
    const compare=async()=>{for(const filter of filters)for(const kind of kinds)assert.deepEqual(normalize(await target.query(kind,filter)),normalize(sqlite.query(kind,filter)),`${kind}: ${JSON.stringify(filter)}`)}
    await compare()
    at+=100*86400000;sqlite.maintain();await target.maintain();await compare()
    at+=301*86400000;sqlite.maintain();await target.maintain();await compare()
  } finally {source.close();sqlite.close();await target.close();await rm(root,{recursive:true,force:true})}
})
