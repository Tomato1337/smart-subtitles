import { useQuery } from '@tanstack/react-query'
import { api } from '@/common/api/tauri'

/** Lookup frequency, CEFR level, and film occurrence count for one span. */
export function useVocabLookup(span: string | null | undefined, mediaId?: string | null) {
  const trimmed = span?.trim() ?? ''
  return useQuery({
    queryKey: ['vocab', mediaId ?? '', trimmed],
    queryFn: async () => (await api.vocabLookup([trimmed], mediaId))[0],
    enabled: trimmed.length > 0,
    staleTime: Infinity,
  })
}

/** Batch lookup frequency and CEFR metadata for a list of words/phrases (e.g. Agent proposals). */
export function useVocabBatch(spans: string[], mediaId?: string | null) {
  const clean = spans.map((s) => s.trim())
  return useQuery({
    queryKey: ['vocab-batch', mediaId ?? '', clean.join('\0')],
    queryFn: () => api.vocabLookup(clean, mediaId),
    enabled: clean.some((s) => s.length > 0),
    staleTime: Infinity,
  })
}
