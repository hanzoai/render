// One JSON object per line on stdout. Callers never pass a URL or a token.
export function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + '\n')
}
