import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { Fail } from './check.ts'
import type { Meta } from './job.ts'

export type Config = {
  api: string        // HANZO_API
  base: string       // RENDER_BASE: Studio's render lane on the API
  namespace: string  // RENDER_NAMESPACE
  queue: string      // RENDER_QUEUE
  identity: string   // RENDER_IDENTITY
  concurrency: number
  iam: string        // HANZO_IAM_URL
  token: string      // HANZO_TOKEN, a static bearer for local dev
  sa: string         // HANZO_SA_TOKEN, the projected ServiceAccount token file
  port: number       // PORT for GET /healthz; 0 is no listener
}

export function config(e: NodeJS.ProcessEnv): Config {
  const concurrency = Number(e.RENDER_CONCURRENCY ?? 2)
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('RENDER_CONCURRENCY must be an integer from 1 to 32')
  const port = Number(e.PORT ?? 0)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a port number')
  return {
    api: (e.HANZO_API || 'https://api.hanzo.ai').replace(/\/+$/, ''),
    base: (e.RENDER_BASE || '/v1/studio/render').replace(/\/+$/, ''),
    namespace: e.RENDER_NAMESPACE || 'render-jobs',
    queue: e.RENDER_QUEUE || 'render-jobs',
    identity: e.RENDER_IDENTITY || hostname(),
    concurrency,
    iam: (e.HANZO_IAM_URL || 'https://hanzo.id').replace(/\/+$/, ''),
    token: e.HANZO_TOKEN || '',
    sa: e.HANZO_SA_TOKEN || '/var/run/secrets/hanzo/iam/token',
    port,
  }
}

// An error worth retrying: the engine or IAM answered 5xx or 429, or did not answer.
export class Transient extends Error {}

// The bearer every engine call carries. A static HANZO_TOKEN as given; else the
// pod's projected ServiceAccount token, re-read and exchanged at IAM for an
// access token before it expires (every 10 minutes when IAM states no expiry).
class Bearer {
  private token = ''
  private until = 0
  private pending: Promise<string> | null = null
  private readonly c: Config
  constructor(c: Config) {
    this.c = c
  }

  get(): Promise<string> {
    if (this.c.token) return Promise.resolve(this.c.token)
    if (this.token && Date.now() < this.until) return Promise.resolve(this.token)
    this.pending ??= this.exchange().finally(() => { this.pending = null })
    return this.pending
  }

  reset(): void {
    this.until = 0
  }

  private async exchange(): Promise<string> {
    const assertion = (await readFile(this.c.sa, 'utf8').catch(() => { throw new Transient(`cannot read the ServiceAccount token at ${this.c.sa}`) })).trim()
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
    const res = await fetch(`${this.c.iam}/v1/iam/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(30_000),
    }).catch((e) => { throw new Transient(`IAM did not answer: ${e.cause?.code ?? e.cause?.message ?? e.message}`) })
    if (res.status !== 200) throw new Transient(`IAM token exchange answered ${res.status}`)
    const j = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown }
    if (typeof j.access_token !== 'string' || !j.access_token) throw new Transient('IAM token exchange returned no access_token')
    const life = typeof j.expires_in === 'number' && j.expires_in > 0 ? j.expires_in * 1000 : 0
    this.token = j.access_token
    this.until = Date.now() + (life ? Math.max(life - 60_000, life / 2) : 600_000)
    return this.token
  }
}

export type Activity = { workflowId: string; runId: string; type: string; attempt: number; input: unknown }

// Studio's render lane: claim, heartbeat, output, complete, fail.
export class Engine {
  private readonly bearer: Bearer
  private readonly c: Config
  constructor(c: Config) {
    this.c = c
    this.bearer = new Bearer(c)
  }

  private url(path: string): string {
    return `${this.c.api}${this.c.base}/namespaces${path}`
  }

  private act(a: Activity, verb: string): string {
    return `/${encodeURIComponent(this.c.namespace)}/activities/${encodeURIComponent(a.workflowId)}/${encodeURIComponent(a.runId)}/${verb}`
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const send = async () => {
      const auth = await this.bearer.get()
      const s = signal ? AbortSignal.any([signal, AbortSignal.timeout(65_000)]) : AbortSignal.timeout(65_000)
      return fetch(this.url(path), {
        method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: s,
      }).catch((e) => {
        if (signal?.aborted) throw signal.reason
        throw new Transient(`engine did not answer: ${e.cause?.code ?? e.cause?.message ?? e.message}`)
      })
    }
    let res = await send()
    if (res.status === 401) {
      await res.body?.cancel()
      this.bearer.reset()
      res = await send()
    }
    if (res.status >= 500 || res.status === 429) {
      await res.body?.cancel()
      throw new Transient(`engine answered ${res.status}`)
    }
    return res
  }

  async namespace(): Promise<void> {
    const r = await this.post('', { namespaceInfo: { name: this.c.namespace } })
    await r.body?.cancel()
  }

  // One activity, or null when the queue is empty.
  async claim(signal: AbortSignal): Promise<Activity | null> {
    const r = await this.post(`/${encodeURIComponent(this.c.namespace)}/activities/claim`, { taskQueue: this.c.queue, identity: this.c.identity, leaseSeconds: 120 }, signal)
    if (r.status === 204) { await r.body?.cancel(); return null }
    if (r.status !== 200) { await r.body?.cancel(); throw new Transient(`claim answered ${r.status}`) }
    const j = (await r.json().catch(() => null)) as any
    const wf = j?.execution?.workflowId, run = j?.execution?.runId
    if (typeof wf !== 'string' || !wf || typeof run !== 'string' || !run) throw new Transient('claim answered an activity with no execution')
    return { workflowId: wf, runId: run, type: String(j.type?.name ?? ''), attempt: Number(j.attempt ?? 1), input: j.input }
  }

  // false: the engine no longer holds this job for us (cancelled, or re-leased).
  async heartbeat(a: Activity, progress: number, message: string): Promise<boolean> {
    const r = await this.post(this.act(a, 'heartbeat'), { details: { progress: Math.round(progress * 100) / 100, message } })
    await r.body?.cancel()
    return r.status !== 404 && r.status !== 409
  }

  // Where the measured output goes: a signed PUT and the headers to send.
  async output(a: Activity, meta: Meta): Promise<unknown> {
    const r = await retry(() => this.post(this.act(a, 'output'), meta))
    if (r.status < 200 || r.status > 299) {
      await r.body?.cancel()
      throw new Fail(`output answered ${r.status}`)
    }
    return r.json().catch(() => { throw new Fail('output answered no JSON') })
  }

  async complete(a: Activity, result: unknown): Promise<number> {
    return this.report(a, 'complete', { result, identity: this.c.identity })
  }

  async fail(a: Activity, cause: string): Promise<number> {
    return this.report(a, 'fail', { cause, identity: this.c.identity })
  }

  private async report(a: Activity, verb: string, body: unknown): Promise<number> {
    const r = await retry(() => this.post(this.act(a, verb), body))
    await r.body?.cancel()
    return r.status
  }
}

// Retries transient failures with backoff for about thirty seconds; after that the
// lease expires and the engine re-dispatches the job anyway.
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (!(e instanceof Transient) || i >= 6) throw e
      await sleep(500 * 2 ** i)
    }
  }
}
