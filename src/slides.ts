import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import PptxGenJS from 'pptxgenjs'
import { render } from './browser.ts'
import { Fail, list, obj, opt, pick, str } from './check.ts'
import { picture } from './image.ts'
import type { Job, Product } from './job.ts'
import { PPTX } from './measure.ts'
import { css, esc, face, hex, inline, runs, tokens } from './text.ts'
import type { Tokens } from './text.ts'

type Slide = { layout: 'title' | 'content' | 'image' | 'split' | 'quote'; title: string; subtitle: string; bullets: string[]; body: string; image: string; notes: string }
type Box = { x: number; y: number; w: number; h: number }

const TEXT = 20_000

function deck(ir: unknown): Slide[] {
  return list(obj(ir, 'ir').slides, 'ir.slides', 1, 500).map((v, i) => {
    const s = obj(v, `slide ${i}`)
    const at = `slide ${i}`
    const slide: Slide = {
      layout: pick(s.layout, `${at}.layout`, ['title', 'content', 'image', 'split', 'quote'] as const, 'content'),
      title: opt(s.title, `${at}.title`, TEXT),
      subtitle: opt(s.subtitle, `${at}.subtitle`, TEXT),
      bullets: list(s.bullets, `${at}.bullets`, 0, 100).map((b, j) => str(b, `${at}.bullets.${j}`, TEXT)),
      body: opt(s.body, `${at}.body`, TEXT),
      image: opt(s.image, `${at}.image`, 200),
      notes: opt(s.notes, `${at}.notes`, TEXT),
    }
    if (slide.layout === 'image' && !slide.image) throw new Fail(`${at} has layout image and no image`)
    return slide
  })
}

// One geometry for both outputs, in inches of a 10 × 5.625 (16:9) slide; the
// PDF draws it at 192 px per inch (1920 × 1080).
function boxes(s: Slide): { title?: Box; subtitle?: Box; text?: Box; image?: Box; caption?: Box } {
  const head = { x: 0.6, y: 0.4, w: 8.8, h: 0.9 }
  switch (s.layout) {
    case 'title': return { title: { x: 0.6, y: 1.5, w: 8.8, h: 1.5 }, subtitle: { x: 0.6, y: 3.1, w: 8.8, h: 0.9 } }
    case 'content': return { title: head, text: { x: 0.6, y: 1.45, w: 8.8, h: 3.75 } }
    case 'image': return s.title
      ? { title: head, image: { x: 0.6, y: 1.4, w: 8.8, h: 3.4 }, caption: { x: 0.6, y: 4.9, w: 8.8, h: 0.45 } }
      : { image: { x: 0.6, y: 0.4, w: 8.8, h: 4.4 }, caption: { x: 0.6, y: 4.9, w: 8.8, h: 0.45 } }
    case 'split': return { title: head, text: { x: 0.6, y: 1.45, w: 4.2, h: 3.75 }, image: { x: 5.2, y: 1.45, w: 4.2, h: 3.75 } }
    case 'quote': return { text: { x: 1, y: 1.1, w: 8, h: 2.7 }, subtitle: { x: 1, y: 3.9, w: 8, h: 0.6 } }
  }
}

// render.slides — a slide IR as an editable 16:9 PPTX with speaker notes, or a
// PDF of one 1920 × 1080 page per slide.
export async function slides(w: Record<string, any>, job: Job): Promise<Product> {
  const ir = deck(w.ir)
  const title = opt(w.title, 'title', 500)
  const format = pick(w.format, 'format', ['pptx', 'pdf'] as const, 'pptx')
  const t = tokens(w.tokens)
  job.report(0.2, 'rendering')
  return format === 'pptx' ? pptx(ir, title, t, job) : pdf(ir, title, t, job)
}

async function pptx(ir: Slide[], title: string, t: Tokens, job: Job): Promise<Product> {
  const p = new PptxGenJS()
  p.layout = 'LAYOUT_16x9'
  p.title = title
  const bg = hex(t, '--background', 'FFFFFF')
  const fg = hex(t, '--foreground', '111111')
  const muted = hex(t, '--muted-foreground', '555555')
  const sans = face(t, '--font-sans', 'Inter')
  const display = face(t, '--font-display', sans)
  // One paragraph of inline runs; the last run ends it.
  const para = (s: string, o: Record<string, unknown> = {}) => {
    const r = runs(s)
    return r.map((x, i) => ({ text: x.text, options: { ...o, bold: x.bold || (o.bold as boolean) || undefined, italic: x.italic || (o.italic as boolean) || undefined, breakLine: i === r.length - 1 } }))
  }
  const words = (s: Slide) => [
    ...s.body.split('\n').filter((l) => l.trim()).flatMap((l) => para(l, { paraSpaceAfter: 8 })),
    ...s.bullets.flatMap((b) => para(b, { bullet: true, paraSpaceAfter: 6 })),
  ]
  for (const s of ir) {
    const slide = p.addSlide()
    slide.background = { color: bg }
    const b = boxes(s)
    const base = { fontFace: sans, color: fg, margin: 0 }
    if (b.title && s.title) {
      const big = s.layout === 'title'
      slide.addText(para(s.title), { ...b.title, ...base, fontFace: display, fontSize: big ? 40 : 28, bold: true, align: big ? 'center' : 'left', valign: big ? 'bottom' : 'middle', fit: 'shrink' })
    }
    if (s.layout === 'title' && b.subtitle && s.subtitle) {
      slide.addText(para(s.subtitle), { ...b.subtitle, ...base, fontSize: 20, color: muted, align: 'center', valign: 'top' })
    }
    if (s.layout === 'quote') {
      const q = s.body || s.title
      if (q) slide.addText(para(`“${q}”`), { ...b.text!, ...base, fontFace: display, fontSize: 30, italic: true, align: 'center', valign: 'middle', fit: 'shrink' })
      if (s.subtitle) slide.addText(para(`— ${s.subtitle}`), { ...b.subtitle!, ...base, fontSize: 16, color: muted, align: 'center', valign: 'top' })
    } else if (b.text) {
      const body = words(s)
      if (body.length) slide.addText(body, { ...b.text, ...base, fontSize: s.layout === 'split' ? 16 : 18, valign: 'top', fit: 'shrink' })
    }
    if (b.image && s.image) {
      const img = await picture(job, s.image)
      const data = `image/${img.type === 'jpg' ? 'jpeg' : img.type};base64,${(await readFile(img.file)).toString('base64')}`
      slide.addImage({ data, ...contain(b.image, img.width / img.height) })
    }
    if (b.caption && (s.body || s.subtitle)) {
      slide.addText(para(s.body || s.subtitle), { ...b.caption, ...base, fontSize: 14, color: muted, align: 'center', valign: 'middle' })
    }
    if (s.notes) slide.addNotes(s.notes)
  }
  const file = join(job.dir, 'out.pptx')
  await writeFile(file, (await p.write({ outputType: 'nodebuffer' })) as Buffer)
  return { file, mime: PPTX }
}

function contain(b: Box, ratio: number): Box {
  const w = Math.min(b.w, b.h * ratio)
  const h = w / ratio
  return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h }
}

const PT = 8 / 3 // CSS px per point at 1920 px for 720 pt of slide width

const SHEET = `
:root{--background:#fff;--foreground:#111;--muted-foreground:#555;--font-sans:Inter,"Noto Sans","DejaVu Sans",sans-serif;--font-display:var(--font-sans)}
@page{size:1920px 1080px;margin:0}
html,body{margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.slide{position:relative;width:1920px;height:1080px;overflow:hidden;background:var(--background);color:var(--foreground);font-family:var(--font-sans)}
.slide+.slide{break-before:page}
.slide>*{position:absolute;margin:0;box-sizing:border-box;overflow:hidden}
.t{font-family:var(--font-display);font-weight:700;font-size:${28 * PT}px;line-height:1.15;display:flex;align-items:center}
.title .t{font-size:${40 * PT}px;justify-content:center;align-items:flex-end;text-align:center}
.s{font-size:${20 * PT}px;color:var(--muted-foreground);text-align:center;line-height:1.3}
.b{font-size:${18 * PT}px;line-height:1.35}.split .b{font-size:${16 * PT}px}
.b p{margin:0 0 ${8 * PT}px}.b ul{margin:0;padding-left:1.2em}.b li{margin:0 0 ${6 * PT}px}
.q{font-family:var(--font-display);font-style:italic;font-size:${30 * PT}px;line-height:1.3;display:flex;align-items:center;justify-content:center;text-align:center}
.a{font-size:${16 * PT}px;color:var(--muted-foreground);text-align:center}
.c{font-size:${14 * PT}px;color:var(--muted-foreground);text-align:center;display:flex;align-items:center;justify-content:center}
.i{object-fit:contain}`

async function pdf(ir: Slide[], title: string, t: Tokens, job: Job): Promise<Product> {
  const at = (b: Box) => `left:${b.x * 192}px;top:${b.y * 192}px;width:${b.w * 192}px;height:${b.h * 192}px`
  const pages = ir.map((s) => {
    const b = boxes(s)
    const parts: string[] = []
    if (b.title && s.title) parts.push(`<h1 class="t" style="${at(b.title)}"><span>${inline(s.title)}</span></h1>`)
    if (s.layout === 'title' && b.subtitle && s.subtitle) parts.push(`<p class="s" style="${at(b.subtitle)}">${inline(s.subtitle)}</p>`)
    if (s.layout === 'quote') {
      const q = s.body || s.title
      if (q) parts.push(`<blockquote class="q" style="${at(b.text!)}"><span>“${inline(q)}”</span></blockquote>`)
      if (s.subtitle) parts.push(`<p class="a" style="${at(b.subtitle!)}">— ${inline(s.subtitle)}</p>`)
    } else if (b.text && (s.body || s.bullets.length)) {
      const body = s.body.split('\n').filter((l) => l.trim()).map((l) => `<p>${inline(l)}</p>`).join('')
      const bullets = s.bullets.length ? `<ul>${s.bullets.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>` : ''
      parts.push(`<div class="b" style="${at(b.text)}">${body}${bullets}</div>`)
    }
    if (b.image && s.image) parts.push(`<img class="i" style="${at(b.image)}" src="${esc(job.input(s.image).url)}" alt="">`)
    if (b.caption && (s.body || s.subtitle)) parts.push(`<p class="c" style="${at(b.caption)}"><span>${inline(s.body || s.subtitle)}</span></p>`)
    return `<section class="slide ${s.layout}">${parts.join('')}</section>`
  })
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${SHEET}${css(t)}</style></head><body>${pages.join('\n')}</body></html>`
  const file = join(job.dir, 'out.pdf')
  await render(job, doc, { width: 1920, height: 1080 }, 'print', (page) => page.pdf({
    path: file, width: '1920px', height: '1080px', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 },
  }))
  return { file, mime: 'application/pdf' }
}
