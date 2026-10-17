import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { close } from './browser.ts'
import { cause, Fail } from './check.ts'
import { Engine } from './engine.ts'
import type { Activity, Config } from './engine.ts'
import { Job } from './job.ts'
import { log } from './log.ts'

// Why a job stopped without a result of its own.
class Gone extends Error {}    // the engine cancelled it or handed it to another worker
class Stopped extends Error {} // this worker is shutting down; the lease expiring re-dispatches it

export type Worker = { stop(): Promise<void> }

// `concurrency` slots, each claiming and running one job at a time, until stop.
export function start(c: Config): Worker {
  const engine = new Engine(c)
  const halt = new AbortController()
  let health: http.Server | undefined
  if (c.port) {
    health = http.createServer((req, res) => {
      const ok = req.method === 'GET' && req.url === '/healthz'
      res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' }).end(ok ? '{"ok":true}' : '{}')
    }).listen(c.port)
  }
  const slots = (async () => {
    await engine.namespace().catch(() => {})
    log('started', { identity: c.identity, namespace: c.namespace, queue: c.queue, concurrency: c.concurrency })
    await Promise.all(Array.from({ length: c.concurrency }, () => slot(engine, halt.signal)))
  })()
  return {
    async stop() {
      halt.abort(new Stopped('shutting down'))
      await slots
      await close()
      await new Promise<void>((resolve) => (health ? health.close(() => resolve()) : resolve()))
      log('stopped')
    },
  }
}

async function slot(engine: Engine, halt: AbortSignal): Promise<void> {
  let wait = 0
  while (!halt.aborted) {
    let a: Activity | null
    try {
      a = await engine.claim(halt)
      wait = 0
    } catch (e) {
      if (halt.aborted) return
      wait = Math.min(30_000, Math.max(1_000, wait * 2))
      log('error', { stage: 'claim', cause: cause(e), retry: wait })
      await sleep(wait * (0.75 + Math.random() / 2), undefined, { signal: halt }).catch(() => {})
      continue
    }
    if (!a) {
      await sleep(1_500, undefined, { signal: halt }).catch(() => {})
      continue
    }
    await work(engine, a, halt).catch((e) => log('error', { stage: 'work', job: `${a.workflowId}/${a.runId}`, cause: cause(e) }))
  }
}

// Runs one claimed activity to a reported end: complete, fail, or — when it was
// cancelled or the worker is stopping — nothing at all.
export async function work(engine: Engine, a: Activity, halt: AbortSignal): Promise<void> {
  const id = `${a.workflowId}/${a.runId}`
  const t0 = Date.now()
  if (a.type !== 'render') {
    const c = `no handler for job type ${a.type.slice(0, 64)}`
    await engine.fail(a, c).catch((x) => log('error', { stage: 'fail', job: id, cause: cause(x) }))
    log('failed', { job: id, cause: c })
    return
  }
  const op = String((a.input as any)?.op ?? '').slice(0, 64)
  log('claimed', { job: id, op, attempt: a.attempt })
  const ac = new AbortController()
  const stop = () => ac.abort(halt.reason)
  halt.addEventListener('abort', stop, { once: true })
  if (halt.aborted) stop()
  let dir = ''
  let job: Job | undefined
  let beating = false
  // Once at the start (a job cancelled before it was claimed ends here) and
  // every 20s after, carrying the job's progress.
  const pulse = () => {
    if (beating || !job) return
    beating = true
    engine.heartbeat(a, job.progress, job.message)
      .then((ours) => { if (!ours) ac.abort(new Gone('cancelled')) })
      .catch((e) => log('error', { stage: 'heartbeat', job: id, cause: cause(e) }))
      .finally(() => { beating = false })
  }
  const beat = setInterval(pulse, 20_000)
  let timer: NodeJS.Timeout | undefined
  try {
    dir = await mkdtemp(join(tmpdir(), 'render-'))
    job = new Job(a.input, dir, ac.signal)
    pulse()
    const limit = job.seconds
    timer = setTimeout(() => ac.abort(new Fail(`exceeded the ${limit}s time limit`)), limit * 1000)
    const result = await job.run((meta) => engine.output(a, meta))
    if (ac.signal.aborted) throw ac.signal.reason
    const status = await engine.complete(a, result)
    log(status < 300 ? 'done' : 'lost', { job: id, op, ms: Date.now() - t0, bytes: result.bytes, status })
  } catch (e) {
    const why = ac.signal.aborted ? ac.signal.reason : e
    if (why instanceof Gone) log('cancelled', { job: id, op, ms: Date.now() - t0 })
    else if (why instanceof Stopped) log('abandoned', { job: id, op, ms: Date.now() - t0 })
    else {
      const c = cause(why)
      await engine.fail(a, c).catch((x) => log('error', { stage: 'fail', job: id, cause: cause(x) }))
      log('failed', { job: id, op, ms: Date.now() - t0, cause: c })
    }
  } finally {
    clearInterval(beat)
    clearTimeout(timer)
    halt.removeEventListener('abort', stop)
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
