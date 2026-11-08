/// <reference lib="es2024.promise" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MseStream } from './MseStream'

const ranges = (end = 0): TimeRanges => ({ length: end > 0 ? 1 : 0, start: () => 0, end: () => end })
const init = new Uint8Array([0, 0, 0, 16, 0x61, 0x76, 0x63, 0x43, 1, 0x64, 0, 0x28])

class Video extends EventTarget {
  currentTime = 0
  readyState = 0
  paused = false
  error: { code: number } | null = null
  buffered = ranges()
  src = ''
  play = vi.fn(async () => { this.paused = false })
  removeAttribute() { this.src = '' }
  load() { }
}

class Buffer extends EventTarget {
  updating = false
  buffered = ranges()
  appendBuffer() { queueMicrotask(() => this.dispatchEvent(new Event('updateend'))) }
  abort() { }
  remove() { queueMicrotask(() => this.dispatchEvent(new Event('updateend'))) }
}

class Source extends EventTarget {
  readyState = 'open'
  duration = 0
  buffer = new Buffer()
  addSourceBuffer() { return this.buffer }
  endOfStream = vi.fn(() => { this.readyState = 'ended' })
}

let sources: Source[]
let streams: MseStream[]
let readers: ReadableStreamDefaultController<Uint8Array>[]

beforeEach(() => {
  vi.useFakeTimers()
  sources = []
  streams = []
  readers = []
  vi.stubGlobal('MediaSource', class extends Source {
    constructor() { super(); sources.push(this); queueMicrotask(() => this.dispatchEvent(new Event('sourceopen'))) }
  })
  vi.stubGlobal('MediaError', { MEDIA_ERR_DECODE: 3 })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:movie')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => { })
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') return new Response(null, { status: 204 })
    const body = new ReadableStream<Uint8Array>({ start(c) { readers.push(c); c.enqueue(init) } })
    const res = new Response(body)
    Object.defineProperty(res, 'url', { value: url })
    return res
  }))
})

afterEach(() => {
  for (const stream of streams) stream.destroy()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function player(at = 1200) {
  const video = new Video()
  const open = vi.fn(async (t: number) => `http://localhost/media/movie/stream?start=${t}&gen=${open.mock.calls.length}`)
  const error = vi.fn()
  const stream = new MseStream(video as unknown as HTMLVideoElement, 6000, open, error)
  streams.push(stream)
  stream.seek(at, true)
  await vi.advanceTimersByTimeAsync(0)
  video.readyState = 3
  video.dispatchEvent(new Event('loadedmetadata'))
  video.buffered = sources[0].buffer.buffered = ranges(at + 30)
  stream.maintain()
  return { video, open, error, stream }
}

describe('MseStream recovery', () => {
  test('decode failure with a WebKit time reset resumes near the last played frame, not the movie start', async () => {
    const { video, open, stream } = await player()
    video.currentTime = 1234
    video.dispatchEvent(new Event('timeupdate'))
    stream.maintain()
    video.currentTime = 0
    video.readyState = 0
    video.error = { code: 3 }
    video.dispatchEvent(new Event('error'))
    await vi.advanceTimersByTimeAsync(0)
    expect(open.mock.calls.at(-1)?.[0]).toBe(1236)
    expect(stream.currentTime()).toBe(1236)
    video.error = null
    expect(stream.currentTime()).toBe(1236)
    video.readyState = 1
    expect(stream.currentTime()).toBe(1236)
    video.dispatchEvent(new Event('loadedmetadata'))
    expect(video.currentTime).toBe(1236)
  })

  test('a silent body with exhausted playable data reconnects at the playhead', async () => {
    const { video, open, stream } = await player()
    video.currentTime = 1230
    video.readyState = 2
    stream.maintain()
    await vi.advanceTimersByTimeAsync(31_000)
    stream.maintain()
    await vi.advanceTimersByTimeAsync(0)
    expect(open.mock.calls.at(-1)?.[0]).toBe(1230)
    expect(video.currentTime).toBe(1230)
  })

  test('short upstream EOF reconnects without ending the movie or moving the playhead', async () => {
    const { video, open } = await player()
    readers[0].close()
    await vi.advanceTimersByTimeAsync(200)
    expect(sources[0].endOfStream).not.toHaveBeenCalled()
    expect(open.mock.calls.at(-1)?.[0]).toBe(1230)
    expect(video.currentTime).toBe(1200)
  })

  test('intentional pause does not reconnect a silent stream', async () => {
    const { video, open, stream } = await player()
    video.paused = true
    video.readyState = 2
    const count = open.mock.calls.length
    await vi.advanceTimersByTimeAsync(31_000)
    stream.maintain()
    await vi.advanceTimersByTimeAsync(0)
    expect(open).toHaveBeenCalledTimes(count)
  })

  test('repeated silent streams stop with an error rather than reconnecting forever', async () => {
    const { video, open, error, stream } = await player()
    video.currentTime = 1230
    video.readyState = 2
    stream.maintain()
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(31_000)
      stream.maintain()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(open).toHaveBeenCalledTimes(4)
    expect(error).toHaveBeenCalledWith('Поток завис: новые данные не приходят в плеер')
    expect(stream.currentTime()).toBe(1230)
  })

  test('only EOF at the actual movie tail ends the MediaSource', async () => {
    const { video } = await player(5980)
    video.buffered = sources[0].buffer.buffered = ranges(6000)
    readers[0].close()
    await vi.advanceTimersByTimeAsync(200)
    expect(sources[0].endOfStream).toHaveBeenCalledOnce()
  })

  test('explicit backward seek replaces the saved position, unlike an element error reset', async () => {
    const { video, stream } = await player()
    stream.seek(300, false)
    expect(stream.currentTime()).toBe(300)
    expect(video.currentTime).toBe(300)
  })

  test('a delayed pause is applied before resume so the server cannot remain gated shut', async () => {
    const { video, stream } = await player()
    const baseFetch = fetch
    const applied: string[] = []
    const { promise: paused, resolve: releasePause } = Promise.withResolvers<void>()
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      if (options?.method !== 'POST') return baseFetch(url, options)
      if (options.body === 'pause') await paused
      applied.push(String(options.body))
      return new Response(null, { status: 204 })
    }))
    video.buffered = sources[0].buffer.buffered = ranges(1300)
    readers[0].enqueue(new Uint8Array(1))
    await vi.advanceTimersByTimeAsync(0)
    video.currentTime = 1280
    stream.maintain()
    await vi.advanceTimersByTimeAsync(0)
    expect(applied).toEqual([])
    releasePause()
    await vi.advanceTimersByTimeAsync(0)
    expect(applied).toEqual(['pause', 'resume'])
  })
})
