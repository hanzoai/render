import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'

// The egress fence: a forward proxy on loopback that every Chrome a job runs
// (and the frames CLI's own fetches) is pointed at. It covers what request
// interception cannot see — WebSockets, WebRTC over TCP, workers, and the
// browser frames launches — so a page reaches the network only here, and here
// only the tunnels and URLs the job was given.
//
//   tunnels  "host:port" a CONNECT may open (https, wss)
//   urls     exact absolute http:// URLs a plain GET or HEAD may fetch
export type Fence = { url: string; close(): Promise<void> }

export const FONTS = ['fonts.googleapis.com:443', 'fonts.gstatic.com:443']

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

// The fence entries an input URL needs.
export function reach(u: string): { tunnel?: string; url?: string } {
  const x = new URL(u)
  if (x.protocol === 'https:') return { tunnel: `${x.hostname}:${x.port || 443}` }
  if (x.protocol === 'http:') return { url: x.href }
  return {}
}

export async function fence(tunnels: Iterable<string>, urls: Iterable<string>): Promise<Fence> {
  const open = new Set(tunnels)
  const fetchable = new Set([...urls].map((u) => new URL(u).href))
  const sockets = new Set<net.Socket>()
  const track = (s: net.Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)) }

  const server = http.createServer((req, res) => {
    let href = ''
    try { href = new URL(req.url ?? '').href } catch { /* origin-form: not a proxy request */ }
    if (!fetchable.has(href) || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(403).end()
      return
    }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k)))
    const up = http.request(href, { method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, Object.fromEntries(Object.entries(r.headers).filter(([k]) => !HOP.has(k))))
      r.pipe(res)
    })
    up.on('error', () => res.destroy())
    up.end()
  })
  server.on('connection', track)
  server.on('connect', (req, sock: net.Socket, head) => {
    const target = req.url ?? ''
    const at = target.lastIndexOf(':')
    if (!open.has(target) || at < 0) {
      sock.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const up = net.connect(Number(target.slice(at + 1)), target.slice(0, at).replace(/^\[|\]$/g, ''), () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      up.write(head)
      up.pipe(sock)
      sock.pipe(up)
    })
    track(up)
    up.on('error', () => sock.destroy())
    sock.on('error', () => up.destroy())
  })
  server.on('upgrade', (_req, sock: net.Socket) => sock.destroy())

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy()
      server.close(() => resolve())
    }),
  }
}
