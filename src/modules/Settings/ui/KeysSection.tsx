import { Button, IconButton, Kbd, ListGroup, ShapeBadge } from '@tomato1337/m3e-react'
import { comboParts, HOTKEY_ACTIONS, useHotkeyCapture, type HotkeyAction } from '@/modules/Hotkeys'
import { SECTION_META } from '../lib/sections'
import { SectionHeader } from './SettingsPrimitives'

const ACTION_BY_ID = new Map(HOTKEY_ACTIONS.map((a) => [a.id, a]))

const KEY_GROUPS: readonly { title: string; ids: readonly HotkeyAction[] }[] = [
  {
    title: 'Воспроизведение',
    ids: ['playPause', 'prevCue', 'nextCue', 'back5', 'forward5', 'replay', 'slower', 'faster', 'fullscreen'],
  },
  {
    title: 'Субтитры',
    ids: ['showEn', 'showRu', 'reveal', 'offsetMinus', 'offsetPlus'],
  },
  {
    title: 'Панели',
    ids: ['sidebar', 'patterns', 'guide', 'chat'],
  },
]

export function KeysSection({ focusId }: { focusId?: string }) {
  const meta = SECTION_META.keys
  const { bindings, capturing, toggleCapture, cancelCapture, unbind, reset } = useHotkeyCapture()

  return (
    <div className="flex flex-col gap-7">
      <div
        id="setting-keys.overview"
        data-focus-id="keys.overview"
        className={`rounded-[24px] transition-shadow ${
          focusId === 'keys.overview' ? 'p-2 ring-2 ring-[var(--md-sys-color-primary)]' : ''
        }`}
      >
        <SectionHeader title={meta.label} subtitle={meta.subtitle} icon={meta.icon} shape={meta.shape} tone={meta.tone} />
      </div>

      {KEY_GROUPS.map((grp, gi) => (
        <section key={grp.title} className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="type-title-large type-emph">{grp.title}</h3>
            {gi === 0 && (
              <Button variant="text" icon="restart_alt" onClick={reset}>
                Сбросить все
              </Button>
            )}
          </div>

          <ListGroup>
            {grp.ids.map((id) => {
              const action = ACTION_BY_ID.get(id)
              if (!action) return null
              const combo = bindings[id]
              const recording = capturing === id
              const parts = comboParts(combo)
              const isFocused = focusId === `keys.${id}`

              return (
                <div
                  key={id}
                  id={`setting-keys.${id}`}
                  data-focus-id={`keys.${id}`}
                  className={`flex min-h-14 flex-wrap items-center justify-between gap-3 py-2 pr-3 pl-5 transition-colors ${
                    recording || isFocused
                      ? 'bg-[var(--md-sys-color-surface-container-high)] ring-2 ring-[var(--md-sys-color-primary)] ring-inset'
                      : 'bg-[var(--md-sys-color-surface-container)]'
                  }`}
                >
                  <span className={`type-body-large min-w-0 flex-1 ${recording ? 'type-emph' : ''}`}>
                    {action.label}
                  </span>

                  {recording ? (
                    <button
                      type="button"
                      onClick={cancelCapture}
                      className="inline-flex h-10 items-center gap-2 rounded-full bg-[var(--md-sys-color-primary-container)] pr-4 pl-3 text-[var(--md-sys-color-on-primary-container)]"
                    >
                      <ShapeBadge shape="cookie12" size={18} tone="primary" />
                      <span className="type-label-large type-emph">Нажмите сочетание · Esc — отмена</span>
                    </button>
                  ) : (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        aria-label={`Изменить клавишу для «${action.label}»`}
                        onClick={() => toggleCapture(id)}
                        className="inline-flex min-h-9 items-center gap-1 rounded-xl px-1.5 py-1 hover:bg-[var(--md-sys-color-surface-container-highest)]"
                      >
                        {combo === null ? (
                          <span className="type-label-medium rounded-lg border border-dashed border-[var(--md-sys-color-outline)] px-2.5 py-1 text-[var(--md-sys-color-on-surface-variant)]">
                            Не назначено
                          </span>
                        ) : (
                          parts.map((part, idx) => (
                            <Kbd key={`${part}-${idx}`} size="md">
                              {part}
                            </Kbd>
                          ))
                        )}
                      </button>
                      <IconButton
                        icon="edit"
                        label={`Назначить клавишу для «${action.label}»`}
                        tipPos="top"
                        onClick={() => toggleCapture(id)}
                      />
                      <IconButton
                        icon="close"
                        label={`Убрать клавишу для «${action.label}»`}
                        tipPos="top"
                        disabled={combo === null}
                        onClick={() => unbind(id)}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </ListGroup>
        </section>
      ))}
    </div>
  )
}
