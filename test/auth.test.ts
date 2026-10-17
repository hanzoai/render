import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { config } from '../src/engine.ts'
import { start } from '../src/worker.ts'
import { fake } from './fake.ts'

test('the ServiceAccount token is exchanged at IAM, and again after a 401', async () => {
  const f = await fake()
  const sa = join(await mkdtemp(join(tmpdir(), 'sa-')), 'token')
  await writeFile(sa, 'sa-jwt\n')
  const w = start(config({ HANZO_API: f.url, HANZO_IAM_URL: f.url, HANZO_SA_TOKEN: sa, RENDER_CONCURRENCY: '1' }))
  try {
    while (f.hits.filter((h) => h.path.endsWith('/claim')).length < 2) await sleep(50)
    f.deny = 1
    while (f.calls('token').length < 2) await sleep(50)
    while (f.hits.filter((h) => h.path.endsWith('/claim')).length < 5) await sleep(50)
  } finally {
    await w.stop()
    await f.close()
  }
  const exchange = f.calls('token')[0]
  assert.equal(exchange.headers['content-type'], 'application/x-www-form-urlencoded')
  const lane = f.hits.filter((h) => h.path.startsWith('/v1/studio/render/'))
  assert.equal(lane[0].headers.authorization, 'Bearer iam-0')
  assert.equal(lane.at(-1)!.headers.authorization, 'Bearer iam-1', 'a 401 re-exchanges the token')
})
