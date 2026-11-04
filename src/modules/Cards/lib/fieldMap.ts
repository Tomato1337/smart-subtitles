import type { CardSource } from '@/common/types/ipc'

/** Name table of `anki/fields.rs::auto_source`: lowercase, non-alphanumerics dropped. */
const TABLE: [CardSource, string[]][] = [
  ['word', ['word', 'front', 'expression', 'vocab', 'vocabulary', 'term', 'english']],
  ['translation', ['wordtranslation', 'translation', 'meaning', 'back', 'russian', 'definition']],
  ['wordType', ['wordtype', 'partofspeech', 'pos', 'type']],
  ['clozeGap', ['clozetext', 'cloze']],
  ['clozeRaw', ['text']],
  ['sentence', ['fullsentence', 'sentence', 'example', 'context']],
  ['sentenceTranslation', ['sentencetranslation', 'exampletranslation']],
  ['image', ['image', 'picture', 'pic', 'img']],
  ['wordAudio', ['wordaudio', 'audio', 'sound', 'pronunciation']],
  ['sentenceAudio', ['sentenceaudio', 'exampleaudio']],
  ['clip', ['clip', 'video']],
  ['clipText', ['cliptext']],
  ['clipSource', ['clipsource', 'source']],
]

/** The source a field would get without a saved mapping; `null` when the name says nothing. */
export function autoSource(field: string): CardSource | null {
  const key = field.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  for (const [source, names] of TABLE) {
    if (names.includes(key)) return source
  }
  return null
}

/** Options of every field's `<select>`, in the order the dialog shows them. */
export const SOURCE_LABELS: [CardSource, string][] = [
  ['', 'не заполнять'],
  ['word', 'Слово'],
  ['translation', 'Перевод'],
  ['wordType', 'Часть речи'],
  ['clozeGap', 'Cloze с пропуском'],
  ['clozeRaw', 'Cloze как есть'],
  ['sentence', 'Предложение'],
  ['sentenceTranslation', 'Перевод предложения'],
  ['image', 'Картинка'],
  ['wordAudio', 'Озвучка слова'],
  ['sentenceAudio', 'Озвучка предложения'],
  ['clip', 'Клип из фильма'],
  ['clipText', 'Текст клипа'],
  ['clipSource', 'Источник клипа'],
]

export const SOURCE_IDS: CardSource[] = SOURCE_LABELS.map(([id]) => id)
