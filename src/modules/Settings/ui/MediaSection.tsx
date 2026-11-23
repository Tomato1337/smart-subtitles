import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Icon, IconButton, Segmented, Switch, TextField } from '@tomato1337/m3e-react'
import { api, errorText } from '@/common/api/tauri'
import type { AppConfig, CardSource, DepsStatus } from '@/common/types/ipc'
import { autoSource } from '@/modules/Cards'
import { SECTION_META, type NavSection } from '../lib/sections'
import { SectionHeader, SettingGroup, SettingRow, type ApplyConfig } from './SettingsPrimitives'

const SENTENCE_AUDIO_OPTIONS = [
  { value: 'none', label: 'Нет' },
  { value: 'clip', label: 'Из клипа' },
  { value: 'tts', label: 'Синтез' },
] as const

const POPULAR_VOICES = [
  'en-US-GuyNeural',
  'en-US-JennyNeural',
  'en-US-AriaNeural',
  'en-US-ChristopherNeural',
  'en-GB-RyanNeural',
  'en-GB-SoniaNeural',
  'en-AU-WilliamNeural',
]

export function MediaSection({
  cfg,
  set,
  deps,
  changedKeys,
  focusId,
  onJump,
}: {
  cfg: AppConfig
  set: ApplyConfig
  deps?: DepsStatus
  changedKeys: Set<string>
  focusId?: string
  onJump: (section: NavSection, focusId?: string) => void
}) {
  const meta = SECTION_META.media
  const uvMissing = deps?.deps.some((d) => d.id === 'uv' && !d.found) ?? false

  const noteType = useQuery({
    queryKey: ['anki-note-type', cfg.anki.noteType],
    queryFn: () => api.ankiNoteType(cfg.anki.noteType),
    retry: false,
  })
  const fields = noteType.data?.fields ?? []
  const clipFieldMapped =
    fields.length === 0 || fields.some((f) => ((cfg.anki.fields[f] ?? autoSource(f) ?? '') as CardSource) === 'clip')

  const [loadingPreview, setLoadingPreview] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const audioRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null)
  const mountedRef = useRef(true)

  const stopAudio = useCallback(() => {
    const cur = audioRef.current
    if (cur) {
      audioRef.current = null
      cur.audio.onended = null
      cur.audio.onerror = null
      cur.audio.pause()
      URL.revokeObjectURL(cur.url)
    }
    if (mountedRef.current) setPlaying(false)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      stopAudio()
    }
  }, [stopAudio])

  const previewVoice = async () => {
    if (playing) {
      stopAudio()
      return
    }
    const voice = cfg.anki.ttsVoice.trim()
    if (!voice) return
    stopAudio()
    setLoadingPreview(true)
    setPreviewError(null)
    try {
      const base64 = await api.ttsPreview(voice)
      const bin = atob(base64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
      const blob = new Blob([bytes], { type: 'audio/mpeg' })
      const url = URL.createObjectURL(blob)
      if (!mountedRef.current) {
        URL.revokeObjectURL(url)
        return
      }
      const audio = new Audio(url)
      audioRef.current = { audio, url }
      audio.onended = () => stopAudio()
      audio.onerror = () => {
        stopAudio()
        if (mountedRef.current) setPreviewError('Не удалось воспроизвести аудио')
      }
      setPlaying(true)
      await audio.play()
    } catch (e) {
      stopAudio()
      if (mountedRef.current) setPreviewError(errorText(e))
    } finally {
      if (mountedRef.current) setLoadingPreview(false)
    }
  }

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader title={meta.label} subtitle={meta.subtitle} icon={meta.icon} shape={meta.shape} tone={meta.tone} />

      <SettingGroup title="Добавление">
        <SettingRow
          focusId="anki.quickAdd"
          highlighted={focusId === 'anki.quickAdd'}
          changed={changedKeys.has('anki.quickAdd')}
          configKey="anki.quickAdd"
          label="Быстрое добавление"
          sub="Карточка готовится через 5 секунд после клика без диалога предпросмотра; можно отменить или открыть. Воспроизведение не останавливается."
          control={
            <Switch
              ariaLabel="Быстрое добавление"
              checked={cfg.anki.quickAdd}
              onChange={(quickAdd) => set('anki', { quickAdd })}
            />
          }
        />
      </SettingGroup>

      <SettingGroup title="Клип из фильма">
        <SettingRow
          focusId="anki.clip"
          highlighted={focusId === 'anki.clip'}
          changed={changedKeys.has('anki.clip')}
          configKey="anki.clip"
          label="Вырезать клип"
          sub="Выключено — поля Clip, ClipText и ClipSource остаются пустыми."
          control={
            <Switch
              ariaLabel="Вырезать клип"
              checked={cfg.anki.clip}
              onChange={(clip) => set('anki', { clip })}
            />
          }
          below={
            cfg.anki.clip && !clipFieldMapped ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
                  Ни одно поле не получает клип — выберите «Клип из фильма» в разделе «Поля карточки».
                </p>
                <Button variant="text" size="xs" onClick={() => onJump('anki', 'anki.fields')}>
                  К полям Anki
                </Button>
              </div>
            ) : undefined
          }
        />

        <SettingRow
          focusId="anki.sentenceAudio"
          highlighted={focusId === 'anki.sentenceAudio'}
          changed={changedKeys.has('anki.sentenceAudio')}
          configKey="anki.sentenceAudio"
          label="Звук предложения"
          sub="Попадает в поле SentenceAudio на обратной стороне."
          below={
            <div className="flex flex-col gap-2">
              <Segmented
                label="Звук предложения"
                value={cfg.anki.sentenceAudio}
                options={SENTENCE_AUDIO_OPTIONS}
                onChange={(sentenceAudio) => set('anki', { sentenceAudio })}
              />
              {cfg.anki.sentenceAudio === 'clip' && !cfg.anki.clip && (
                <p className="type-body-small text-[var(--md-sys-color-error)]">
                  Видео выключено — звук предложения из клипа недоступен
                </p>
              )}
              {cfg.anki.sentenceAudio === 'tts' && uvMissing && (
                <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
                  Нужен uv: без него синтез речи недоступен
                </p>
              )}
            </div>
          }
        />
      </SettingGroup>

      <SettingGroup title="Озвучка слова">
        <SettingRow
          focusId="anki.tts"
          highlighted={focusId === 'anki.tts'}
          changed={changedKeys.has('anki.tts')}
          configKey="anki.tts"
          label="Озвучивать слово"
          sub="Через edge-tts, без ключа."
          control={
            <Switch
              ariaLabel="Озвучивать слово"
              checked={cfg.anki.tts}
              onChange={(tts) => set('anki', { tts })}
            />
          }
          below={
            uvMissing ? (
              <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">
                Нужен uv: без него озвучка не создаётся
              </p>
            ) : undefined
          }
        />

        <SettingRow
          focusId="anki.ttsVoice"
          highlighted={focusId === 'anki.ttsVoice'}
          changed={changedKeys.has('anki.ttsVoice')}
          configKey="anki.ttsVoice"
          label="Голос"
          sub="Прослушать образец: «It'll bring him joy.»"
          control={
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-full sm:w-[250px]">
                <TextField
                  aria-label="Голос озвучки"
                  variant="outlined"
                  list="edge-tts-voices"
                  leading={<Icon name="record_voice_over" size={20} />}
                  placeholder="en-US-GuyNeural"
                  value={cfg.anki.ttsVoice}
                  spellCheck={false}
                  onChange={(e) => set('anki', { ttsVoice: e.target.value })}
                />
                <datalist id="edge-tts-voices">
                  {POPULAR_VOICES.map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
              </div>
              <IconButton
                variant="tonal"
                icon={playing ? 'stop' : 'play_arrow'}
                fill
                label={playing ? 'Остановить образец' : 'Прослушать голос'}
                disabled={loadingPreview || !cfg.anki.ttsVoice.trim()}
                onClick={() => void previewVoice()}
              />
            </div>
          }
          below={
            previewError ? (
              <p className="type-body-small text-[var(--md-sys-color-error)]">{previewError}</p>
            ) : loadingPreview ? (
              <p className="type-body-small text-[var(--md-sys-color-on-surface-variant)]">Синтезирую образец…</p>
            ) : undefined
          }
        />
      </SettingGroup>
    </div>
  )
}
