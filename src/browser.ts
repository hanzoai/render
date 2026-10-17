import { setTimeout as sleep } from 'node:timers/promises'
import puppeteer from 'puppeteer-core'
import type { Browser, BrowserContext, Page, Viewport } from 'puppeteer-core'
import { fence, FONTS, reach } from './fence.ts'
import type { Job } from './job.ts'

// The Chrome flags every page runs under. No sandbox: the pod is the sandbox
// (non-root, read-only root, its own network namespace). WebRTC may not open
// UDP, so it too can only leave through the job's fence.
export const FLAGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--font-render-hinting=none',
  '--force-color-profile=srgb',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
]

export const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium-headless-shell'

let shared: Promise<Browser> | null = null

function browser(): Promise<Browser> {
  if (shared) return shared
  const p = puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    pipe: true,
    args: FLAGS,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  })
  shared = p
  p.then((b) => b.on('disconnected', () => { if (shared === p) shared = null }), () => { if (shared === p) shared = null })
  return p
}

export async function close(): Promise<void> {
  const p = shared
  shared = null
  if (p) await (await p.catch(() => null))?.close().catch(() => {})
}

const PASS = /^(data|blob|about):|^https:\/\/fonts\.(googleapis|gstatic)\.com\//

// Loads authored HTML into a fresh context of its own and hands the page to
// `act`. The context's every request leaves through the job's fence; on the
// page, request interception admits only data:, blob:, about:, Google Fonts and
// the job's exact input URLs, and nothing may navigate the page away, open a
// window, download, or wait on a dialog.
export async function render<T>(job: Job, html: string, view: Viewport, media: 'screen' | 'print', act: (page: Page) => Promise<T>): Promise<T> {
  const allowed = new Set(job.urls().map((u) => new URL(u).href))
  const tunnels = [...FONTS]
  const urls: string[] = []
  for (const u of allowed) {
    const r = reach(u)
    if (r.tunnel) tunnels.push(r.tunnel)
    if (r.url) urls.push(r.url)
  }
  const f = await fence(tunnels, urls)
  let ctx: BrowserContext | undefined
  const stop = async () => { await ctx?.close().catch(() => {}) }
  job.signal.addEventListener('abort', stop, { once: true })
  try {
    const b = await browser()
    ctx = await b.createBrowserContext({ proxyServer: f.url, proxyBypassList: ['<-loopback>'], downloadBehavior: { policy: 'deny' } })
    if (job.signal.aborted) throw job.signal.reason
    const page = await ctx.newPage()
    ctx.on('targetcreated', (t) => {
      if (t.type() === 'page') t.page().then((p) => { if (p && p !== page) return p.close() }).catch(() => {})
    })
    page.on('dialog', (d) => { d.dismiss().catch(() => {}) })
    await page.setRequestInterception(true)
    page.on('request', (r) => {
      const u = r.url()
      const away = r.isNavigationRequest() && r.frame() === page.mainFrame()
      const ok = !away && (PASS.test(u) || allowed.has(u))
      ;(ok ? r.continue() : r.abort('blockedbyclient')).catch(() => {})
    })
    await page.setViewport(view)
    await page.emulateMediaType(media)
    // Loaded and network-idle (nothing in flight for 500ms), within 10s in all;
    // a page still busy then is captured as it stands.
    const end = Date.now() + 10_000
    const late = (e: any) => { if (e?.name !== 'TimeoutError') throw e }
    await page.setContent(html, { waitUntil: 'load', timeout: 10_000 }).catch(late)
    await page.waitForNetworkIdle({ idleTime: 500, timeout: Math.max(1, end - Date.now()) }).catch(late)
    await Promise.race([page.evaluate(() => document.fonts.ready.then(() => true)), sleep(5_000)])
    return await act(page)
  } catch (e) {
    if (job.signal.aborted) throw job.signal.reason
    throw e
  } finally {
    job.signal.removeEventListener('abort', stop)
    await stop()
    await f.close()
  }
}
