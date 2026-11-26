import type { ShapeName } from '@tomato1337/m3e-react'

export type SettingsSection =
  | 'overview'
  | 'models'
  | 'level'
  | 'subs'
  | 'anki'
  | 'media'
  | 'images'
  | 'lampa'
  | 'keys'
  | 'system'

export type NavSection = Exclude<SettingsSection, 'overview'>

export type AppTone = 'primary' | 'secondary' | 'tertiary' | 'error' | 'neutral' | 'success' | 'warning' | 'anki'

export type SectionMeta = {
  id: NavSection
  group: 'Перевод' | 'Карточки' | 'Приложение'
  label: string
  subtitle: string
  icon: string
  shape: ShapeName | 'circle'
  tone: AppTone
}

export const NAV_GROUPS: readonly { group: 'Перевод' | 'Карточки' | 'Приложение'; items: readonly NavSection[] }[] = [
  { group: 'Перевод', items: ['models', 'level', 'subs'] },
  { group: 'Карточки', items: ['anki', 'media', 'images'] },
  { group: 'Приложение', items: ['lampa', 'keys', 'system'] },
]

export const SECTION_META: Record<NavSection, SectionMeta> = {
  models: {
    id: 'models',
    group: 'Перевод',
    label: 'Модели ИИ',
    subtitle: 'Перевод, подсветка, объяснения, карточки и чат. Ключи хранятся в config.json и не передаются в логи.',
    icon: 'neurology',
    shape: 'cookie9',
    tone: 'primary',
  },
  level: {
    id: 'level',
    group: 'Перевод',
    label: 'Уровень и разбор',
    subtitle: 'От уровня зависит, что подсвечивается и как объясняется.',
    icon: 'school',
    shape: 'sunny',
    tone: 'secondary',
  },
  subs: {
    id: 'subs',
    group: 'Перевод',
    label: 'Субтитры',
    subtitle: 'Где искать английские субтитры, в каком порядке и как приглушать панель «Диалоги».',
    icon: 'subtitles',
    shape: 'clover4',
    tone: 'primary',
  },
  anki: {
    id: 'anki',
    group: 'Карточки',
    label: 'Anki',
    subtitle: 'Куда и как попадают карточки. Предпросмотр обновляется сразу по черновику.',
    icon: 'style',
    shape: 'sunny',
    tone: 'anki',
  },
  media: {
    id: 'media',
    group: 'Карточки',
    label: 'Клипы и озвучка',
    subtitle: 'Что будет на карточке, кроме слова и перевода.',
    icon: 'movie',
    shape: 'clover8',
    tone: 'anki',
  },
  images: {
    id: 'images',
    group: 'Карточки',
    label: 'Картинки',
    subtitle: 'Картинка для карточки по подсказке из черновика.',
    icon: 'image',
    shape: 'burst12',
    tone: 'tertiary',
  },
  lampa: {
    id: 'lampa',
    group: 'Приложение',
    label: 'Lampa и TorrServer',
    subtitle: 'Откуда приходят фильмы и как приложение их получает.',
    icon: 'live_tv',
    shape: 'clover4',
    tone: 'tertiary',
  },
  keys: {
    id: 'keys',
    group: 'Приложение',
    label: 'Горячие клавиши',
    subtitle: 'Клавиши плеера. Меняются сразу, без «Сохранить».',
    icon: 'keyboard',
    shape: 'pentagon',
    tone: 'secondary',
  },
  system: {
    id: 'system',
    group: 'Приложение',
    label: 'Система и помощь',
    subtitle: 'Мастер, тур, видео, дополнения и данные.',
    icon: 'tune',
    shape: 'circle',
    tone: 'primary',
  },
}
