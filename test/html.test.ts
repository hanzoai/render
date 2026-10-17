import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, test } from 'node:test'
import { close } from '../src/browser.ts'
import { dims } from '../src/measure.ts'
import { boxes, fake, perform, png } from './fake.ts'
import type { Fake } from './fake.ts'

let f: Fake
before(async () => {
  f = await fake()
  f.files.set('lib_photo.png', { body: png(64, 48), type: 'image/png' })
})
after(async () => { await close(); await f.close() })

const DESIGN = `<!doctype html><html><head><style>
html,body{margin:0;width:1080px;height:1350px;background:#0a0a0a;color:#fafafa;font:64px Inter,sans-serif}
img{width:540px;display:block}</style></head>
<body><h1>Poster</h1><img src="asset://lib_photo"></body></html>`

test('render.html png is exactly width × height', async () => {
  const { result, body } = await perform(f, {
    op: 'render.html', with: { html: DESIGN, width: 1080, height: 1350 }, inputs: { lib_photo: f.input('lib_photo.png') },
  })
  assert.deepEqual(dims(body), { width: 1080, height: 1350 })
  assert.equal(result.mime, 'image/png')
  assert.equal(result.width, 1080)
  assert.equal(result.height, 1350)
  assert.equal(result.bytes, body.length)
  assert.equal(result.sha256, createHash('sha256').update(body).digest('hex'))
  assert.equal(f.hits.filter((h) => h.path === '/files/lib_photo.png').length, 1, 'the input URL is let through')
})

test('render.html scale multiplies the device pixels', async () => {
  const { body } = await perform(f, { op: 'render.html', with: { html: DESIGN, width: 540, height: 675, scale: 2, format: 'jpeg' }, inputs: { lib_photo: f.input('lib_photo.png') } })
  assert.deepEqual(dims(body), { width: 1080, height: 1350 })
  const webp = await perform(f, { op: 'render.html', with: { html: DESIGN, width: 300, height: 200, format: 'webp' }, inputs: { lib_photo: f.input('lib_photo.png') } })
  assert.deepEqual(dims(webp.body), { width: 300, height: 200 })
  assert.equal(webp.result.mime, 'image/webp')
})

test('render.html pdf is one page of width × height', async () => {
  const tall = DESIGN.replace('</body>', `${'<p>overflow</p>'.repeat(60)}</body>`)
  const { result, body } = await perform(f, { op: 'render.html', with: { html: tall, width: 1080, height: 1350, format: 'pdf' }, inputs: { lib_photo: f.input('lib_photo.png') } })
  assert.equal(result.mime, 'application/pdf')
  assert.equal(result.pages, 1)
  const [box] = boxes(body)
  assert.equal(boxes(body).length, 1)
  // Chrome quantizes a PDF page to its own device units: within a point of 1080 × 1350 px.
  assert.ok(Math.abs(box[2] - 810) < 1 && Math.abs(box[3] - 1012.5) < 1, `MediaBox ${box}`)
})

test('a page reaches nothing it was not given', async () => {
  const port = new URL(f.url).port
  const at = (p: string) => `http://127.0.0.1:${port}/${p}`
  const hostile = `<!doctype html><html><head><link rel="stylesheet" href="${at('css')}"></head><body>
<img src="http://169.254.169.254/latest/meta-data/">
<img src="${at('img')}">
<img src="asset://lib_photo">
<iframe src="${at('frame')}"></iframe>
<script>
fetch(${JSON.stringify(at('secret'))}).catch(() => {})
navigator.sendBeacon(${JSON.stringify(at('beacon'))}, 'x')
try { new WebSocket(${JSON.stringify(`ws://127.0.0.1:${port}/ws`)}) } catch {}
new Worker(URL.createObjectURL(new Blob([${JSON.stringify(`fetch(${JSON.stringify(at('worker'))}).catch(() => {})`)}])))
window.open(${JSON.stringify(at('popup'))})
alert('blocking dialog')
setTimeout(() => { location.href = ${JSON.stringify(at('nav'))} }, 50)
</script></body></html>`
  const before = f.hits.length
  const { result } = await perform(f, { op: 'render.html', with: { html: hostile, width: 400, height: 300 }, inputs: { lib_photo: f.input('lib_photo.png') } })
  assert.equal(result.width, 400)
  const reached = f.hits.slice(before).map((h) => `${h.method} ${h.path}`)
  assert.deepEqual(reached.filter((r) => !r.startsWith('PUT /upload/')), ['GET /files/lib_photo.png'], 'only the input was fetched')
})
