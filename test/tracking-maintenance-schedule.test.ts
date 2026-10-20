import test from 'node:test'
import assert from 'node:assert/strict'
import { scheduleTrackingMaintenance } from '../server/tracking/maintenance.js'
const flush = async () => { for(let i=0;i<5;i++) await Promise.resolve() }
test('hourly maintenance never overlaps, reports sanitized errors, and stops with the server', async t => {
  t.mock.timers.enable({apis:['setInterval']})
  let calls=0, release!:()=>void
  const errors: string[]=[]
  const store={maintain:async()=>{calls++;if(calls===1)await new Promise<void>(resolve=>{release=resolve});else throw new Error('private query payload')}}
  const stop=scheduleTrackingMaintenance(store,code=>errors.push(code))
  try {
    t.mock.timers.tick(3599999);assert.equal(calls,0)
    t.mock.timers.tick(1);assert.equal(calls,1)
    t.mock.timers.tick(7200000);assert.equal(calls,1)
    release();await flush()
    t.mock.timers.tick(3600000);await flush();assert.equal(calls,2)
    assert.deepEqual(errors,['ANALYTICS_MAINTENANCE_FAILED'])
    stop();t.mock.timers.tick(3600000);assert.equal(calls,2)
  } finally {stop()}
})
