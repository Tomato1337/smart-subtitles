export type HoldSender = (jobId: string, clientId: string, held: boolean) => Promise<unknown>

/**
 * One job/client lease: at most one request in flight, with the latest wanted state sent after its
 * acknowledgment. A held lease renews every 3 s; a lost release expires server-side after 10 s.
 */
export class HoldClient {
  readonly id: string

  private readonly jobId: string
  private readonly send: HoldSender
  private wanted = false
  private acked = false
  private inflight = false
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(jobId: string, send: HoldSender, id?: string) {
    this.jobId = jobId
    this.send = send
    this.id = id ?? globalThis.crypto?.randomUUID?.() ?? `card-${Math.random().toString(36).slice(2)}`
  }

  /** Called by the snackbar when hover or focus pauses/releases the grace countdown. */
  onInteraction = (paused: boolean) => {
    if (this.closed) return
    this.wanted = paused
    if (paused) this.startHeartbeat()
    else this.stopHeartbeat()
    this.sync()
  }

  /** Releases the effective hold and lets the lease expire if the release cannot be delivered. */
  release() {
    if (this.closed) return
    this.closed = true
    this.wanted = false
    this.stopHeartbeat()
    this.sync()
  }

  private startHeartbeat() {
    if (this.heartbeat !== null) return
    this.heartbeat = globalThis.setInterval(() => {
      if (this.closed || !this.wanted || this.inflight) return
      // The wanted state did not change; a renewal is an explicit send of `true`.
      this.sync(true)
    }, 3000)
  }

  private stopHeartbeat() {
    if (this.heartbeat !== null) {
      globalThis.clearInterval(this.heartbeat)
      this.heartbeat = null
    }
  }

  private sync(force = false) {
    if (this.inflight) return
    if (this.closed && this.wanted) return
    if (!force && this.wanted === this.acked) return
    if (force && !this.wanted) return
    const held = force ? true : this.wanted
    this.inflight = true
    let failed = false
    void this.send(this.jobId, this.id, held)
      .then(() => {
        this.acked = held
      })
      .catch(() => {
        failed = true
      })
      .finally(() => {
        this.inflight = false
        // A failed request must not retry in the same tick: the heartbeat retries a hold, and a
        // release is bounded by the server's lease expiry, so this can never spin.
        if (!failed) this.sync()
      })
  }
}
