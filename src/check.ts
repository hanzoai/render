// Boundary checks on a job's input. A Fail is the job's fault, not the worker's:
// its message is the one-line cause reported to the engine.

export class Fail extends Error {}

// The one line a failure is reported as: URLs (signed ones included) redacted,
// whitespace collapsed, bounded.
export function cause(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').replace(/\s+/g, ' ').trim().slice(0, 300) || 'render failed'
}

export function obj(v: unknown, name: string): Record<string, any> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Fail(`${name} must be an object`)
  return v as Record<string, any>
}

export function list(v: unknown, name: string, min: number, max: number): any[] {
  if (v === undefined && min === 0) return []
  if (!Array.isArray(v) || v.length < min || v.length > max) throw new Fail(`${name} must be a list of ${min} to ${max} items`)
  return v
}

export function str(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string' || v.length > max) throw new Fail(`${name} must be a string of at most ${max} characters`)
  return v
}

// An optional string: absent or null is empty.
export function opt(v: unknown, name: string, max: number): string {
  return v === undefined || v === null ? '' : str(v, name, max)
}

export function num(v: unknown, name: string, lo: number, hi: number, def?: number): number {
  if ((v === undefined || v === null) && def !== undefined) return def
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Fail(`${name} must be a number from ${lo} to ${hi}`)
  return v
}

export function int(v: unknown, name: string, lo: number, hi: number, def?: number): number {
  const n = num(v, name, lo, hi, def)
  if (!Number.isInteger(n)) throw new Fail(`${name} must be an integer`)
  return n
}

export function pick<T extends string>(v: unknown, name: string, of: readonly T[], def: T): T {
  if (v === undefined || v === null) return def
  if (!of.includes(v as T)) throw new Fail(`${name} must be one of ${of.join(', ')}`)
  return v as T
}
