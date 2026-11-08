import { errorText } from '@/common/api/tauri'
import { codecFromInit, evictions, rangeAt, takeAppend, toRanges, type Range } from './mseBuffer'

/** Seconds kept behind the playhead. */
const BACK = 90
/** Seconds kept ahead of the playhead. */
const AHEAD_KEEP = 180
/** Stop reading ffmpeg while this much is buffered ahead of the playhead. */
const READ_AHEAD = 60
/** Unappended bytes above which reading pauses too, so a stuck append cannot grow memory without bound. */
const PENDING_LIMIT = 4 << 20
/** A seek up to this far past the streamed range is still served by the running ffmpeg. */
const REUSE_GAP = 15
/** Forward hole the player may hop over while stalled: corrupt source data leaves holes of a few seconds. */
const GAP_JUMP = 5
/** Playback stalled outside the range the stream is filling for this long: restart the stream at the playhead. */
const STALL_RESTART = 3000
const MAX_FAILS = 3
/** After a decode error playback resumes this far past the broken spot (corrupt torrent bytes span a few seconds). */
const ERROR_SKIP = 2
/** More decode errors than this within ERROR_WINDOW_MS: the source is hopeless, report instead of looping. */
const MAX_ERRORS = 6
const ERROR_WINDOW_MS = 60_000
/** A new stream has "landed" once this much of it reached the SourceBuffer (the init segment is ~1–2 KB). */
const LANDED_BYTES = 64 << 10
/** A stream that delivers nothing for this long no longer suspends the stall handling. */
const LANDING_TIMEOUT = 30_000
/** Give up looking for the init segment after this many bytes. */
const INIT_LIMIT = 1 << 20
/**
 * Bytes per appendBuffer(). After a stall the queue holds several megabytes; appending them in one
 * call made WebKitGTK parse them in one go on the main thread, which was the next stall.
 */
const APPEND_MAX = 1 << 20

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function merge(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
 const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
 let at = 0
 for (const c of chunks) {
  out.set(c, at)
  at += c.length
 }
 return out
}

/**
  * Funnels the live fMP4 stream into a MediaSource and keeps a bounded buffer window, so seeking inside it only
  * moves `currentTime`; only seeks outside restart ffmpeg. Segments carry absolute timestamps, hence media time
  * equals absolute movie time.
  */
export class MseStream {
 private readonly video: HTMLVideoElement
 private readonly duration: number
 private readonly openUrl: (t: number) => Promise<string>
 private readonly onError: (msg: string) => void
 private ms: MediaSource | null = null
 private objUrl = ''
 private sb: SourceBuffer | null = null
 /** Aborts the fetch of the current stream. */
 private ctrl: AbortController | null = null
 /** Bumped by load/clear/destroy: every await re-checks it and stale work exits silently. */
 private gen = 0
 private streaming = false
 private pending: Uint8Array<ArrayBuffer>[] = []
 private pendingBytes = 0
 private removals: Range[] = []
 /** The parser must be reset before the next append (set when a removal was in flight). */
 private reset = false
 private retry: ReturnType<typeof setTimeout> | undefined
 /** Used while there is no SourceBuffer yet; applied on 'loadedmetadata'. */
 private pendingSeek: { t: number; autoplay: boolean } | null = null
 private fails = 0
 private lastEvict = 0
 private stallSince = 0
 /** `/media/{sid}/flow` of the running stream: pausing it stops ffmpeg instead of buffering in the browser. */
 private flowUrl = ''
 /** Serializes control requests so a slow pause cannot arrive after the matching resume. */
 private flowRequests: Promise<void> = Promise.resolve()
 private paused = false
 private sourceOpen: Promise<void> = Promise.resolve()
 /** Date.now() of recent decode-error recoveries. */
 private errorTimes: number[] = []
 /** Date.now() when the current stream was started with old data in the SourceBuffer; 0 once it delivered. */
 private landingSince = 0
 private landingBytes = 0
 /** WebKit may reset currentTime before firing a decode error; keep the last usable media time. */
 private position = 0
 private lastDataAt = 0

 constructor(
  video: HTMLVideoElement,
  duration: number,
  openUrl: (t: number) => Promise<string>,
  onError: (msg: string) => void,
 ) {
  this.video = video
  this.duration = duration
  this.openUrl = openUrl
  this.onError = onError
  if (typeof MediaSource === 'undefined') {
   onError('MSE недоступен в WebView')
   return
  }
  this.video.addEventListener('loadedmetadata', this.onLoadedMetadata)
  this.video.addEventListener('error', this.onVideoError)
  this.video.addEventListener('timeupdate', this.rememberTime)
  this.open()
 }

 /** Attaches a fresh MediaSource to the element; the SourceBuffer is created by the first load. */
 private open(): void {
  const ms = new MediaSource()
  this.ms = ms
  this.sb = null
  if (this.objUrl) URL.revokeObjectURL(this.objUrl)
  this.objUrl = URL.createObjectURL(ms)
  this.sourceOpen = new Promise<void>((resolve) => {
   ms.addEventListener(
    'sourceopen',
    () => {
     if (this.duration > 0) ms.duration = this.duration
     resolve()
    },
    { once: true },
   )
  })
  this.video.src = this.objUrl
 }

 /**
   * A decode error (corrupt bytes from the torrent) kills the element's MediaSource: no seek or append works
   * after it. Rebuild it and stream again from just past the broken spot.
   */
 private readonly onVideoError = () => {
  if (!this.ms || this.video.error?.code !== MediaError.MEDIA_ERR_DECODE) return
  const now = Date.now()
  this.errorTimes = [...this.errorTimes.filter((x) => now - x < ERROR_WINDOW_MS), now]
  if (this.errorTimes.length > MAX_ERRORS) {
   this.stopReading()
   this.onError('Раздача отдаёт битые данные — видео не декодируется')
   return
  }
  this.rebuild(Math.min(this.position + ERROR_SKIP, Math.max(0, this.duration - 1)), true)
 }

 /** Drops the dead MediaSource and starts a new stream at t. */
 private rebuild(t: number, autoplay: boolean): void {
  this.stopReading()
  clearTimeout(this.retry)
  this.retry = undefined
  this.removals = []
  this.reset = false
  this.fails = 0
  this.open()
  void this.load(t, autoplay)
 }

 /** Movie time survives an element reset and is also the position safe to persist. */
 currentTime(): number {
  this.rememberTime()
  return this.position
 }

 private readonly rememberTime = () => {
  if (this.pendingSeek || this.video.error || this.video.readyState === 0) return
  const t = this.video.currentTime
  if (t > this.position) this.fails = 0
  this.position = t
 }

 /** 'local' — only currentTime moved; 'stream' — ffmpeg restarted at t. */
 seek(t: number, autoplay: boolean): 'local' | 'stream' {
  if (!this.ms) return 'local'
  // An element in the error state ignores currentTime: a seek is the user's way out of it.
  if (this.video.error) {
   this.rebuild(t, autoplay)
   return 'stream'
  }
  const r = rangeAt(this.ranges(), t)
  const live = this.liveRange()
  const buffered = r !== null && r[1] - t > 1
  const streamed = this.streaming && live !== null && t >= live[0] && t <= live[1] + REUSE_GAP
  if (buffered || streamed) {
   this.move(t, autoplay)
   return 'local'
  }
  this.fails = 0
  void this.load(t, autoplay)
  return 'stream'
 }

 /** Forces a new ffmpeg stream from t (after clear()). */
 restart(t: number, autoplay: boolean): void {
  this.fails = 0
  void this.load(t, autoplay)
 }

 /** Drops everything buffered (audio track change). */
 async clear(): Promise<void> {
  this.gen++
  this.ctrl?.abort()
  this.streaming = false
  this.pending = []
  this.pendingBytes = 0
  this.removals = []
  this.reset = false
  this.paused = false
  this.flowUrl = ''
  clearTimeout(this.retry)
  this.retry = undefined
  const sb = this.sb
  const ms = this.ms
  if (!sb || !ms) return
  if (ms.readyState === 'open' && sb.updating) {
   // A removal cannot start while an append is running: let it finish first.
   await new Promise<void>((resolve) => sb.addEventListener('updateend', () => resolve(), { once: true }))
   if (ms.readyState !== 'open') return
  }
  if (ms.readyState === 'open') this.abortSilently(sb)
  else if (ms.readyState !== 'ended') return
  if (!Number.isFinite(ms.duration) || ms.duration <= 0) return
  const updated = new Promise<void>((resolve) => sb.addEventListener('updateend', () => resolve(), { once: true }))
  try {
   // In the 'ended' state the removal itself moves the MediaSource back to 'open'.
   sb.remove(0, ms.duration)
  } catch (e) {
   this.onError(errorText(e))
   return
  }
  await updated
 }

 /** Called every 100 ms by the controller: stall handling + eviction (eviction at most every 5 s). */
 maintain(): void {
  const ms = this.ms
  if (!ms) return
  const ct = this.currentTime()
  this.healStall(ct)
  if (this.paused && this.ahead() < READ_AHEAD * 0.6 && this.pendingBytes < PENDING_LIMIT) this.setFlow(false)
  // Removing from an 'ended' MediaSource reopens it, and the element then waits instead of finishing.
  if (ms.readyState === 'ended') return
  if (Date.now() - this.lastEvict > 5000) {
   this.lastEvict = Date.now()
   this.removals.push(...evictions(this.ranges(), ct, BACK, AHEAD_KEEP))
   this.pump()
  }
 }

 destroy(): void {
  this.gen++
  this.ctrl?.abort()
  clearTimeout(this.retry)
  this.retry = undefined
  this.video.removeEventListener('loadedmetadata', this.onLoadedMetadata)
  this.video.removeEventListener('error', this.onVideoError)
  this.video.removeEventListener('timeupdate', this.rememberTime)
  this.video.removeAttribute('src')
  this.video.load()
  if (this.objUrl) URL.revokeObjectURL(this.objUrl)
  this.ms = null
  this.sb = null
 }

 private readonly onLoadedMetadata = () => {
  const ps = this.pendingSeek
  if (!ps) return
  this.video.currentTime = ps.t
  if (ps.autoplay) void this.video.play().catch(() => { })
  this.pendingSeek = null
 }

 private move(t: number, autoplay: boolean): void {
  this.position = t
  this.video.currentTime = t
  if (autoplay && this.video.paused) void this.video.play().catch(() => { })
 }

 private abortSilently(sb: SourceBuffer): void {
  try {
   sb.abort()
  } catch {
   /* the readyState changed under us; nothing to abort */
  }
 }

 private ranges(): Range[] {
  return toRanges(this.video.buffered)
 }

 /** Range the current stream is feeding: the one under the playhead, else a following one within a hole. */
 private liveRange(): Range | null {
  const sb = this.sb
  if (!sb) return null
  const ct = this.currentTime()
  const rs = toRanges(sb.buffered)
  const here = rangeAt(rs, ct)
  if (here) return here
  return rs.filter((r) => r[0] > ct && r[0] - ct <= GAP_JUMP).sort((a, b) => a[0] - b[0])[0] ?? null
 }

 private ahead(): number {
  const r = this.liveRange()
  return r ? r[1] - this.currentTime() : 0
 }

 /** True while the newest stream has not delivered media yet (see healStall). */
 private landing(): boolean {
  if (this.landingSince === 0) return false
  const delivered = this.landingBytes > LANDED_BYTES && this.pending.length === 0 && !this.sb?.updating
  if (delivered || Date.now() - this.landingSince > LANDING_TIMEOUT) this.landingSince = 0
  return this.landingSince !== 0
 }

 /** Hops over small holes and restarts streams that stopped supplying playable data. */
 private healStall(ct: number): void {
  if (this.video.readyState >= 3) {
   this.stallSince = 0
   return
  }
  if (this.sb && this.streaming && !this.video.paused && Date.now() - this.lastDataAt > LANDING_TIMEOUT) {
   if (++this.fails > MAX_FAILS) {
    this.stopReading()
    this.onError('Поток завис: новые данные не приходят в плеер')
   } else {
    void this.load(ct, true, false)
   }
   return
  }
  if (this.landing()) {
   // The stream just started for this position has not delivered yet (a remote torrent needs 5–15 s). Ranges
   // ahead are left over from before the seek: hopping onto them would undo the seek, and restarting would
   // only throw away the connection that is about to deliver.
   this.stallSince = 0
   return
  }
  const rs = this.ranges()
  const here = rangeAt(rs, ct)
  if (!here) {
   const hole = rs.filter((r) => r[0] > ct).sort((a, b) => a[0] - b[0])[0]
   if (hole && hole[0] - ct <= GAP_JUMP) {
    this.move(hole[0], !this.video.paused)
    this.stallSince = 0
    return
   }
  }
  const live = this.liveRange()
  // The stream is filling the range the playhead is in: it just needs time. Without any buffered data nearby
  // there is nothing to compare with either — the running load may still deliver.
  if (!live || (here && here[0] === live[0])) {
   this.stallSince = 0
   return
  }
  if (this.stallSince === 0) this.stallSince = Date.now()
  if (Date.now() - this.stallSince > STALL_RESTART) {
   this.stallSince = 0
   void this.load(ct, !this.video.paused, false)
  }
 }

 /**
   * Starts a stream at t. `seek` moves the playhead there; recovery restarts keep it where it is, because the
   * buffered data in front of it is still playable.
   */
 private async load(t: number, autoplay: boolean, seek = true): Promise<void> {
  const ms = this.ms
  if (!ms) return
  const g = ++this.gen
  const ctrl = new AbortController()
  this.ctrl?.abort()
  this.ctrl = ctrl
  this.pending = []
  this.pendingBytes = 0
  if (this.sb && ms.readyState === 'open') {
   // A removal in flight would reject abort(): reset the parser before the next append instead.
   if (this.sb.updating) this.reset = true
   else this.abortSilently(this.sb)
  }
  this.streaming = true
  this.stallSince = 0
  this.paused = false
  this.flowUrl = ''
  this.flowRequests = Promise.resolve()
  this.lastDataAt = Date.now()
  // Without a SourceBuffer there is no old data around to confuse the stall heuristics.
  this.landingSince = this.sb ? Date.now() : 0
  this.landingBytes = 0
  if (this.sb) {
   this.pendingSeek = null
   if (seek) this.move(t, autoplay)
  } else {
   this.pendingSeek = { t, autoplay }
   this.position = t
  }
  let appended = 0
  try {
   const res = await this.connect(g, t, ctrl)
   if (!res) return
   this.flowUrl = res.url.replace('/stream?', '/flow?')
   const reader = res.body!.getReader()
   let head: Uint8Array<ArrayBuffer> | null = this.sb ? null : new Uint8Array(0)
   for (; ;) {
    // The body is drained continuously: WebKit buffers a paused fetch body without bound, so the back pressure
    // goes to the server instead, and it stops reading ffmpeg.
    const { done, value } = await reader.read()
    if (g !== this.gen) return
    if (done) break
    this.lastDataAt = Date.now()
    if (this.sb) {
     this.enqueue(value)
     appended += value.length
     this.landingBytes += value.length
     if (this.ahead() > READ_AHEAD || this.pendingBytes > PENDING_LIMIT) this.setFlow(true)
     continue
    }
    head = merge([head ?? new Uint8Array(0), value])
    const codec = codecFromInit(head)
    if (!codec) {
     if (head.length > INIT_LIMIT) {
      this.onError('В потоке нет avcC')
      ctrl.abort()
      return
     }
     continue
    }
    if (!(await this.attach(ms, g, codec))) return
    const init = head
    head = null
    this.enqueue(init)
    appended += init.length
    if (this.ahead() > READ_AHEAD || this.pendingBytes > PENDING_LIMIT) this.setFlow(true)
   }
  } catch (e) {
   if (e instanceof Error && e.name === 'AbortError') return
   if (g !== this.gen) return
   this.stopReading()
   this.onError(errorText(e))
   return
  }
  await this.finish(g, appended)
 }

 /** Abandons the current fetch and anything queued for it. */
 private stopReading(): void {
  this.gen++
  this.ctrl?.abort()
  this.paused = false
  this.flowUrl = ''
  this.streaming = false
  this.pending = []
  this.pendingBytes = 0
 }

 /** Applies pause/resume in order; each request remains tied to its stream generation. */
 private setFlow(paused: boolean): void {
  if (!this.flowUrl || this.paused === paused) return
  this.paused = paused
  const url = this.flowUrl
  const g = this.gen
  this.flowRequests = this.flowRequests.then(async () => {
   if (g !== this.gen) return
   const res = await fetch(url, { method: 'POST', body: paused ? 'pause' : 'resume' })
   if (!res.ok) throw new Error(`Управление потоком: HTTP ${res.status}`)
  }).catch((e: unknown) => {
   if (g !== this.gen) return
   this.stopReading()
   this.onError(errorText(e))
  })
 }

 /** Opens the stream URL and fetches it; null (after reporting) when the stream cannot be read. */
 private async connect(g: number, t: number, ctrl: AbortController): Promise<Response | null> {
  let url: string
  try {
   url = await this.openUrl(t)
  } catch (e) {
   if (g === this.gen) {
    this.streaming = false
    this.onError(errorText(e))
   }
   return null
  }
  if (g !== this.gen) return null
  const res = await fetch(url, { signal: ctrl.signal })
  if (g !== this.gen) return null
  if (res.ok) return res
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  if (g !== this.gen) return null
  this.streaming = false
  this.onError(body?.error ?? `HTTP ${res.status}`)
  return null
 }

 /** Creates the SourceBuffer for `codec` once the MediaSource is open. */
 private async attach(ms: MediaSource, g: number, codec: string): Promise<boolean> {
  await this.sourceOpen
  if (g !== this.gen) return false
  try {
   this.sb = ms.addSourceBuffer(codec)
  } catch (e) {
   this.streaming = false
   this.onError(errorText(e))
   return false
  }
  this.sb.addEventListener('updateend', () => this.pump())
  return true
 }

 /** The stream stopped by itself: either the media ended or the torrent read failed. */
 private async finish(g: number, appended: number): Promise<void> {
  this.streaming = false
  while ((this.pending.length > 0 || this.sb?.updating) && g === this.gen) await sleep(100)
  if (g !== this.gen) return
  const live = this.liveRange()
  if (live && live[1] >= this.duration - 1) {
   if (this.ms && this.ms.readyState === 'open') this.ms.endOfStream()
   return
  }
  this.fails = appended >= INIT_LIMIT ? 1 : this.fails + 1
  if (this.fails > MAX_FAILS) {
   this.onError('Поток оборвался: TorrServer не отдаёт данные')
   return
  }
  // Continue reading where the data stopped; the playhead stays where it is and plays the buffer out first.
  void this.load(live ? live[1] : this.currentTime(), !this.video.paused, false)
 }

 private enqueue(c: Uint8Array<ArrayBuffer>): void {
  this.pending.push(c)
  this.pendingBytes += c.length
  this.pump()
 }

 private pump(): void {
  const sb = this.sb
  if (!sb || sb.updating) return
  if (this.reset) {
   this.reset = false
   this.abortSilently(sb)
  }
  const rm = this.removals.shift()
  if (rm) {
   try {
    sb.remove(rm[0], rm[1])
   } catch (e) {
    this.onError(errorText(e))
   }
   return
  }
  // One capped slice per call; `updateend` calls pump() again for the rest.
  const buf = takeAppend(this.pending, APPEND_MAX)
  if (!buf) return
  this.pendingBytes -= buf.length
  try {
   sb.appendBuffer(buf)
  } catch (e) {
   if (!(e instanceof DOMException && e.name === 'QuotaExceededError')) {
    // A failed append leaves the SourceBuffer unusable: keeping the fetch running would only repeat the error.
    this.stopReading()
    this.onError(errorText(e))
    return
   }
   this.pending.unshift(buf)
   this.pendingBytes += buf.length
   this.removals.push(...evictions(this.ranges(), this.currentTime(), 10, 30))
   if (this.removals.length > 0) this.pump()
   else if (!this.retry) {
    this.retry = setTimeout(() => {
     this.retry = undefined
     this.pump()
    }, 1000)
   }
  }
 }
}
