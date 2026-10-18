import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, test } from 'node:test'
import { config } from '../src/engine.ts'
import { start } from '../src/worker.ts'
import type { Worker } from '../src/worker.ts'
import { fake, png } from './fake.ts'
import type { Fake } from './fake.ts'

let f: Fake
let w: Worker
before(async () => {
  f = await fake()
  f.files.set('lib_photo.png', { body: png(32, 32), type: 'image/png' })
  f.files.set('lib_slow.png', { body: png(32, 32), type: 'image/png', delay: 3_000 })
  w = start(config({ HANZO_API: f.url, HANZO_TOKEN: 'test-token', RENDER_IDENTITY: 'test-worker', RENDER_CONCURRENCY: '1' }))
})
after(async () => { await w.stop(); await f.close() })

const activity = (wf: string, input: unknown, type = 'render') => ({
  execution: { workflowId: wf, runId: `${wf}-run` }, type: { name: type }, taskQueue: 'render-jobs', status: 'running', attempt: 1, input,
})

async function until(ok: () => boolean, ms = 120_000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(100)
  }
}

// The calls a job made, in order, a run of heartbeats counted once (a slow box
// may take a second one).
const verbs = (wf: string) => f.hits
  .filter((h) => h.path.includes(`/${wf}/`) || h.path === `/upload/${wf}`)
  .map((h) => h.path.split('/').pop())
  .filter((v, i, all) => v !== all[i - 1])

test('claim, heartbeat, output, upload, complete', async () => {
  f.queue.push(activity('wf-ok', {
    op: 'render.html', with: { html: '<img src="asset://lib_photo"><p>hi</p>', width: 200, height: 100, title: 'Card' }, inputs: { lib_photo: f.input('lib_photo.png') },
  }))
  await until(() => f.calls('complete').length === 1)
  assert.deepEqual(verbs('wf-ok'), ['heartbeat', 'output', 'wf-ok', 'complete'])
  for (const h of f.hits.filter((x) => x.path.startsWith('/v1/'))) assert.equal(h.headers.authorization, 'Bearer test-token')
  const claim = f.hits.find((h) => h.path.endsWith('/activities/claim'))!
  assert.deepEqual(JSON.parse(claim.body.toString()), { taskQueue: 'render-jobs', identity: 'test-worker', leaseSeconds: 120 })
  const out = JSON.parse(f.calls('output')[0].body.toString())
  const uploaded = f.uploads.get('wf-ok')!
  const done = JSON.parse(f.calls('complete')[0].body.toString())
  assert.equal(done.identity, 'test-worker')
  // The output request carries what the worker measured, since the Library never
  // opens the file it is handed.
  assert.deepEqual(out, { mime: 'image/png', bytes: uploaded.length, sha256: done.result.sha256, width: 200, height: 100, name: 'Card.png' })
  assert.equal(done.result.sha256, createHash('sha256').update(uploaded).digest('hex'))
  assert.deepEqual([done.result.width, done.result.height, done.result.bytes], [200, 100, uploaded.length])
  const put = f.hits.find((h) => h.method === 'PUT')!
  assert.equal(put.headers['content-type'], 'image/png')
  assert.equal(Number(put.headers['content-length']), uploaded.length)
})

test('a cancelled job is dropped and never reported', async () => {
  f.beat = 409
  f.queue.push(activity('wf-cancel', {
    op: 'render.html', with: { html: '<img src="asset://lib_slow">', width: 100, height: 100 }, inputs: { lib_slow: f.input('lib_slow.png') },
  }))
  await until(() => f.calls('heartbeat').some((h) => h.path.includes('/wf-cancel/')))
  await sleep(4_000)
  f.beat = 200
  assert.deepEqual(verbs('wf-cancel'), ['heartbeat'])
  assert.equal(f.uploads.has('wf-cancel'), false)
})

test('bad input fails the job with a one-line cause', async () => {
  f.queue.push(activity('wf-bad', { op: 'render.html', with: { html: 'x', width: 0, height: 10 } }))
  f.queue.push(activity('wf-type', {}, 'transcode'))
  await until(() => f.calls('fail').length === 2)
  const causes = f.calls('fail').map((h) => JSON.parse(h.body.toString()))
  assert.deepEqual(causes, [
    { cause: 'width must be a number from 1 to 8192', identity: 'test-worker' },
    { cause: 'no handler for job type transcode', identity: 'test-worker' },
  ])
})

test('stopping abandons the job in flight without reporting it', async () => {
  f.queue.push(activity('wf-stop', {
    op: 'render.html', with: { html: '<img src="asset://lib_slow">', width: 100, height: 100 }, inputs: { lib_slow: f.input('lib_slow.png') },
  }))
  await until(() => f.calls('heartbeat').some((h) => h.path.includes('/wf-stop/')))
  await w.stop()
  await sleep(500)
  assert.deepEqual(verbs('wf-stop'), ['heartbeat'])
})
