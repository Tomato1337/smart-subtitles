import type { ToastAction } from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import { api, errorText } from '@/common/api/tauri'
import type { CardJob, CardJobEditor } from '@/common/types/ipc'
import { graceRemaining, useCardsStore } from '../store/cardsStore'
import { HoldClient, type HoldSender } from './hold'
import { islandSurface, type IslandOptions, type IslandSurface } from './island'
import {
  TASK_STEPS, taskActions, taskAnnouncementKey, taskDuration, taskIcon, taskMessage, taskMini, taskPinned, taskStep, taskTone, type TaskHandlers,
} from './task'

export type PresenterApi = {
  cardsJobCancel: (jobId: string, revision: number) => Promise<CardJob>
  cardsJobDelete: (jobId: string) => Promise<CardJob>
  cardsJobEdit: (jobId: string, refresh: boolean) => Promise<CardJobEditor>
  cardsJobRetry: (jobId: string) => Promise<CardJob>
}

export type PresenterDeps = {
  surface: IslandSurface
  api: PresenterApi
  notify: (message: string) => void
  sendHold: HoldSender
}

const DEFAULT_DEPS: PresenterDeps = {
  surface: islandSurface,
  api,
  notify: (message) => notify('error', message),
  sendHold: (jobId, clientId, held) => api.cardsJobHold(jobId, clientId, held),
}

/** One island per explicit quick job: creation, progress, holds and the actions. */
export class Presenter {
  toastId: number | null = null
  readonly hold: HoldClient

  private readonly jobId: string
  private readonly deps: PresenterDeps
  private disposed = false
  private lastState: CardJob['state'] | null = null
  private lastAnnounced = ''
  private actionState: string | null = null
  private cachedActions: readonly ToastAction[] | undefined = undefined
  private readonly handlers: TaskHandlers = {
    edit: () => this.edit(),
    cancel: () => this.cancel(),
    remove: () => this.remove(),
    retry: () => this.retry(),
  }

  constructor(jobId: string, deps: Partial<PresenterDeps> = {}) {
    this.jobId = jobId
    this.deps = {
      surface: deps.surface ?? DEFAULT_DEPS.surface,
      api: deps.api ?? DEFAULT_DEPS.api,
      notify: deps.notify ?? DEFAULT_DEPS.notify,
      sendHold: deps.sendHold ?? DEFAULT_DEPS.sendHold,
    }
    this.hold = new HoldClient(jobId, this.deps.sendHold)
  }

  render() {
    if (this.disposed) return
    const job = useCardsStore.getState().jobs[this.jobId]
    if (!job) return
    // A hold pauses only the grace window; entering work means the lease has no further effect.
    if (job.state !== 'grace') this.hold.release()
    const text = taskMessage(job, this.graceSeconds(job))
    if (this.toastId === null) {
      // The kit notifies subscribers synchronously from `show`; claim the identity afterwards.
      useCardsStore.getState().setToastId(this.jobId, null)
      this.toastId = this.deps.surface.show(text, this.options(job, true))
      useCardsStore.getState().setToastId(this.jobId, this.toastId)
      this.lastState = job.state
      this.lastAnnounced = taskAnnouncementKey(job)
      return
    }
    if (!this.isCurrent()) return
    const stateChanged = job.state !== this.lastState
    this.deps.surface.update(this.toastId, { message: text, options: this.options(job, stateChanged) })
    this.lastState = job.state
    const key = taskAnnouncementKey(job)
    if (key !== this.lastAnnounced) {
      this.lastAnnounced = key
      // Only the still-current task is announced; a replaced message is not resurrected.
      if (this.isCurrent()) this.deps.surface.announce(text)
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.hold.release()
    if (this.isCurrent()) this.deps.surface.hide(this.toastId ?? undefined)
    useCardsStore.getState().clearTask(this.jobId)
  }

  private isCurrent(): boolean {
    if (this.toastId === null) return false
    const now = this.deps.surface.current()
    return now.message !== null && now.seq === this.toastId
  }

  private graceSeconds(job: CardJob): number {
    const view = useCardsStore.getState().grace[job.id]
    return Math.ceil((view ? graceRemaining(view) : job.remainingMs) / 1000)
  }

  private actions(job: CardJob): readonly ToastAction[] | undefined {
    const key = `${job.state}:${job.hasCommittedNote ? 'owned' : 'new'}`
    if (this.actionState !== key) {
      this.actionState = key
      this.cachedActions = taskActions(job, this.handlers)
    }
    return this.cachedActions
  }

  private progress(job: CardJob): IslandOptions['progress'] {
    if (job.state !== 'grace') return undefined
    const view = useCardsStore.getState().grace[job.id]
    if (!view) return undefined
    return {
      value: Math.min(1, Math.max(0, view.remainingMs / 5000)),
      label: 'Окно отмены',
      // Read by the animation frame; this never renders React and never drives the add.
      clock: () => {
        const latest = useCardsStore.getState().grace[job.id]
        return latest ? Math.min(1, Math.max(0, graceRemaining(latest) / 5000)) : 0
      },
    }
  }

  /** A duration belongs to the new state only: confirmations keep their remaining dismiss time. */
  private options(job: CardJob, withDuration: boolean): IslandOptions {
    const current = taskStep(job)
    const options: IslandOptions = {
      icon: taskIcon(job),
      tone: taskTone(job),
      actions: this.actions(job),
      progress: this.progress(job),
      steps: current === null ? undefined : { current, total: TASK_STEPS },
      word: job.word,
      mini: taskMini(job),
      pinned: taskPinned(job),
      onInteractionChange: this.hold.onInteraction,
    }
    if (withDuration) options.durationMs = taskDuration(job)
    return options
  }

  private async run(operation: () => Promise<void>) {
    try {
      await operation()
    } catch (e) {
      this.deps.notify(errorText(e))
      // The task stays truthful and visible: a rejected action is not a dismissal.
      this.render()
    }
  }

  async edit() {
    const job = useCardsStore.getState().jobs[this.jobId]
    if (!job) return
    await this.run(async () => {
      const editor = await this.deps.api.cardsJobEdit(job.id, true)
      useCardsStore.getState().openEditor(editor)
      if (this.isCurrent()) this.deps.surface.hide(this.toastId ?? undefined)
      useCardsStore.getState().clearTask(this.jobId)
    })
  }

  async cancel() {
    const job = useCardsStore.getState().jobs[this.jobId]
    if (!job) return
    await this.run(async () => {
      // The latest revision at click time; the backend confirms the state before we claim it.
      useCardsStore.getState().upsert(await this.deps.api.cardsJobCancel(job.id, job.revision))
    })
    this.render()
  }

  async remove() {
    const job = useCardsStore.getState().jobs[this.jobId]
    if (!job) return
    await this.run(async () => {
      useCardsStore.getState().upsert(await this.deps.api.cardsJobDelete(job.id))
    })
    this.render()
  }

  async retry() {
    const job = useCardsStore.getState().jobs[this.jobId]
    if (!job) return
    await this.run(async () => {
      useCardsStore.getState().upsert(await this.deps.api.cardsJobRetry(job.id))
    })
    this.render()
  }
}
