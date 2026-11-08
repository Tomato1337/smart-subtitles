import type { CardPreview, WordDraft } from '@/common/types/ipc'

/**
 * Field sources shown only inside the card preview. Their stored values are media HTML or
 * `[sound:…]` references: rewriting them as draft text would corrupt the note.
 */
const MEDIA_SOURCE: Record<string, true> = { image: true, wordAudio: true, sentenceAudio: true, clip: true }

/** `added` wins over a persisted draft: an established note is edited by its real mapped fields. */
export type EditorView = 'loading' | 'draft' | 'added'

export function editorView(hasCommittedNote: boolean, draft: WordDraft | null): EditorView {
  if (hasCommittedNote) return 'added'
  return draft ? 'draft' : 'loading'
}

export type FieldRow = { field: string; value: string }

/** Actual mapped text fields, in the note type's mapping order; media stays read-only in the preview. */
export function textFieldRows(preview: CardPreview | null, fields: Record<string, string> | null): FieldRow[] {
  if (!preview || !fields) return []
  return preview.mapping
    .filter(([, source]) => source !== '' && !MEDIA_SOURCE[source])
    .map(([field]) => ({ field, value: fields[field] ?? '' }))
}

/** Adopt the image operation's prompt but keep every other local edit, including a newer prompt. */
export function adoptImageDraft(current: WordDraft | null, returned: WordDraft | null, sentPrompt: string): WordDraft | null {
  if (!current) return returned
  if (current.image_prompt !== sentPrompt) return current
  return { ...current, image_prompt: returned?.image_prompt ?? current.image_prompt }
}
