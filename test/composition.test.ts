import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fake, NOFFMPEG, perform, png } from './fake.ts'
import type { Fake } from './fake.ts'

let f: Fake
before(async () => {
  f = await fake()
  f.files.set('lib_logo.png', { type: 'image/png', body: png(80, 40, [250, 200, 30]) })
})
after(() => f.close())

const COMPOSITION = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;width:320px;height:240px;background:#123}#t{position:absolute;top:90px;left:30px;color:#fff;font:32px sans-serif}img{position:absolute;top:20px;left:20px}</style></head>
<body><div id="root" data-composition-id="main" data-start="0" data-duration="1" data-width="320" data-height="240" data-no-timeline>
<div id="t" class="clip" data-start="0" data-duration="1" data-track-index="1">Frames</div>
<img src="asset://lib_logo" class="clip" data-start="0" data-duration="1" data-track-index="2">
</div></body></html>`

// frames needs ffmpeg as well as Chrome.
test('render.composition renders the declared size', { skip: NOFFMPEG }, async () => {
  const { result } = await perform(f, { op: 'render.composition', with: { html: COMPOSITION }, inputs: { lib_logo: f.input('lib_logo.png') } })
  assert.equal(result.mime, 'video/mp4')
  assert.equal(result.width, 320)
  assert.equal(result.height, 240)
  assert.ok(Math.abs(result.seconds! - 1) <= 0.15, `seconds ${result.seconds}`)
  assert.equal(f.hits.filter((h) => h.path === '/files/lib_logo.png').length, 1, 'the asset was downloaded once, beside the composition')
})
