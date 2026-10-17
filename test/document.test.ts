import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { inflateRawSync } from 'node:zlib'
import { close } from '../src/browser.ts'
import { DOCX, zipNames } from '../src/measure.ts'
import { boxes, fake, perform, png } from './fake.ts'
import type { Fake } from './fake.ts'

let f: Fake
before(async () => {
  f = await fake()
  f.files.set('lib_chart.png', { body: png(320, 180, [200, 60, 40]), type: 'image/png' })
})
after(async () => { await close(); await f.close() })

const IR = {
  blocks: [
    { type: 'heading', level: 1, text: 'Quarterly *review*' },
    { type: 'paragraph', text: 'Revenue grew **18%** while costs held *flat*. Not italic: 2 * 3 * 4.' },
    { type: 'list', items: ['First', 'Second with **bold**'] },
    { type: 'list', ordered: true, items: ['One', 'Two', 'Three'] },
    { type: 'quote', text: 'Ship it finished or do not ship it.' },
    { type: 'image', asset: 'lib_chart', caption: 'Figure 1. <script>alert(1)</script>' },
    { type: 'break' },
    { type: 'heading', level: 2, text: 'Appendix' },
    { type: 'table', header: true, rows: [['Region', 'Q1', 'Q2'], ['EMEA', '10', '12'], ['APAC', '7']] },
    { type: 'code', text: 'const a = 1\nconsole.log(`${a}`)' },
  ],
}

const input = (format: string) => ({
  op: 'render.document', with: { ir: IR, title: 'Review', format, tokens: { '--primary': '#2255cc', '--font-sans': 'Inter, sans-serif' } },
  inputs: { lib_chart: f.input('lib_chart.png') },
})

// One entry of a ZIP, inflated.
function entry(zip: Buffer, name: string): string {
  let p = 0
  while (zip.readUInt32LE(p) === 0x04034b50) {
    const method = zip.readUInt16LE(p + 8), size = zip.readUInt32LE(p + 18), n = zip.readUInt16LE(p + 26), x = zip.readUInt16LE(p + 28)
    const start = p + 30 + n + x
    if (zip.toString('utf8', p + 30, p + 30 + n) === name) {
      const data = zip.subarray(start, start + size)
      return (method === 8 ? inflateRawSync(data) : data).toString('utf8')
    }
    p = start + size
  }
  throw new Error(`${name} not in zip`)
}

test('render.document pdf breaks pages and numbers them', async () => {
  const { result, body } = await perform(f, input('pdf'))
  assert.equal(result.mime, 'application/pdf')
  assert.ok(result.pages! >= 2, `pages ${result.pages}`)
  const [box] = boxes(body)
  assert.ok(Math.abs(box[2] - 595.3) < 1.5 && Math.abs(box[3] - 841.9) < 1.5, `A4 MediaBox ${box}`)
  assert.ok(f.hits.some((h) => h.path === '/files/lib_chart.png'), 'the image input was fetched')
})

test('render.document docx is a Word document with its image', async () => {
  const { result, body } = await perform(f, input('docx'))
  assert.equal(result.mime, DOCX)
  const names = zipNames(body)
  assert.ok(names.includes('word/document.xml'), names.join(','))
  assert.ok(names.some((n) => /^word\/media\/.+\.png$/.test(n)), 'image embedded')
  const xml = entry(body, 'word/document.xml')
  assert.match(xml, /<w:b\/>.*?18%/s)
  assert.match(xml, /w:br w:type="page"/)
  assert.match(xml, /&lt;script&gt;/)
  assert.ok(names.includes('word/footer1.xml'), 'page-number footer')
})

test('render.document md keeps the IR text', async () => {
  const { result, body } = await perform(f, input('md'))
  assert.equal(result.mime, 'text/markdown')
  const md = body.toString()
  assert.match(md, /^# Quarterly \*review\*$/m)
  assert.match(md, /^1\. One$/m)
  assert.match(md, /^\| Region \| Q1 \| Q2 \|$/m)
  assert.match(md, /!\[Figure 1\. <script>alert\(1\)<\/script>\]\(asset:\/\/lib_chart\)/)
  assert.match(md, /^```\nconst a = 1/m)
})

test('render.document refuses an unknown block', async () => {
  await assert.rejects(perform(f, { op: 'render.document', with: { ir: { blocks: [{ type: 'video' }] } } }), /block 0 has unknown type video/)
})
