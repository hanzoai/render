import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AlignmentType, BorderStyle, Document, Footer, HeadingLevel, ImageRun, LevelFormat, Packer, PageBreak,
  PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx'
import { render } from './browser.ts'
import { Fail, int, list, obj, opt, pick, str } from './check.ts'
import { picture } from './image.ts'
import type { Job, Product } from './job.ts'
import { DOCX } from './measure.ts'
import { css, esc, face, hex, inline, runs, tokens } from './text.ts'
import type { Tokens } from './text.ts'

type Block =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'image'; asset: string; caption: string }
  | { type: 'table'; rows: string[][]; header: boolean }
  | { type: 'code'; text: string }
  | { type: 'break' }

const TEXT = 100_000

function blocks(ir: unknown): Block[] {
  return list(obj(ir, 'ir').blocks, 'ir.blocks', 1, 5000).map((v, i): Block => {
    const b = obj(v, `block ${i}`)
    const at = `block ${i}`
    switch (b.type) {
      case 'heading': return { type: 'heading', level: int(b.level, `${at}.level`, 1, 3, 1) as 1 | 2 | 3, text: str(b.text, `${at}.text`, TEXT) }
      case 'paragraph': return { type: 'paragraph', text: str(b.text, `${at}.text`, TEXT) }
      case 'list': return { type: 'list', ordered: b.ordered === true, items: list(b.items, `${at}.items`, 1, 1000).map((t, j) => str(t, `${at}.items.${j}`, TEXT)) }
      case 'quote': return { type: 'quote', text: str(b.text, `${at}.text`, TEXT) }
      case 'image': return { type: 'image', asset: str(b.asset, `${at}.asset`, 200), caption: opt(b.caption, `${at}.caption`, TEXT) }
      case 'table': return {
        type: 'table', header: b.header === true,
        rows: list(b.rows, `${at}.rows`, 1, 2000).map((r, j) => list(r, `${at}.rows.${j}`, 1, 50).map((c, k) => str(c, `${at}.rows.${j}.${k}`, TEXT))),
      }
      case 'code': return { type: 'code', text: str(b.text, `${at}.text`, TEXT) }
      case 'break': return { type: 'break' }
      default: throw new Fail(`${at} has unknown type ${String(b.type).slice(0, 32)}`)
    }
  })
}

// render.document — a block IR as a paginated PDF, an editable DOCX, or Markdown.
export async function document(w: Record<string, any>, job: Job): Promise<Product> {
  const ir = blocks(w.ir)
  const title = opt(w.title, 'title', 500)
  const format = pick(w.format, 'format', ['pdf', 'docx', 'md'] as const, 'pdf')
  const t = tokens(w.tokens)
  job.report(0.2, 'rendering')
  if (format === 'pdf') return pdf(ir, title, t, job)
  if (format === 'docx') return docx(ir, title, t, job)
  const file = join(job.dir, 'out.md')
  await writeFile(file, markdown(ir))
  return { file, mime: 'text/markdown' }
}

// The print stylesheet. Its variables are the design system's own token names,
// so a document takes Studio's tokens as they are.
const SHEET = `
:root{--background:#fff;--foreground:#111;--muted-foreground:#555;--primary:#111;--border:#d4d4d4;
--font-sans:Inter,"Noto Sans","DejaVu Sans",sans-serif;--font-display:var(--font-sans);--font-mono:"Noto Sans Mono","DejaVu Sans Mono",monospace}
html{background:var(--background);color:var(--foreground);font:10.5pt/1.55 var(--font-sans);-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0}
h1,h2,h3{font-family:var(--font-display);line-height:1.2;margin:1.1em 0 .45em;break-after:avoid}
h1{font-size:21pt}h2{font-size:15pt}h3{font-size:12.5pt}
body>:first-child{margin-top:0}
p{margin:0 0 .75em;orphans:3;widows:3}
ul,ol{margin:0 0 .75em;padding-left:1.4em}li{margin:.15em 0}
blockquote{margin:0 0 .75em;padding:.15em 0 .15em 1em;border-left:3px solid var(--primary);color:var(--muted-foreground);font-style:italic}
figure{margin:0 0 1em;break-inside:avoid}figure img{display:block;max-width:100%;max-height:200mm;margin:0 auto}
figcaption{font-size:8.5pt;color:var(--muted-foreground);text-align:center;margin-top:.4em}
table{border-collapse:collapse;width:100%;margin:0 0 1em;font-size:9.5pt}thead{display:table-header-group}tr{break-inside:avoid}
th,td{border:1px solid var(--border);padding:4pt 6pt;text-align:left;vertical-align:top}
th{background:color-mix(in srgb,var(--foreground) 7%,transparent)}
pre{font:8.5pt/1.45 var(--font-mono);background:color-mix(in srgb,var(--foreground) 5%,transparent);padding:7pt 9pt;border-radius:3pt;white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 1em}
.break{break-after:page}`

const FOOTER = '<div style="width:100%;font:8pt sans-serif;color:#777;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'

async function pdf(ir: Block[], title: string, t: Tokens, job: Job): Promise<Product> {
  const body = ir.map((b) => {
    switch (b.type) {
      case 'heading': return `<h${b.level}>${inline(b.text)}</h${b.level}>`
      case 'paragraph': return `<p>${inline(b.text)}</p>`
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul'
        return `<${tag}>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${tag}>`
      }
      case 'quote': return `<blockquote>${inline(b.text)}</blockquote>`
      case 'image': return `<figure><img src="${esc(job.input(b.asset).url)}" alt="${esc(b.caption)}">${b.caption ? `<figcaption>${inline(b.caption)}</figcaption>` : ''}</figure>`
      case 'table': {
        const [head, ...rest] = b.header ? b.rows : [undefined, ...b.rows]
        const row = (r: string[], c: string) => `<tr>${r.map((x) => `<${c}>${inline(x)}</${c}>`).join('')}</tr>`
        return `<table>${head ? `<thead>${row(head, 'th')}</thead>` : ''}<tbody>${rest.map((r) => row(r!, 'td')).join('')}</tbody></table>`
      }
      case 'code': return `<pre><code>${esc(b.text)}</code></pre>`
      case 'break': return '<div class="break"></div>'
    }
  }).join('\n')
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${SHEET}${css(t)}</style></head><body>${body}</body></html>`
  const file = join(job.dir, 'out.pdf')
  await render(job, doc, { width: 794, height: 1123 }, 'print', (page) => page.pdf({
    path: file, format: 'A4', printBackground: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: FOOTER,
    margin: { top: '20mm', bottom: '22mm', left: '18mm', right: '18mm' },
  }))
  return { file, mime: 'application/pdf' }
}

async function docx(ir: Block[], title: string, t: Tokens, job: Job): Promise<Product> {
  const fg = hex(t, '--foreground', '111111')
  const accent = hex(t, '--primary', '111111')
  const muted = hex(t, '--muted-foreground', '555555')
  const sans = face(t, '--font-sans', 'Inter')
  const mono = face(t, '--font-mono', 'Noto Sans Mono')
  const text = (s: string, o: { bold?: boolean; italics?: boolean; size?: number; color?: string } = {}) =>
    runs(s).map((r) => new TextRun({ text: r.text, bold: r.bold || o.bold, italics: r.italic || o.italics, size: o.size, color: o.color }))
  const out: (Paragraph | Table)[] = []
  let lists = 0
  for (const b of ir) {
    switch (b.type) {
      case 'heading':
        out.push(new Paragraph({ heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][b.level - 1], children: text(b.text) }))
        break
      case 'paragraph':
        out.push(new Paragraph({ children: text(b.text), spacing: { after: 160 } }))
        break
      case 'list': {
        const instance = lists++
        for (const i of b.items) {
          out.push(new Paragraph(b.ordered
            ? { numbering: { reference: 'ordered', level: 0, instance }, children: text(i) }
            : { bullet: { level: 0 }, children: text(i) }))
        }
        break
      }
      case 'quote':
        out.push(new Paragraph({
          children: text(b.text, { italics: true, color: muted }), indent: { left: 567 }, spacing: { after: 160 },
          border: { left: { style: BorderStyle.SINGLE, size: 18, color: accent, space: 8 } },
        }))
        break
      case 'image': {
        const img = await picture(job, b.asset)
        const fit = Math.min(1, 620 / img.width, 820 / img.height)
        out.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new ImageRun({ type: img.type, data: await readFile(img.file), transformation: { width: Math.round(img.width * fit), height: Math.round(img.height * fit) } })],
        }))
        if (b.caption) out.push(new Paragraph({ alignment: AlignmentType.CENTER, children: text(b.caption, { italics: true, size: 18, color: muted }), spacing: { after: 200 } }))
        break
      }
      case 'table': {
        const cols = Math.max(...b.rows.map((r) => r.length))
        out.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: b.rows.map((r, i) => new TableRow({
            tableHeader: b.header && i === 0,
            children: Array.from({ length: cols }, (_, k) => new TableCell({
              children: [new Paragraph({ children: text(r[k] ?? '', { bold: b.header && i === 0, size: 19 }) })],
              shading: b.header && i === 0 ? { type: ShadingType.CLEAR, fill: 'EDEDED', color: 'auto' } : undefined,
            })),
          })),
        }))
        out.push(new Paragraph({ children: [] }))
        break
      }
      case 'code':
        out.push(new Paragraph({
          shading: { type: ShadingType.CLEAR, fill: 'F3F3F3', color: 'auto' }, spacing: { after: 160 },
          children: b.text.split('\n').map((l, i) => new TextRun({ text: l, font: mono, size: 17, break: i ? 1 : undefined })),
        }))
        break
      case 'break':
        out.push(new Paragraph({ children: [new PageBreak()] }))
        break
    }
  }
  const doc = new Document({
    title,
    styles: { default: { document: { run: { font: sans, size: 21, color: fg } } } },
    numbering: {
      config: [{
        reference: 'ordered',
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
      }],
    },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1247, left: 1020, right: 1020 } } },
      footers: {
        default: new Footer({
          children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], size: 16, color: '777777' })] })],
        }),
      },
      children: out,
    }],
  })
  const file = join(job.dir, 'out.docx')
  await writeFile(file, await Packer.toBuffer(doc))
  return { file, mime: DOCX }
}

// Markdown keeps the IR's own inline syntax. An image is referenced by its
// asset id, which outlives the signed URL it arrived under.
function markdown(ir: Block[]): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  return ir.map((b) => {
    switch (b.type) {
      case 'heading': return `${'#'.repeat(b.level)} ${b.text.replace(/\n/g, ' ')}`
      case 'paragraph': return b.text
      case 'list': return b.items.map((i, k) => `${b.ordered ? `${k + 1}.` : '-'} ${i.replace(/\n/g, ' ')}`).join('\n')
      case 'quote': return b.text.split('\n').map((l) => `> ${l}`).join('\n')
      case 'image': return `![${b.caption.replace(/[\[\]\n]/g, ' ')}](asset://${b.asset})`
      case 'table': {
        const cols = Math.max(...b.rows.map((r) => r.length))
        const line = (r: string[]) => `| ${Array.from({ length: cols }, (_, k) => cell(r[k] ?? '')).join(' | ')} |`
        const [head, ...rest] = b.header ? b.rows : [Array(cols).fill(''), ...b.rows]
        return [line(head), `|${' --- |'.repeat(cols)}`, ...rest.map(line)].join('\n')
      }
      case 'code': {
        const fence = '`'.repeat(Math.max(3, ...[...b.text.matchAll(/`+/g)].map((m) => m[0].length + 1)))
        return `${fence}\n${b.text}\n${fence}`
      }
      case 'break': return '---'
    }
  }).join('\n\n') + '\n'
}
