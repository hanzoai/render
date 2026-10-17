import { Fail, obj } from './check.ts'

// An asset reference inside authored HTML: asset://<assetId>.
export const ASSET = /asset:\/\/([A-Za-z0-9_-]+)/g

export function swap(src: string, to: (id: string) => string): string {
  return src.replace(ASSET, (_m, id: string) => to(id))
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export type Run = { text: string; bold: boolean; italic: boolean }

// Inline emphasis: **bold** and *italic*, the markers hugging their text the way
// Markdown requires, so "2 * 3 * 4" stays arithmetic.
export function runs(s: string, bold = false, italic = false): Run[] {
  const out: Run[] = []
  const re = /\*\*(?!\s)(.+?)(?<!\s)\*\*|\*(?![\s*])(.+?)(?<![\s*])\*/gs
  let at = 0
  for (const m of s.matchAll(re)) {
    if (m.index > at) out.push({ text: s.slice(at, m.index), bold, italic })
    if (m[1] !== undefined) out.push(...runs(m[1], true, italic))
    else out.push(...runs(m[2], bold, true))
    at = m.index + m[0].length
  }
  if (at < s.length) out.push({ text: s.slice(at), bold, italic })
  return out
}

export function inline(s: string): string {
  return runs(s).map((r) => {
    let h = esc(r.text)
    if (r.italic) h = `<em>${h}</em>`
    if (r.bold) h = `<strong>${h}</strong>`
    return h
  }).join('')
}

// Design tokens: CSS custom properties (the design system's own names, e.g.
// --background, --foreground, --primary, --font-sans). A value may not leave
// its declaration, so it carries no ; { } < > backslash or comment.
export type Tokens = Record<string, string>

export function tokens(v: unknown): Tokens {
  if (v === undefined || v === null) return {}
  const t = obj(v, 'tokens')
  const out: Tokens = {}
  for (const [k, val] of Object.entries(t)) {
    if (!/^--[A-Za-z0-9-]{1,64}$/.test(k)) throw new Fail(`token ${k.slice(0, 64)} is not a CSS custom property`)
    if (typeof val !== 'string' || val.length > 300 || /[;{}<>\\]|\/\*/.test(val)) throw new Fail(`token ${k} has an unsafe value`)
    out[k] = val
  }
  return out
}

export function css(t: Tokens): string {
  const d = Object.entries(t).map(([k, v]) => `${k}:${v}`).join(';')
  return d ? `:root{${d}}` : ''
}

// A token as an Office colour (RRGGBB), when it is a plain hex colour.
export function hex(t: Tokens, name: string, def: string): string {
  const v = t[name]?.trim()
  const m = v && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v)
  if (!m) return def
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1]
  return h.toUpperCase()
}

// A font token's first family, for Office documents.
export function face(t: Tokens, name: string, def: string): string {
  const first = t[name]?.split(',')[0]?.trim().replace(/^["']|["']$/g, '')
  return first && !first.startsWith('var(') && !first.startsWith('-') ? first : def
}
