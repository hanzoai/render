import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { close } from '../src/browser.ts'
import { PPTX, zipNames } from '../src/measure.ts'
import { boxes, fake, perform, png } from './fake.ts'
import type { Fake } from './fake.ts'

let f: Fake
before(async () => {
  f = await fake()
  f.files.set('lib_hero.png', { body: png(400, 300, [20, 160, 90]), type: 'image/png' })
})
after(async () => { await close(); await f.close() })

const IR = {
  slides: [
    { layout: 'title', title: 'Render', subtitle: 'Hanzo Studio', notes: 'Open with the result.' },
    { layout: 'content', title: 'What it does', body: 'Five ops, one worker.', bullets: ['HTML to **pixels**', 'Documents', 'Slides'] },
    { layout: 'image', title: 'A picture', image: 'lib_hero', body: 'Caption' },
    { layout: 'split', title: 'Side by side', bullets: ['Left text'], image: 'lib_hero' },
    { layout: 'quote', body: 'Minimal code, one way.', subtitle: 'The house rules' },
  ],
}

const input = (format: string) => ({ op: 'render.slides', with: { ir: IR, title: 'Deck', format }, inputs: { lib_hero: f.input('lib_hero.png') } })

test('render.slides pptx has one slide part per slide, with notes', async () => {
  const { result, body } = await perform(f, input('pptx'))
  assert.equal(result.mime, PPTX)
  assert.equal(result.pages, 5)
  const names = zipNames(body)
  assert.deepEqual(names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(), [1, 2, 3, 4, 5].map((i) => `ppt/slides/slide${i}.xml`))
  assert.ok(names.some((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)), 'speaker notes')
  assert.ok(names.some((n) => /^ppt\/media\/.+\.png$/.test(n)), 'image embedded')
})

test('render.slides pdf is one 1920 × 1080 page per slide', async () => {
  const { result, body } = await perform(f, input('pdf'))
  assert.equal(result.mime, 'application/pdf')
  assert.equal(result.pages, 5)
  const b = boxes(body)
  assert.equal(b.length, 5)
  for (const box of b) assert.ok(Math.abs(box[2] - 1440) < 1 && Math.abs(box[3] - 810) < 1, `MediaBox ${box}`)
})
