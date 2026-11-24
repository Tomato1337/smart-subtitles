import type { ExplainFrequency, VocabInfo, VocabTier } from '@/common/types/ipc'

export type BadgeTone = 'success' | 'primary' | 'neutral' | 'warning'

export type FrequencyBadge = {
  label: string
  tone: BadgeTone
  hint: string
  isAiEstimate: boolean
}

const CORPUS_TIER_LABEL: Record<VocabTier, { label: string; tone: BadgeTone; hint: string }> = {
  core: {
    label: 'Базовое',
    tone: 'success',
    hint: 'Основа речи (топ-3000) — точно стоит учить',
  },
  common: {
    label: 'Частое',
    tone: 'primary',
    hint: 'Часто встречается в фильмах — полезно выучить',
  },
  uncommon: {
    label: 'Среднее',
    tone: 'neutral',
    hint: 'Встречается иногда — учи по необходимости',
  },
  rare: {
    label: 'Редкое',
    tone: 'warning',
    hint: 'Редкое слово — можно пропустить',
  },
}

const AI_FREQ_LABEL: Record<ExplainFrequency, { label: string; tone: BadgeTone; hint: string }> = {
  very_common: {
    label: 'Очень частое',
    tone: 'success',
    hint: 'Оценка ИИ: очень частое выражение в живой речи',
  },
  common: {
    label: 'Частое',
    tone: 'primary',
    hint: 'Оценка ИИ: частое выражение в живой речи',
  },
  uncommon: {
    label: 'Среднее',
    tone: 'neutral',
    hint: 'Оценка ИИ: встречается нечасто',
  },
  rare: {
    label: 'Редкое',
    tone: 'warning',
    hint: 'Оценка ИИ: редкое выражение — можно пропустить',
  },
}

const PART_TIER_SHORT: Record<VocabTier, string> = {
  core: 'базовое',
  common: 'частое',
  uncommon: 'среднее',
  rare: 'редкое',
}

/** Human-readable summary of corpus ranks and Zipf, or constituent words for unindexed phrases. */
export function formatCorpusSummary(vocab: VocabInfo): string {
  const bits: string[] = []
  if (vocab.ranks.ngsl !== null) bits.push(`NGSL #${vocab.ranks.ngsl}`)
  if (vocab.ranks.ngslSpoken !== null) bits.push(`Разговорное #${vocab.ranks.ngslSpoken}`)
  if (vocab.ranks.bsl !== null) bits.push(`Бизнес #${vocab.ranks.bsl}`)
  if (vocab.ranks.subtitles !== null) bits.push(`Субтитры #${vocab.ranks.subtitles}`)
  if (vocab.zipf !== null) bits.push(`Zipf ${vocab.zipf.toFixed(1)}`)
  if (bits.length > 0) return bits.join(' · ')
  if (!vocab.isPhrase && !vocab.found) return 'нет в топ-50 000 слов субтитров'
  if (vocab.isPhrase && !vocab.found) {
    const content = vocab.parts.filter((p) => !p.functionWord)
    if (content.length > 0) {
      return `слова: ${content
        .map((p) => {
          const meta = [p.tier ? PART_TIER_SHORT[p.tier] : null, p.cefr].filter(Boolean).join(', ')
          return meta ? `${p.word} (${meta})` : p.word
        })
        .join(', ')}`
    }
  }
  return ''
}

/** Corpus frequency wins whenever available; AI frequency only covers unindexed phrases or pending lookups. */
export function resolveFrequencyBadge(
  vocab?: VocabInfo | null,
  explainFreq?: ExplainFrequency | null,
): FrequencyBadge | null {
  if (vocab?.tier) {
    const base = CORPUS_TIER_LABEL[vocab.tier]
    const corpusSummary = formatCorpusSummary(vocab)
    const headline =
      vocab.tier === 'rare' && !vocab.found
        ? 'Нет в топ-50 000 слов субтитров — редкое слово, термин или имя'
        : base.hint
    const hint = corpusSummary && vocab.found ? `${headline} (${corpusSummary})` : headline
    return { label: base.label, tone: base.tone, hint, isAiEstimate: false }
  }
  if (explainFreq && explainFreq in AI_FREQ_LABEL) {
    const ai = AI_FREQ_LABEL[explainFreq]
    return { ...ai, isAiEstimate: true }
  }
  return null
}

/** Prefer whichever lookup matched an indexed entry while preserving the highest film count. */
export function mergeSpanAndChunk(spanVocab?: VocabInfo, chunkVocab?: VocabInfo): VocabInfo | undefined {
  if (!spanVocab) return chunkVocab
  if (!chunkVocab) return spanVocab
  const filmCount = Math.max(spanVocab.filmCount, chunkVocab.filmCount)
  if (chunkVocab.found && !spanVocab.found) {
    return { ...chunkVocab, filmCount }
  }
  return { ...spanVocab, filmCount }
}
