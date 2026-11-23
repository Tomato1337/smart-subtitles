import { describe, expect, test, vi } from 'vitest'
import type { AppConfig } from '@/common/types/ipc'
import type { NavSection } from './sections'
import { TASKS } from '../taskProfiles'
import { hotkeyIndexItems, maskSecretPreview, searchSettings, SETTINGS_INDEX } from './settingsIndex'

describe('searchSettings', () => {
  test('empty or whitespace queries return no results', () => {
    expect(searchSettings('')).toEqual([])
    expect(searchSettings('   ')).toEqual([])
  })

  test('finds key settings across multiple sections when searching «ключ»', () => {
    const results = searchSettings('ключ')
    const ids = results.map((r) => r.id)
    expect(ids).toContain('opensubtitles.apiKey')
    expect(ids).toContain('llm.apiKey')
    expect(ids).toContain('images.gemini.apiKey')
    expect(ids).toContain('images.runware.apiKey')
  })

  test('matches dotted config paths directly and prioritizes exact path matches', () => {
    const quick = searchSettings('anki.quickAdd')
    expect(quick[0]?.id).toBe('anki.quickAdd')
    expect(quick[0]?.section).toBe('media')

    const idle = searchSettings('subtitles.idleOpacity')
    expect(idle[0]?.id).toBe('subtitles.idleOpacity')
    expect(idle[0]?.section).toBe('subs')
  })

  test('supports multi-token queries across title, description and keywords', () => {
    const results = searchSettings('яркость диалоги')
    expect(results.map((r) => r.id)).toContain('subtitles.idleOpacity')
  })

  test('finds hotkey actions by Russian label', () => {
    const hotkeys = hotkeyIndexItems([
      { id: 'playPause', label: 'Пауза / воспроизведение', combo: 'Space' },
      { id: 'fullscreen', label: 'Полный экран', combo: 'KeyF' },
    ])
    const results = searchSettings('Полный экран', hotkeys)
    expect(results.some((r) => r.id === 'keys.fullscreen' && r.section === 'keys')).toBe(true)
  })

  test('every index entry has a unique id', () => {
    const ids = SETTINGS_INDEX.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('maskSecretPreview never exposes short secrets or full long keys', () => {
    expect(maskSecretPreview('')).toBe('')
    expect(maskSecretPreview('short')).toBe('задан')
    expect(maskSecretPreview('AIzaSyABCDEF1234x9Qk')).toBe('AIza••••x9Qk')
  })

  test('getStatus on apiKey items reflects real config state without exposing raw secret', () => {
    const cfg = {
      llm: { source: 'omp', provider: 'anthropic', model: 'm', baseUrl: '', apiKey: 'secret-should-not-leak', api: 'anthropic' },
      opensubtitles: { apiKey: '', username: '', password: '' },
      images: {
        backend: 'gemini',
        fallbacks: [],
        style: '',
        openai: { baseUrl: '', apiKey: '', model: '', size: '' },
        runware: { apiKey: '', model: '' },
        gemini: { apiKey: 'AIzaSy1234567890x9Qk', model: 'gemini-2.5-flash-image' },
        omp: { model: '', agentModel: '' },
      },
    } as unknown as AppConfig

    const llmItem = SETTINGS_INDEX.find((e) => e.id === 'llm.apiKey')!
    expect(llmItem.getStatus?.({ cfg })).toEqual({ label: 'из агента', tone: 'neutral', icon: 'hub' })

    const osItem = SETTINGS_INDEX.find((e) => e.id === 'opensubtitles.apiKey')!
    expect(osItem.getStatus?.({ cfg })).toEqual({ label: 'нет ключа', tone: 'error', icon: 'error' })

    const gemItem = SETTINGS_INDEX.find((e) => e.id === 'images.gemini.apiKey')!
    expect(gemItem.getStatus?.({ cfg })).toEqual({ label: 'AIza••••x9Qk', tone: 'success', icon: 'check_circle' })
  })

  test('every SETTINGS_INDEX id matches real section focus targets with no stale mismatches', async () => {
    const uiFiles = import.meta.glob('../ui/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    const readUi = (name: string) => {
      const src = uiFiles[`../ui/${name}`]
      if (!src) throw new Error(`Missing Settings UI file: ${name}`)
      return src
    }

    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
    const { HOTKEY_ACTIONS } = await import('@/modules/Hotkeys')
    vi.unstubAllGlobals()

    const sectionSources: Record<NavSection, string[]> = {
      models: [readUi('ModelsSection.tsx')],
      level: [readUi('LevelSection.tsx')],
      subs: [readUi('SubsSection.tsx')],
      anki: [readUi('AnkiSection.tsx')],
      media: [readUi('MediaSection.tsx')],
      images: [readUi('ImagesSection.tsx'), readUi('ImageFields.tsx')],
      lampa: [readUi('LampaSection.tsx')],
      keys: [readUi('KeysSection.tsx')],
      system: [readUi('SystemSection.tsx')],
    }

    const extractStaticFocusIds = (src: string): Set<string> => {
      const ids = new Set<string>()
      for (const m of src.matchAll(/\b(?:data-)?focus-?[Ii]d=["']([^"']+)["']/g)) {
        ids.add(m[1])
      }
      // Also pick up ternary string literals on `focusId={... 'system.deps' ...}` or `rowFocusId`.
      for (const m of src.matchAll(/focusId=\{[^}]*\}/g)) {
        for (const s of m[0].matchAll(/['"]([a-zA-Z0-9_.]+)['"]/g)) ids.add(s[1])
      }
      return ids
    }

    const sectionTargets: Record<NavSection, Set<string>> = {
      models: extractStaticFocusIds(sectionSources.models[0]),
      level: extractStaticFocusIds(sectionSources.level[0]),
      subs: extractStaticFocusIds(sectionSources.subs[0]),
      anki: extractStaticFocusIds(sectionSources.anki[0]),
      media: extractStaticFocusIds(sectionSources.media[0]),
      images: new Set([
        ...extractStaticFocusIds(sectionSources.images[0]),
        ...extractStaticFocusIds(sectionSources.images[1]),
      ]),
      lampa: extractStaticFocusIds(sectionSources.lampa[0]),
      keys: extractStaticFocusIds(sectionSources.keys[0]),
      system: extractStaticFocusIds(sectionSources.system[0]),
    }

    // Dynamic focus IDs generated from TASKS, IMAGE_PROVIDERS and KEY_GROUPS.
    for (const task of TASKS) sectionTargets.models.add(`llmTasks.${task.key}`)
    for (const backend of ['openai', 'runware', 'gemini', 'omp'] as const) {
      sectionTargets.images.add(`images.${backend}`)
      if (backend !== 'omp') sectionTargets.images.add(`images.${backend}.apiKey`)
    }
    for (const action of HOTKEY_ACTIONS) {
      expect(sectionSources.keys[0]).toContain(`'${action.id}'`)
      sectionTargets.keys.add(`keys.${action.id}`)
    }

    // Never allow stale `images.omp.apiKey` in code or index.
    expect(sectionSources.images.join('\n')).not.toContain('images.omp.apiKey')

    // Every indexed item must have a matching focus target in its section.
    for (const entry of SETTINGS_INDEX) {
      expect(sectionTargets[entry.section].has(entry.id), `Missing focus target for ${entry.id} in ${entry.section}`).toBe(true)
    }

    // Every focus target in a section must correspond to an indexed item (or documented group container).
    const indexedBySection = new Map<NavSection, Set<string>>()
    for (const entry of SETTINGS_INDEX) {
      let set = indexedBySection.get(entry.section)
      if (!set) {
        set = new Set()
        indexedBySection.set(entry.section, set)
      }
      set.add(entry.id)
    }
    for (const item of hotkeyIndexItems(HOTKEY_ACTIONS)) {
      indexedBySection.get('keys')?.add(item.id)
    }

    const groupContainers = new Set(['images.openai', 'images.runware', 'images.gemini'])
    for (const [sec, targets] of Object.entries(sectionTargets) as [NavSection, Set<string>][]) {
      const indexed = indexedBySection.get(sec) ?? new Set()
      for (const target of targets) {
        expect(
          indexed.has(target) || groupContainers.has(target),
          `Undocumented focus target ${target} in ${sec}`,
        ).toBe(true)
      }
    }
  })
})
