import { createReadStream, createWriteStream } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Fail } from './check.ts'

// Fetches one signed GET to a file, refusing more than `cap` bytes. A redirect
// is refused too: the URL the engine signed is the only one fetched.
export async function download(url: string, file: string, cap: number, signal: AbortSignal): Promise<number> {
  const res = await fetch(url, { signal, redirect: 'error' }).catch((e) => {
    if (signal.aborted) throw signal.reason
    throw new Fail(`input download failed: ${e.cause?.code ?? e.message}`)
  })
  if (!res.ok || !res.body) throw new Fail(`input download answered ${res.status}`)
  if (Number(res.headers.get('content-length') ?? 0) > cap) throw new Fail(`input is larger than ${cap} bytes`)
  let n = 0
  const count = new Transform({
    transform(c: Buffer, _e, done) {
      n += c.length
      done(n > cap ? new Fail(`input is larger than ${cap} bytes`) : null, c)
    },
  })
  await pipeline(Readable.fromWeb(res.body as any), count, createWriteStream(file), { signal })
  return n
}

// PUTs the one output with the engine's headers and its exact length. Streamed
// from disk, so a large video never sits in memory.
export function upload(url: string, file: string, size: number, headers: Record<string, string>, signal: AbortSignal): Promise<void> {
  const u = new URL(url)
  const client = u.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = client.request(u, { method: 'PUT', headers: { ...headers, 'content-length': String(size) }, signal }, (res) => {
      res.resume()
      res.on('end', () => {
        const s = res.statusCode ?? 0
        s >= 200 && s < 300 ? resolve() : reject(new Fail(`output upload answered ${s}`))
      })
    })
    req.on('error', (e) => reject(signal.aborted ? signal.reason : new Fail(`output upload failed: ${(e as any).code ?? e.message}`)))
    pipeline(createReadStream(file), req).catch((e) => reject(signal.aborted ? signal.reason : new Fail(`output upload failed: ${e.code ?? e.message}`)))
  })
}
