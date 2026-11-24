import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/common/api/tauri'
import type { KnownWord } from '@/common/types/ipc'

export const KNOWN_WORDS_KEY = ['known-words'] as const

/** Cached list of learner-marked known words (`known_word` SQLite table). */
export function useKnownWords() {
  return useQuery({
    queryKey: KNOWN_WORDS_KEY,
    queryFn: api.knownWordsList,
    staleTime: 30_000,
  })
}

/** Toggles a word in `known_word` and refreshes both the known-word cache and `/stats` queries. */
export function useSetKnownWord() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ word, known }: { word: string; known: boolean }) => api.knownWordSet(word, known),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KNOWN_WORDS_KEY })
      void qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })
}

function norm(s: string | null | undefined): string {
  return s?.trim().toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '') ?? ''
}

/** True when `span` or its resolved `lemma` already exists in the learner's known-word list. */
export function isWordKnown(words: KnownWord[] | undefined, span: string, lemma?: string | null): boolean {
  if (!words?.length) return false
  const a = norm(span)
  const b = norm(lemma)
  if (!a && !b) return false
  return words.some((w) => {
    const k = norm(w.lemma)
    const d = norm(w.display)
    return (a && (k === a || d === a)) || (b && (k === b || d === b))
  })
}
