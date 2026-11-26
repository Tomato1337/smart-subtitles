import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import type { AnkiConnectionStatus, AppConfig, SystemInfo } from '@/common/types/ipc'
import { SECTION_META } from '../lib/sections'
import { describeAnkiCatalogStatus } from './AnkiSection'
import { detectDarkScheme } from './CardPreviewDock'
import { ModelsSection } from './ModelsSection'
import { OverviewSection } from './OverviewSection'
import { SaveBar } from './SaveBar'
import { SettingsNav } from './SettingsNav'
import { SubsSection } from './SubsSection'

vi.mock('@/modules/Hotkeys', () => ({
  HOTKEY_ACTIONS: [],
  useHotkeysStore: (sel: (s: { bindings: Record<string, string | null> }) => unknown) => sel({ bindings: {} }),
}))
vi.mock('@/modules/Cards', () => ({
  CardPreview: () => null,
  autoSource: () => null,
  SOURCE_LABELS: [],
}))

const sampleConfig: AppConfig = {
  server: { port: 47800 },
  lampa: { origins: ['https://lampa.example.com'] },
  llm: { source: '', provider: '', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKey: '', api: 'openai' },
  llmTasks: {
    annotate: { source: '', provider: '', model: '', effort: 'low' },
    explain: { source: '', provider: '', model: '', effort: 'medium' },
    draft: { source: '', provider: '', model: '', effort: 'high' },
    chat: { source: '', provider: '', model: '', effort: 'off' },
    cost: { source: '', provider: '', model: '', effort: 'off' },
  },
  opensubtitles: { apiKey: '', username: '', password: '' },
  subtitles: { sources: ['torrserver', 'sidecar', 'embedded', 'opensubtitles'], idleOpacity: 0.36 },
  annot: { auto: true, rememberedModel: '' },
  tutor: { enabled: false, root: '~/tutor', apiUrl: 'http://127.0.0.1:4820', useImageSettings: true },
  anki: {
    url: 'http://127.0.0.1:8765',
    deck: 'English',
    noteType: 'Smart Subtitles — Vocab',
    fields: {},
    tags: 'vocab',
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
    omp: { model: '', agentModel: '' },
  },
  torrserver: { baseUrl: '', username: '', password: '' },
  ffmpeg: { vaapiDevice: '/dev/dri/renderD128' },
  learner: { cefr: 'B1' },
}

describe('Settings UI regression tests', () => {
  test('describeAnkiCatalogStatus hides stale catalog line when anki_status is offline', () => {
    const offline: AnkiConnectionStatus = {
      ok: false,
      checkedAt: 1,
      error: 'Connection refused',
      indexCount: 0,
      indexUpdatedAt: null,
      queuedCards: 0,
    }
    const line = describeAnkiCatalogStatus({
      ankiStatus: offline,
      ankiChecking: false,
      catalogFetching: false,
      catalogError: null,
      decksCount: 0,
      noteTypesCount: 0,
    })
    expect(line).toBe('Anki не отвечает: Connection refused')
    expect(line).not.toContain('Anki отвечает')

    const online: AnkiConnectionStatus = { ...offline, ok: true, error: null }
    expect(
      describeAnkiCatalogStatus({
        ankiStatus: online,
        ankiChecking: false,
        catalogFetching: false,
        catalogError: null,
        decksCount: 2,
        noteTypesCount: 1,
      }),
    ).toBe('Anki отвечает: 2 колоды, 1 тип заметки')
  })

  test('detectDarkScheme reads active document colorScheme before falling back', () => {
    vi.stubGlobal('document', { documentElement: { style: { colorScheme: 'dark' } } })
    expect(detectDarkScheme()).toBe(true)
    vi.stubGlobal('document', { documentElement: { style: { colorScheme: 'light' } } })
    expect(detectDarkScheme()).toBe(false)
    vi.unstubAllGlobals()
  })

  test('SettingsNav provides mobile picker drawer, stats-scroll, and no 0.3.2 fallback', () => {
    const sysInfo: SystemInfo = {
      version: '',
      configDir: '~/.config/smart-subtitle',
      logsDir: '~/.config/smart-subtitle/logs',
      vaapiOk: true,
      listenPort: 47800,
      lampaLastSeen: {},
    }
    const html = renderToStaticMarkup(
      <SettingsNav
        active="anki"
        query=""
        onQueryChange={() => {}}
        onSelectSection={() => {}}
        alerts={{ subs: { kind: 'warning' } }}
        changedBySection={{}}
        systemInfo={sysInfo}
        searchInputRef={createRef()}
      />,
    )
    expect(html).toContain('aria-controls="settings-nav-drawer"')
    expect(html).toContain('hidden md:block')
    expect(html).toContain('stats-scroll')
    expect(html).not.toContain('0.3.2')
  })

  test('ModelsSection localizes effort labels with visible heading and removes duplicate Модель label', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <ModelsSection cfg={sampleConfig} providers={[]} set={() => {}} changedKeys={new Set()} />
      </QueryClientProvider>,
    )
    expect(html).toContain('Рассуждение')
    expect(html).toContain('низк.')
    expect(html).toContain('сред.')
    expect(html).toContain('макс.')
    expect(html).not.toContain('>low<')
    expect(html).not.toContain('>med<')
    expect(html).not.toContain('>high<')
    // Only one visible "Модель" label (the SettingRow label), not a duplicate field label.
    expect(html.match(/>Модель</g) ?? []).toHaveLength(1)
  })

  test('OverviewSection and SubsSection localize sources and downgrade missing OpenSubtitles key to warning', () => {
    const overviewHtml = renderToStaticMarkup(
      <OverviewSection
        cfg={sampleConfig}
        providers={[]}
        ankiChecking={false}
        onCheckAnki={() => {}}
        onJump={() => {}}
      />,
    )
    expect(overviewHtml).toContain('TorrServer → Рядом с файлом → В контейнере → OpenSubtitles')
    expect(overviewHtml).not.toContain('torrserver → sidecar')

    const subsHtml = renderToStaticMarkup(
      <SubsSection cfg={sampleConfig} set={() => {}} changedKeys={new Set()} />,
    )
    expect(subsHtml).toContain('нет ключа')
    expect(subsHtml).not.toContain('нужен ключ')
    expect(subsHtml).not.toContain('var(--md-sys-color-error-container)')
  })

  test('SaveBar uses accessible opacity, sections drop right-side phrasing, SettingsHub locks 1440px wrapper', async () => {
    const barHtml = renderToStaticMarkup(
      <SaveBar count={2} restartRequired={false} saving={false} onDiscard={() => {}} onSave={() => {}} />,
    )
    expect(barHtml).toContain('opacity-90')
    expect(barHtml).not.toContain('opacity-70')
    expect(SECTION_META.anki.subtitle).not.toContain('справа')

    const hubRaw = (await import('./SettingsHub.tsx?raw')).default
    expect(hubRaw).toContain('max-w-[1440px]')
    expect(hubRaw).not.toContain('max-w-[1232px]')
    expect(hubRaw).toContain('max-w-[920px]')
    expect(hubRaw).toContain("out.subs = { kind: 'warning' }")
    expect(hubRaw).toContain('reconcileDraftAfterSave')
  })
})
