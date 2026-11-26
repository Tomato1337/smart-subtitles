import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import type { RecentMedia } from '@/common/api/tauri'
import type { SetupStatus } from '@/common/types/ipc'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}))
vi.mock('@/modules/Cards', () => ({
  CardsActivityButton: () => null,
}))
vi.mock('@/modules/Notifications', () => ({
  NotificationHeaderButton: () => null,
}))

import { ContinueCard, WelcomeCard } from './HeroCards'
import { HomeScreen } from './HomeScreen'

const longTitle = 'A'.repeat(220)

const sampleMedia: RecentMedia = {
  mediaId: 'm1',
  title: longTitle,
  originalTitle: `${'B'.repeat(220)}`,
  year: 2026,
  season: 1,
  episode: 2,
  posterUrl: null,
  lastPosition: 320,
  duration: 3600,
  sourceUrl: 'file:///films/test.mkv',
  kind: 'file',
  updatedAt: 1_750_000_000,
  annot: 'done',
  annotDone: 10,
  annotTotal: 10,
  subSource: 'opensubtitles',
  cardsCount: 4,
}

const sampleSetup: SetupStatus = {
  complete: false,
  port: 47800,
  guideUrl: 'http://127.0.0.1:47800/llms.txt',
  configPath: '~/.config/smart-subtitle/config.json',
  steps: [
    { id: 'deps', title: 'Системные зависимости', importance: 'required', done: true, hint: 'ok', fields: [] },
    { id: 'llm', title: 'Модель ИИ', importance: 'required', done: false, hint: 'http://example.com/very/long/setup/hint', fields: [] },
    { id: 'opensubtitles', title: 'OpenSubtitles', importance: 'recommended', done: false, hint: 'https://www.opensubtitles.com/consumers', fields: [] },
    { id: 'lampa', title: 'Lampa', importance: 'recommended', done: false, hint: 'http://127.0.0.1:47800/lampa/smartsubs.js', fields: [] },
  ],
}

describe('Session UI regression tests', () => {
  test('ContinueCard wraps 220-char titles/meta and uses kit Button instead of raw hero button', () => {
    const html = renderToStaticMarkup(
      <ContinueCard item={sampleMedia} busy={false} onContinue={() => {}} onStartOver={() => {}} />,
    )
    expect(html).toContain('wrap-anywhere')
    expect(html).toContain('min-w-0')
    expect(html).toContain('m3e-button')
    expect(html).not.toContain('m3e-morph state-layer')
  })

  test('WelcomeCard uses lg:block backdrop, line-clamp-2 hints, outlined step 3, and kit Button CTA', () => {
    const html = renderToStaticMarkup(
      <WelcomeCard
        setup={sampleSetup}
        dragging={false}
        onOpenWizard={() => {}}
        onPickFile={() => {}}
        onNavigateSettings={() => {}}
      />,
    )
    expect(html).toContain('lg:block')
    expect(html).not.toContain('md:block')
    expect(html).toContain('line-clamp-2')
    expect(html).toContain('data-variant="outlined"')
    expect(html).toContain('m3e-button')
    expect(html).not.toContain('m3e-morph state-layer')
  })

  test('HomeScreen wraps long greeting titles and shows distinct error badge on Settings', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(['recent'], [sampleMedia])
    qc.setQueryData(['deps'], { deps: [], notice: 'Не найден ffmpeg' })
    qc.setQueryData(['setup'], sampleSetup)
    qc.setQueryData(['anki-status'], { ok: true, checkedAt: 1, error: null, indexCount: 0, indexUpdatedAt: null, queuedCards: 0 })
    qc.setQueryData(['system-info'], { version: '0.5.0', configDir: '~/.config/smart-subtitle', logsDir: '~/.config/smart-subtitle/logs', vaapiOk: true, listenPort: 47800, lampaLastSeen: {} })

    const htmlError = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <HomeScreen />
      </QueryClientProvider>,
    )
    expect(htmlError).toContain('wrap-anywhere')
    expect(htmlError).toContain('>!</span>')

    qc.setQueryData(['deps'], { deps: [], notice: null })
    qc.setQueryData(['setup'], {
      ...sampleSetup,
      steps: sampleSetup.steps.map((s) => (s.id === 'llm' ? { ...s, done: true } : s)),
    })
    const htmlWarn = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <HomeScreen />
      </QueryClientProvider>,
    )
    expect(htmlWarn).toContain('background:var(--app-warning)')
    expect(htmlWarn).not.toContain('>!</span>')
  })
})
