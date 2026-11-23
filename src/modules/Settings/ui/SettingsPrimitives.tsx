import { useState, type CSSProperties, type InputHTMLAttributes, type ReactNode } from 'react'
import {
  Button,
  Icon,
  IconButton,
  ListGroup,
  ShapeBadge,
  StatusChip,
  TextField,
  toast,
  type FieldControlProps,
  type InputVariant,
  type ShapeBadgeProps,
  type ShapeBadgeTone,
  type ShapeName,
  type StatusChipProps,
  type StatusTone,
} from '@tomato1337/m3e-react'
import { notify } from '@/common/api/notify'
import type { AppConfig } from '@/common/types/ipc'
import type { AppTone } from '../lib/sections'

export const CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const

export type ApplyConfig = <S extends keyof AppConfig>(section: S, patch: Partial<AppConfig[S]>) => void

const CUSTOM_TONE_VARS: Partial<Record<AppTone, { bg: string; fg: string }>> = {
  success: { bg: 'var(--app-success-container)', fg: 'var(--app-on-success-container)' },
  warning: { bg: 'var(--app-warning-container)', fg: 'var(--app-on-warning-container)' },
  anki: { bg: 'var(--app-anki-label-container)', fg: 'var(--app-anki-on-label-container)' },
}

/** ShapeBadge extended with the app's semantic tones (`success`, `warning`, `anki`). */
export function AppShapeBadge({
  tone = 'primary',
  style,
  ...rest
}: Omit<ShapeBadgeProps, 'tone'> & { tone?: AppTone }) {
  const custom = CUSTOM_TONE_VARS[tone]
  const baseTone: ShapeBadgeTone = custom ? 'primary' : (tone as ShapeBadgeTone)
  const mergedStyle = custom
    ? ({ '--m3e-badge-container': custom.bg, '--m3e-badge-content': custom.fg, ...style } as CSSProperties)
    : style
  return <ShapeBadge tone={baseTone} style={mergedStyle} {...rest} />
}

/** StatusChip extended with the app's semantic tones (`success`, `warning`, `anki`). */
export function AppStatusChip({
  tone = 'neutral',
  style,
  ...rest
}: Omit<StatusChipProps, 'tone'> & { tone?: AppTone }) {
  const custom = CUSTOM_TONE_VARS[tone]
  const baseTone: StatusTone = custom ? 'neutral' : (tone as StatusTone)
  const mergedStyle = custom
    ? ({ '--m3e-status-chip-container': custom.bg, '--m3e-status-chip-content': custom.fg, ...style } as CSSProperties)
    : style
  return <StatusChip tone={baseTone} style={mergedStyle} {...rest} />
}

/** Page header inside a Settings Hub section: expressive ShapeBadge + title + subtitle. */
export function SectionHeader({
  title,
  subtitle,
  icon,
  shape = 'cookie9',
  tone = 'primary',
}: {
  title: string
  subtitle: string
  icon?: string
  shape?: ShapeName | 'circle'
  tone?: AppTone
}) {
  return (
    <header className="flex items-center gap-4">
      {icon && <AppShapeBadge shape={shape} size={64} tone={tone} icon={icon} iconFill iconSize={32} />}
      <div className="min-w-0 flex-1">
        <h2 className="type-headline-large type-emph">{title}</h2>
        <p className="type-body-large mt-0.5 text-[var(--md-sys-color-on-surface-variant)]">{subtitle}</p>
      </div>
    </header>
  )
}

/** Section group: outside title/subtitle/action and M3 Expressive `ListGroup` container. */
export function SettingGroup({
  title,
  subtitle,
  action,
  children,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="type-title-large type-emph">{title}</h3>
          {subtitle && <p className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">{subtitle}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      <ListGroup>{children}</ListGroup>
    </section>
  )
}

/** One setting row inside `SettingGroup`: label, changed badge, config key pill, inline control, optional `below`. */
export function SettingRow({
  focusId,
  highlighted = false,
  changed = false,
  configKey,
  icon,
  label,
  sub,
  control,
  below,
  className = '',
}: {
  focusId?: string
  highlighted?: boolean
  changed?: boolean
  configKey?: string
  icon?: string
  label: ReactNode
  sub?: ReactNode
  control?: ReactNode
  below?: ReactNode
  className?: string
}) {
  return (
    <div
      id={focusId ? `setting-${focusId}` : undefined}
      data-focus-id={focusId}
      className={`flex flex-col gap-3 px-5 py-4 transition-colors duration-200 ${
        highlighted
          ? 'bg-[var(--md-sys-color-surface-container-high)] ring-2 ring-[var(--md-sys-color-primary)] ring-inset'
          : 'bg-[var(--md-sys-color-surface-container)]'
      } ${className}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          {icon && (
            <span className="flex shrink-0 text-[var(--md-sys-color-on-surface-variant)]">
              <Icon name={icon} size={24} />
            </span>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="type-title-medium type-emph">{label}</span>
              {changed && (
                <AppStatusChip tone="primary" size="sm">
                  изменено
                </AppStatusChip>
              )}
              {configKey && (
                <code className="type-label-small rounded-[var(--md-sys-shape-corner-extra-small)] bg-[var(--md-sys-color-surface-container-highest)] px-1.5 py-0.5 font-mono text-[var(--md-sys-color-on-surface-variant)]">
                  {configKey}
                </code>
              )}
            </div>
            {sub && <span className="type-body-medium text-[var(--md-sys-color-on-surface-variant)]">{sub}</span>}
          </div>
        </div>
        {control && <div className="flex shrink-0 flex-wrap items-center gap-2">{control}</div>}
      </div>
      {below}
    </div>
  )
}

export type SecretFieldProps = FieldControlProps<InputVariant> &
  Omit<InputHTMLAttributes<HTMLInputElement>, keyof FieldControlProps<InputVariant> | 'type' | 'onChange' | 'value'> & {
    leading?: ReactNode
    value: string
    onValueChange: (value: string) => void
  }

/** Password/API-key input built on kit `TextField` with a show/hide trailing `IconButton`. */
export function SecretField({
  value,
  onValueChange,
  ...rest
}: SecretFieldProps) {
  const [shown, setShown] = useState(false)
  return (
    <TextField
      {...rest}
      type={shown ? 'text' : 'password'}
      value={value}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => onValueChange(e.target.value)}
      trailing={
        <IconButton
          icon={shown ? 'visibility_off' : 'visibility'}
          label={shown ? 'Скрыть' : 'Показать'}
          size="sm"
          onClick={() => setShown((s) => !s)}
        />
      }
    />
  )
}

/** Read-only URL/path display box paired with a clipboard copy button. */
export function CopyBox({
  value,
  leadingIcon,
  copiedMessage = 'Скопировано',
}: {
  value: string
  leadingIcon?: string
  copiedMessage?: string
}) {
  const copy = () => {
    navigator.clipboard.writeText(value).then(
      () => toast(copiedMessage),
      () => notify('warn', 'Не удалось скопировать — выделите текст вручную'),
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-[var(--md-sys-shape-corner-medium)] bg-[var(--md-sys-color-surface-container-lowest)] px-4 py-2">
        {leadingIcon && (
          <span className="flex shrink-0 text-[var(--md-sys-color-on-surface-variant)]">
            <Icon name={leadingIcon} size={20} />
          </span>
        )}
        <span className="type-body-large min-w-0 flex-1 select-all break-all font-mono">{value}</span>
      </div>
      <Button variant="tonal" icon="content_copy" onClick={copy}>
        Скопировать
      </Button>
    </div>
  )
}
