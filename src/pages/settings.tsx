import { useCanGoBack, useNavigate, useRouter, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useRef } from 'react'
import { SettingsHub, type SettingsSection } from '@/modules/Settings'

const VALID_SECTIONS = new Set<string>([
  'overview',
  'models',
  'level',
  'subs',
  'anki',
  'media',
  'images',
  'lampa',
  'keys',
  'system',
])

function resolveSection(rawSection: unknown, rawFocus: unknown): { section: SettingsSection; focus: string | undefined } {
  const focus = typeof rawFocus === 'string' && rawFocus.trim() ? rawFocus.trim() : undefined
  if (rawSection === 'sources') {
    return { section: 'subs', focus: focus ?? 'subtitles.sources' }
  }
  if (typeof rawSection === 'string' && VALID_SECTIONS.has(rawSection)) {
    return { section: rawSection as SettingsSection, focus }
  }
  return { section: 'overview', focus }
}

/** Settings Hub route (`/settings?section=...&focus=...`). Scrollable root preserves `position: sticky` in WebKitGTK. */
export function SettingsPage() {
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const navigate = useNavigate()
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const scrollRef = useRef<HTMLDivElement>(null)

  const { section, focus } = resolveSection(search.section, search.focus)

  useEffect(() => {
    if (!focus) {
      scrollRef.current?.scrollTo({ top: 0 })
    }
  }, [section, focus])

  const onNavigateSection = useCallback(
    (next: SettingsSection, nextFocus?: string) => {
      void navigate({
        to: '/settings',
        search: {
          section: next === 'overview' ? undefined : next,
          focus: nextFocus || undefined,
        },
        replace: true,
      })
    },
    [navigate],
  )

  const onBack = useCallback(() => {
    if (canGoBack) router.history.back()
    else void navigate({ to: '/' })
  }, [canGoBack, router, navigate])

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto overflow-x-clip scroll-pt-24 bg-[var(--md-sys-color-surface)]">
      <SettingsHub
        section={section}
        focus={focus}
        onNavigateSection={onNavigateSection}
        onBack={onBack}
        scrollContainerRef={scrollRef}
      />
    </div>
  )
}
