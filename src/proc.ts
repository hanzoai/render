import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { Fail } from './check.ts'

export type Run = {
  cwd?: string
  env: Record<string, string>   // the whole environment: nothing of the worker's is inherited
  signal: AbortSignal
  line?: (line: string) => void // each line of stdout
}

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g

// Runs a command in its own process group and resolves with its stdout. An
// abort kills the whole group (frames' Chrome and ffmpeg with it), and so does
// a normal exit, so nothing it started outlives it.
export function run(cmd: string, args: string[], o: Run): Promise<string> {
  return new Promise((resolve, reject) => {
    if (o.signal.aborted) return reject(o.signal.reason)
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already gone */ } }
    o.signal.addEventListener('abort', kill, { once: true })
    let out = ''
    const tail: string[] = []
    const keep = (l: string) => { l = l.replace(ANSI, '').trim(); if (l) { tail.push(l); if (tail.length > 20) tail.shift() } }
    createInterface({ input: child.stdout! }).on('line', (l) => {
      if (out.length < 1 << 20) out += l + '\n'
      keep(l)
      o.line?.(l.replace(ANSI, ''))
    })
    createInterface({ input: child.stderr! }).on('line', keep)
    child.on('error', (e) => { o.signal.removeEventListener('abort', kill); reject(new Fail(`${cmd} did not start: ${e.message}`)) })
    child.on('close', (code, sig) => {
      o.signal.removeEventListener('abort', kill)
      kill()
      if (o.signal.aborted) return reject(o.signal.reason)
      if (code === 0) return resolve(out)
      const last = tail.filter((l) => /error|fail|invalid|unable|cannot|not /i.test(l)).pop() ?? tail.at(-1) ?? ''
      reject(new Fail(`${cmd.split('/').pop()} exited ${code ?? sig}${last ? ': ' + last : ''}`))
    })
  })
}

// The environment a child gets: a path, a locale, and the home and temp dirs it
// may write. Credentials in the worker's environment never reach it.
export function env(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: home, TMPDIR: home, ...extra }
}
