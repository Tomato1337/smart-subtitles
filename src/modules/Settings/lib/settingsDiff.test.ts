import { describe, expect, test } from 'vitest'
import type { AppConfig } from '@/common/types/ipc'
import { diffConfig, reconcileDraftAfterSave } from './settingsDiff'

function makeConfig(): AppConfig {
  return {
    server: { port: 47800 },
    lampa: { origins: ['https://lampa.home.lan'] },
    llm: { source: '', provider: '', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', apiKey: '', api: 'openai' },
    llmTasks: {
      annotate: { source: '', provider: '', model: '', effort: 'off' },
      explain: { source: '', provider: '', model: '', effort: 'off' },
      draft: { source: '', provider: '', model: '', effort: 'off' },
      chat: { source: '', provider: '', model: '', effort: 'off' },
      cost: { source: '', provider: '', model: '', effort: 'off' },
    },
    opensubtitles: { apiKey: '', username: '', password: '' },
    subtitles: { sources: ['torrserver', 'sidecar', 'embedded', 'opensubtitles'], idleOpacity: 0.36 },
    annot: { auto: true, rememberedModel: '' },
    tutor: { enabled: false, root: '~/tutor', apiUrl: 'http://127.0.0.1:4820', useImageSettings: true },
    anki: {
      url: 'http://127.0.0.1:8765',
      deck: 'Learning English',
      noteType: 'Smart Subtitles — Vocab',
      fields: {},
      tags: 'vocab smartsubs smartsubs::{film}',
      indexDecks: ['*'],
      indexFields: {},
      tts: true,
      ttsVoice: 'en-US-GuyNeural',
      sentenceAudio: 'none',
      clip: true,
      syncAfterAdd: true,
      quickAdd: false,
    },
    images: {
      backend: 'none',
      fallbacks: [],
      style: '',
      openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-image-1', size: '1024x1024' },
      runware: { apiKey: '', model: 'runware:400@2' },
      gemini: { apiKey: '', model: 'gemini-2.5-flash-image' },
      omp: { model: '', agentModel: 'anthropic/claude-haiku-5-5' },
    },
    torrserver: { baseUrl: '', username: '', password: '' },
    ffmpeg: { vaapiDevice: '/dev/dri/renderD128' },
    learner: { cefr: 'B1' },
  }
}

describe('diffConfig', () => {
  test('identical configs produce clean diff', () => {
    const a = makeConfig()
    const b = makeConfig()
    const diff = diffConfig(a, b)
    expect(diff.dirty).toBe(false)
    expect(diff.count).toBe(0)
    expect(diff.changedKeys.size).toBe(0)
    expect(diff.changedBySection).toEqual({})
    expect(diff.restartRequired).toBe(false)
  })

  test('ignores key insertion order in anki.fields and anki.indexFields and float epsilon in idleOpacity', () => {
    const a = makeConfig()
    a.anki.fields = { Word: 'word', Image: 'image' }
    a.anki.indexFields = { Basic: { word: 'Front', translation: 'Back' }, Cloze: { word: 'Text', translation: '' } }
    a.subtitles.idleOpacity = 0.36

    const b = makeConfig()
    b.anki.fields = { Image: 'image', Word: 'word' }
    b.anki.indexFields = { Cloze: { word: 'Text', translation: '' }, Basic: { word: 'Front', translation: 'Back' } }
    b.subtitles.idleOpacity = 0.36000001

    const diff = diffConfig(a, b)
    expect(diff.dirty).toBe(false)
    expect(diff.count).toBe(0)
  })

  test('tracks changes across multiple sections and detects port restart', () => {
    const saved = makeConfig()
    const draft = makeConfig()
    draft.llmTasks.chat = { source: 'omp', provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium' }
    draft.subtitles.sources = ['opensubtitles', 'torrserver', 'sidecar', 'embedded']
    draft.subtitles.idleOpacity = 0.5
    draft.server.port = 48000
    draft.anki.quickAdd = true

    const diff = diffConfig(draft, saved)
    expect(diff.dirty).toBe(true)
    expect(diff.count).toBe(5)
    expect(diff.restartRequired).toBe(true)
    expect(diff.changedKeys).toEqual(new Set(['llmTasks.chat', 'subtitles.sources', 'subtitles.idleOpacity', 'server.port', 'anki.quickAdd']))
    expect(diff.changedBySection).toEqual({
      models: 1,
      subs: 2,
      lampa: 1,
      media: 1,
    })
  })

  test('distinguishes deleted field mapping from explicit empty string', () => {
    const saved = makeConfig()
    const draft = makeConfig()
    draft.anki.fields = { Word: '' }

    const diff = diffConfig(draft, saved)
    expect(diff.dirty).toBe(true)
    expect(diff.changedKeys.has('anki.fields')).toBe(true)
    expect(diff.changedBySection.anki).toBe(1)
  })

  test('reconcileDraftAfterSave clears unchanged draft and preserves concurrent edits', () => {
    const saved = makeConfig()
    const unchanged = makeConfig()
    expect(reconcileDraftAfterSave(null, saved)).toBeNull()
    expect(reconcileDraftAfterSave(unchanged, saved)).toBeNull()

    const editedDuringSave = makeConfig()
    editedDuringSave.anki.deck = 'Edited While Saving'
    expect(reconcileDraftAfterSave(editedDuringSave, saved)).toBe(editedDuringSave)
  })
})
