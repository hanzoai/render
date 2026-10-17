import { cause } from './check.ts'
import { config } from './engine.ts'
import { log } from './log.ts'
import { start } from './worker.ts'

const w = start(config(process.env))
let stopping = false
for (const s of ['SIGTERM', 'SIGINT'] as const) {
  process.on(s, () => {
    if (stopping) return
    stopping = true
    log('stopping', { signal: s })
    w.stop().then(() => process.exit(0), (e) => { log('error', { stage: 'stop', cause: cause(e) }); process.exit(1) })
  })
}
