import { join } from 'node:path'
import { render } from './browser.ts'
import { Fail, int, pick, str } from './check.ts'
import type { Job, Product } from './job.ts'
import { swap } from './text.ts'

const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' } as const

// render.html — authored HTML at exactly width × height CSS px: an image at
// `scale` device px per CSS px, or one PDF page of that size.
export async function html(w: Record<string, any>, job: Job): Promise<Product> {
  const src = str(w.html, 'html', 8 << 20)
  const width = int(w.width, 'width', 1, 8192)
  const height = int(w.height, 'height', 1, 8192)
  const format = pick(w.format, 'format', ['png', 'jpeg', 'webp', 'pdf'] as const, 'png')
  const scale = int(w.scale, 'scale', 1, 4, 1)
  if (format !== 'pdf' && (width * scale > 16384 || height * scale > 16384 || width * height * scale * scale > 50e6)) {
    throw new Fail('the image may be at most 16384 px a side and 50 million px in all')
  }
  const doc = swap(src, (id) => job.input(id).url)
  const file = join(job.dir, `out.${format}`)
  job.report(0.2, 'rendering')
  await render(job, doc, { width, height, deviceScaleFactor: format === 'pdf' ? 1 : scale }, 'screen', async (page) => {
    if (format === 'pdf') {
      await page.pdf({ path: file, width: `${width}px`, height: `${height}px`, printBackground: true, pageRanges: '1', margin: { top: 0, right: 0, bottom: 0, left: 0 } })
    } else {
      await page.screenshot({ path: file, type: format, ...(format === 'png' ? {} : { quality: 92 }), captureBeyondViewport: false })
    }
  })
  return { file, mime: MIME[format] }
}
