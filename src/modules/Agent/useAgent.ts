import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect } from 'react'
import { api, errorText, onEvent } from '@/common/api/tauri'
import type { ChatMessage } from '@/common/types/ipc'
import { toast } from '@/common/ui/toast'
import { useAgentStore } from './store/agentStore'

export const agentKey = (mediaId: string) => ['agent', mediaId] as const

/** Learner's place in the film sent with every message: the cue (null before the first one) and the film time. */
export type AgentPosition = { cueIdx: number | null; at: number }
/** Current position, or the position of a specific cue when the question is about it. */
export type Locate = (cueIdx?: number) => AgentPosition

export function useAgentEvents(mediaId: string) {
  const qc = useQueryClient()
  useEffect(() => {
    const s = () => useAgentStore.getState()
    s().finish()
    const mine = <T extends { mediaId: string }>(f: (e: T) => void) => (e: T) => { if (e.mediaId === mediaId) f(e) }
    const refresh = () => qc.invalidateQueries({ queryKey: agentKey(mediaId) })
    const un = [
      onEvent('agent:delta', mine((e) => s().delta(e.text))),
      onEvent('agent:tool', mine((e) => s().tool(e.name))),
      onEvent('agent:proposal', mine(() => void refresh())),
      onEvent('agent:done', mine(() => { void refresh().then(() => s().finish()) })),
      onEvent('agent:error', mine((e) => { s().finish(e.message); void refresh() })),
      onEvent('cards:result', mine(() => void refresh())),
    ]
    return () => { un.forEach((p) => void p.then((f) => f())) }
  }, [mediaId, qc])
}

export function useAgentActions(mediaId: string, locate: Locate) {
  const qc = useQueryClient()

  /** Opens the chat and sends `text` tagged with the position (of `cueIdx` if given, else of the playhead). */
  const ask = useCallback(async (text: string, cueIdx?: number) => {
    const st = useAgentStore.getState()
    const pos = locate(cueIdx)
    st.setOpen(true)
    st.begin()
    try {
      await api.agentSend(mediaId, pos.cueIdx, pos.at, text)
      void qc.invalidateQueries({ queryKey: agentKey(mediaId) })
    } catch (e) {
      useAgentStore.getState().finish(errorText(e))
      toast(errorText(e))
    }
  }, [mediaId, qc, locate])

  /** Opens the chat and sends the prompt unless the same user message is already in the film's thread. */
  const askOnce = useCallback(async (text: string, cueIdx?: number) => {
    useAgentStore.getState().setOpen(true)
    const history = await qc.fetchQuery({ queryKey: agentKey(mediaId), queryFn: () => api.agentHistory(mediaId), staleTime: 0 })
    if (history.some((m: ChatMessage) => m.role === 'user' && m.text === text)) return
    await ask(text, cueIdx)
  }, [mediaId, qc, ask])

  return { ask, askOnce }
}

export const cueExplainPrompt = (text: string) =>
  `Объясни фразу: «${text.replace(/\s*\n\s*/g, ' ')}» — смысл в контексте сцены, разбор конструкции и трудных слов.`
