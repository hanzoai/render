import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { probe } from '../src/measure.ts'
import { fake, media, NOFFMPEG, perform, png } from './fake.ts'
import type { Fake } from './fake.ts'

let f: Fake
before(async () => {
  f = await fake()
  if (NOFFMPEG) return
  f.files.set('lib_a.mp4', { type: 'video/mp4', body: await media('a.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']) })
  f.files.set('lib_b.mp4', { type: 'video/mp4', body: await media('b.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=25:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']) })
  f.files.set('lib_music.m4a', { type: 'audio/mp4', body: await media('music.m4a', ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=4', '-c:a', 'aac']) })
  f.files.set('lib_logo.png', { type: 'image/png', body: png(120, 60, [255, 255, 255]) })
})
after(() => f.close())

test('video.edit joins clips at the first clip size with captions, overlay and music', { skip: NOFFMPEG }, async () => {
  const inputs = Object.fromEntries(['lib_a.mp4', 'lib_b.mp4', 'lib_music.m4a', 'lib_logo.png'].map((n) => [n.split('.')[0], f.input(n)]))
  const { result, body } = await perform(f, {
    op: 'video.edit',
    with: {
      timeline: {
        clips: [{ asset: 'lib_a' }, { asset: 'lib_b' }],
        captions: [
          { text: "Caption with 'quotes', colons: {\\b1}tags\\N and %{pts} — kept literal, 中文", start: 0.5, end: 3 },
          { text: 'Top line', position: 'top' },
        ],
        overlays: [{ asset: 'lib_logo', x: 20, y: 20, start: 1, end: 3 }],
        audio: [{ asset: 'lib_music', volume: 0.5 }],
      },
    },
    inputs,
  })
  assert.equal(result.mime, 'video/mp4')
  assert.equal(result.width, 1280)
  assert.equal(result.height, 720)
  assert.ok(Math.abs(result.seconds! - 4) <= 0.15, `seconds ${result.seconds}`)
  const file = join(await mkdtemp(join(tmpdir(), 'out-')), 'out.mp4')
  await writeFile(file, body)
  const p = await probe(file, AbortSignal.timeout(30_000))
  assert.ok(p.audio, 'has an audio stream')
  assert.equal(p.width, 1280)
})

test('video.edit holds an image clip and encodes webm', { skip: NOFFMPEG }, async () => {
  const { result } = await perform(f, {
    op: 'video.edit',
    with: { timeline: { width: 320, height: 240, fps: 24, format: 'webm', clips: [{ asset: 'lib_logo', seconds: 1.5 }, { asset: 'lib_b', start: 0.5, end: 1.5 }] } },
    inputs: { lib_logo: f.input('lib_logo.png'), lib_b: f.input('lib_b.mp4') },
  })
  assert.equal(result.mime, 'video/webm')
  assert.equal(result.width, 320)
  assert.equal(result.height, 240)
  assert.ok(Math.abs(result.seconds! - 2.5) <= 0.15, `seconds ${result.seconds}`)
})
