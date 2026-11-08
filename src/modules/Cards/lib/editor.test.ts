import { describe, expect, it } from 'vitest'
import type { CardPreview, NoteTypeView, WordDraft } from '@/common/types/ipc'
import { adoptImageDraft, editorView, textFieldRows } from './editor'

const DRAFT: WordDraft = {
  word: 'bring',
  translation: 'приносить',
  word_type: 'verb',
  cloze_sentence: 'It will {{c1::bring}} joy.',
  full_sentence: 'It will bring joy.',
  sentence_translation: 'Это принесёт радость.',
  image_prompt: 'A person bringing joy.',
}

const NOTE_TYPE: NoteTypeView = {
  name: 'Smart Subs',
  fields: ['Expression', 'Meaning', 'Picture', 'Audio', 'Cloze', 'Source'],
  front: '',
  back: '',
  css: '',
  builtin: true,
  exists: true,
}

const PREVIEW: CardPreview = {
  noteType: NOTE_TYPE,
  mapping: [
    ['Expression', 'word'],
    ['Meaning', 'translation'],
    ['Picture', 'image'],
    ['Audio', 'wordAudio'],
    ['Cloze', 'clozeGap'],
    ['Source', 'clipSource'],
    ['Empty', ''],
  ],
  values: {},
}

const FIELDS = {
  Expression: 'bring',
  Meaning: '<b>приносить</b>',
  Picture: '<img src="data:image/webp;base64,AAAA">',
  Audio: '[sound:bring.mp3]',
  Cloze: 'It will {{c1::bring}} joy.',
  Source: 'Film · 00:01 · Smart Subtitles',
  Empty: '',
}

describe('card editor view', () => {
  it('shows actual mapped rows after the add even though the draft still exists', () => {
    // Regression: a persisted draft used to select the seven draft fields for an established note.
    expect(editorView(true, DRAFT)).toBe('added')
    expect(editorView(true, null)).toBe('added')
  })

  it('shows the draft form only before the note exists', () => {
    expect(editorView(false, DRAFT)).toBe('draft')
    expect(editorView(false, null)).toBe('loading')
  })

  it('renders actual mapped text fields in note-type order and leaves media to the preview', () => {
    expect(textFieldRows(PREVIEW, FIELDS)).toEqual([
      { field: 'Expression', value: 'bring' },
      { field: 'Meaning', value: '<b>приносить</b>' },
      { field: 'Cloze', value: 'It will {{c1::bring}} joy.' },
      { field: 'Source', value: 'Film · 00:01 · Smart Subtitles' },
    ])
  })

  it('does not invent editable rows without the actual mapping or values', () => {
    expect(textFieldRows(null, FIELDS)).toEqual([])
    expect(textFieldRows(PREVIEW, null)).toEqual([])
    expect(textFieldRows(PREVIEW, { Expression: 'only one' })).toEqual([
      { field: 'Expression', value: 'only one' },
      { field: 'Meaning', value: '' },
      { field: 'Cloze', value: '' },
      { field: 'Source', value: '' },
    ])
  })

  it('adopts the generated prompt without losing other dirty draft fields', () => {
    const returned = { ...DRAFT, image_prompt: 'A generated picture.' }
    const dirty = { ...DRAFT, translation: 'принести', image_prompt: 'the prompt that was sent' }
    expect(adoptImageDraft(dirty, returned, 'the prompt that was sent')).toEqual({
      ...dirty,
      image_prompt: 'A generated picture.',
    })
    // A newer local prompt written while the image was generated wins over the response.
    expect(adoptImageDraft({ ...dirty, image_prompt: 'newer local' }, returned, 'the prompt that was sent')).toEqual({
      ...dirty,
      image_prompt: 'newer local',
    })
    expect(adoptImageDraft(null, returned, 'x')).toBe(returned)
  })
})
