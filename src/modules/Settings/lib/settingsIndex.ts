import type { AnkiConnectionStatus, AppConfig, DepsStatus, LlmProvider, SystemInfo } from '@/common/types/ipc'
import { SECTION_META, type AppTone, type NavSection } from './sections'

export type SettingsStatusBadge = {
  label: string
  tone: AppTone
  icon?: string
}

export type SettingsStatusContext = {
  cfg: AppConfig
  providers?: LlmProvider[]
  ankiStatus?: AnkiConnectionStatus
  systemInfo?: SystemInfo
  deps?: DepsStatus
}

export type SettingsIndexItem = {
  id: string
  section: NavSection
  groupLabel: string
  sectionLabel: string
  title: string
  description: string
  configKey?: string
  keywords: readonly string[]
  getStatus?: (ctx: SettingsStatusContext) => SettingsStatusBadge | null
}

/** Masks long secrets as `AIza••••x9Qk`, falling back to `задан` for shorter values. */
export function maskSecretPreview(secret: string): string {
  const s = secret.trim()
  if (!s) return ''
  return s.length >= 12 ? `${s.slice(0, 4)}••••${s.slice(-4)}` : 'задан'
}

function item(
  entry: Omit<SettingsIndexItem, 'groupLabel' | 'sectionLabel'>,
): SettingsIndexItem {
  const meta = SECTION_META[entry.section]
  return {
    ...entry,
    groupLabel: meta.group,
    sectionLabel: meta.label,
  }
}

function secretStatus(value: string, active: boolean): SettingsStatusBadge {
  if (value.trim()) {
    return { label: maskSecretPreview(value), tone: 'success', icon: 'check_circle' }
  }
  return active
    ? { label: 'нет ключа', tone: 'error', icon: 'error' }
    : { label: 'не используется', tone: 'neutral', icon: 'remove' }
}

const CORE_ITEMS: SettingsIndexItem[] = [
  // ---- models ----
  item({
    id: 'llm.source',
    section: 'models',
    title: 'Откуда взять модель',
    description: 'Из агента (omp, Claude Code, Codex…) или ручное подключение.',
    configKey: 'llm.source',
    keywords: ['агент', 'источник', 'подключение', 'omp', 'claude', 'codex', 'вручную', 'llm'],
  }),
  item({
    id: 'llm.provider',
    section: 'models',
    title: 'Провайдер ИИ',
    description: 'Агентский провайдер с ключом и адресом API.',
    configKey: 'llm.provider',
    keywords: ['провайдер', 'provider', 'agent', 'anthropic', 'openai', 'deepseek'],
  }),
  item({
    id: 'llm.apiKey',
    section: 'models',
    title: 'API-ключ LLM',
    description: 'Для ручного подключения; пусто — DEEPSEEK_API_KEY.',
    configKey: 'llm.apiKey',
    keywords: ['ключ', 'api', 'key', 'deepseek', 'openai', 'anthropic', 'токен', 'секрет'],
    getStatus: ({ cfg }) =>
      cfg.llm.source
        ? { label: 'из агента', tone: 'neutral', icon: 'hub' }
        : secretStatus(cfg.llm.apiKey, true),
  }),
  item({
    id: 'llm.baseUrl',
    section: 'models',
    title: 'Адрес API LLM',
    description: 'Корневой URL для ручного подключения.',
    configKey: 'llm.baseUrl',
    keywords: ['url', 'адрес', 'endpoint', 'прокси', 'baseUrl'],
  }),
  item({
    id: 'llm.api',
    section: 'models',
    title: 'Протокол LLM',
    description: 'OpenAI-совместимый или Anthropic API.',
    configKey: 'llm.api',
    keywords: ['протокол', 'wire', 'openai', 'anthropic'],
  }),
  item({
    id: 'llm.model',
    section: 'models',
    title: 'Основная модель ИИ',
    description: 'Модель по умолчанию для перевода, объяснений и карточек.',
    configKey: 'llm.model',
    keywords: ['модель', 'model', 'llm', 'deepseek', 'claude', 'gpt', 'проверить'],
  }),
  item({
    id: 'llmTasks.annotate',
    section: 'models',
    title: 'Разбор диалогов (модель)',
    description: 'Перевод реплик и подсветка, фоном для всего фильма.',
    configKey: 'llmTasks.annotate',
    keywords: ['задача', 'разбор', 'перевод', 'annotate', 'effort', 'рассуждение'],
  }),
  item({
    id: 'llmTasks.explain',
    section: 'models',
    title: 'Объяснение фразы (модель)',
    description: 'Подсказка по клику на выражение в субтитрах.',
    configKey: 'llmTasks.explain',
    keywords: ['задача', 'объяснение', 'explain', 'effort', 'рассуждение'],
  }),
  item({
    id: 'llmTasks.draft',
    section: 'models',
    title: 'Черновик карточки (модель)',
    description: 'Перевод, cloze и подсказка для картинки.',
    configKey: 'llmTasks.draft',
    keywords: ['задача', 'черновик', 'draft', 'карточка', 'effort'],
  }),
  item({
    id: 'llmTasks.chat',
    section: 'models',
    title: 'Чат с агентом (модель)',
    description: 'Сценарий и вся переписка в каждом вопросе.',
    configKey: 'llmTasks.chat',
    keywords: ['задача', 'чат', 'chat', 'агент', 'effort', 'рассуждение'],
  }),
  item({
    id: 'llmTasks.cost',
    section: 'models',
    title: 'Оценка стоимости (модель)',
    description: 'Только если цены модели нет в каталоге models.dev.',
    configKey: 'llmTasks.cost',
    keywords: ['задача', 'цена', 'стоимость', 'cost', 'models.dev'],
  }),
  item({
    id: 'models.usage',
    section: 'models',
    title: 'Расход за месяц',
    description: 'Статистика токенов и затрат в долларах по задачам и моделям.',
    keywords: ['расход', 'статистика', 'бюджет', 'токены', 'доллары', 'usage', 'месяц'],
  }),

  // ---- level ----
  item({
    id: 'learner.cefr',
    section: 'level',
    title: 'Уровень английского (CEFR)',
    description: 'От уровня A1–C2 зависит подсветка слов и сложность объяснений.',
    configKey: 'learner.cefr',
    keywords: ['уровень', 'cefr', 'a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'подсветка'],
  }),
  item({
    id: 'annot.auto',
    section: 'level',
    title: 'Начинать разбор без вопроса',
    description: 'Автоматический запуск разбора диалогов, пока модель совпадает с запомненной.',
    configKey: 'annot.auto',
    keywords: ['автозапуск', 'разбор', 'согласие', 'вопрос', 'auto'],
  }),
  item({
    id: 'annot.rememberedModel',
    section: 'level',
    title: 'Запомненная модель разбора',
    description: 'Модель, для которой запомнено согласие на фоновый разбор.',
    configKey: 'annot.rememberedModel',
    keywords: ['запомненная', 'забыть', 'модель', 'rememberedModel'],
  }),

  // ---- subs ----
  item({
    id: 'subtitles.sources',
    section: 'subs',
    title: 'Порядок поиска субтитров',
    description: 'TorrServer, рядом с файлом, в контейнере и OpenSubtitles.',
    configKey: 'subtitles.sources',
    keywords: ['поиск', 'источники', 'порядок', 'приоритет', 'torrserver', 'sidecar', 'embedded', 'mkv', 'srt'],
  }),
  item({
    id: 'opensubtitles.apiKey',
    section: 'subs',
    title: 'API-ключ OpenSubtitles',
    description: 'Без него субтитры только из раздачи, файла или контейнера.',
    configKey: 'opensubtitles.apiKey',
    keywords: ['ключ', 'opensubtitles', 'субтитры', 'api', 'key'],
    getStatus: ({ cfg }) => secretStatus(cfg.opensubtitles.apiKey, true),
  }),
  item({
    id: 'opensubtitles.account',
    section: 'subs',
    title: 'Аккаунт OpenSubtitles',
    description: 'Необязательно: логин и пароль увеличивают дневной лимит скачиваний.',
    configKey: 'opensubtitles.username · password',
    keywords: ['логин', 'пароль', 'аккаунт', 'opensubtitles', 'лимит', 'username', 'password'],
  }),
  item({
    id: 'subtitles.idleOpacity',
    section: 'subs',
    title: 'Яркость неактивных реплик в «Диалогах»',
    description: 'Прозрачность неактивных строк панели «Диалоги», когда интерфейс скрыт.',
    configKey: 'subtitles.idleOpacity',
    keywords: ['диалоги', 'яркость', 'прозрачность', 'фокус', 'неактивных', 'idleOpacity', 'opacity', 'слайдер'],
  }),

  // ---- anki ----
  item({
    id: 'anki.url',
    section: 'anki',
    title: 'Адрес AnkiConnect',
    description: 'Локальный адрес дополнения AnkiConnect в запущенном Anki.',
    configKey: 'anki.url',
    keywords: ['anki', 'ankiconnect', 'адрес', 'url', 'порт', '8765'],
    getStatus: ({ ankiStatus }) =>
      !ankiStatus
        ? null
        : ankiStatus.ok
          ? { label: 'подключён', tone: 'success', icon: 'check_circle' }
          : { label: 'не отвечает', tone: 'warning', icon: 'sync_problem' },
  }),
  item({
    id: 'anki.syncAfterAdd',
    section: 'anki',
    title: 'Синхронизировать с AnkiWeb',
    description: 'После добавления карточки сразу отправляются в AnkiWeb.',
    configKey: 'anki.syncAfterAdd',
    keywords: ['синхронизация', 'ankiweb', 'телефон', 'sync'],
  }),
  item({
    id: 'anki.deck',
    section: 'anki',
    title: 'Колода Anki',
    description: 'Целевая колода для новых карточек; создаётся при первой карточке.',
    configKey: 'anki.deck',
    keywords: ['колода', 'deck', 'anki'],
  }),
  item({
    id: 'anki.noteType',
    section: 'anki',
    title: 'Тип заметки Anki',
    description: 'Встроенный «Smart Subtitles — Vocab» или собственный тип заметки.',
    configKey: 'anki.noteType',
    keywords: ['тип', 'заметка', 'шаблон', 'noteType', 'vocab', 'tutor'],
  }),
  item({
    id: 'anki.tags',
    section: 'anki',
    title: 'Теги карточки Anki',
    description: 'Теги новых карточек; {film} подставляет название фильма.',
    configKey: 'anki.tags',
    keywords: ['теги', 'tags', 'film', 'anki'],
  }),
  item({
    id: 'anki.fields',
    section: 'anki',
    title: 'Поля карточки Anki',
    description: 'Маппинг полей заметки на слово, перевод, cloze, клип, аудио и картинку.',
    configKey: 'anki.fields',
    keywords: ['поля', 'маппинг', 'fields', 'cloze', 'слово', 'перевод', 'сбросить'],
  }),
  item({
    id: 'anki.indexDecks',
    section: 'anki',
    title: 'Колоды индекса известных слов',
    description: 'Слова из выбранных колод не подсвечиваются как новые.',
    configKey: 'anki.indexDecks',
    keywords: ['индекс', 'известные', 'слова', 'колоды', 'indexDecks', 'подписи'],
  }),
  item({
    id: 'anki.indexFields',
    section: 'anki',
    title: 'Поля индекса известных слов',
    description: 'Какие поля заметки читать как слово и перевод.',
    configKey: 'anki.indexFields',
    keywords: ['индекс', 'поля', 'известные', 'indexFields'],
  }),

  // ---- media ----
  item({
    id: 'anki.quickAdd',
    section: 'media',
    title: 'Быстрое добавление карточек',
    description: 'Клик по слову ставит 5-секундный таймер и добавляет карточку без окна редактирования.',
    configKey: 'anki.quickAdd',
    keywords: ['быстрое', 'добавление', 'quickAdd', 'карточки', 'таймер'],
  }),
  item({
    id: 'anki.clip',
    section: 'media',
    title: 'Вырезать клип из фильма',
    description: 'Короткий видеофрагмент сцены для обратной стороны карточки.',
    configKey: 'anki.clip',
    keywords: ['клип', 'видео', 'фрагмент', 'clip', 'ffmpeg'],
  }),
  item({
    id: 'anki.sentenceAudio',
    section: 'media',
    title: 'Звук предложения',
    description: 'Нет, звук из клипа фильма или синтез речи.',
    configKey: 'anki.sentenceAudio',
    keywords: ['звук', 'аудио', 'предложение', 'sentenceAudio', 'клип', 'синтез'],
  }),
  item({
    id: 'anki.tts',
    section: 'media',
    title: 'Озвучка слова (edge-tts)',
    description: 'Озвучивание слова через edge-tts без API-ключа.',
    configKey: 'anki.tts',
    keywords: ['озвучка', 'слово', 'tts', 'edge-tts', 'произношение', 'аудио'],
  }),
  item({
    id: 'anki.ttsVoice',
    section: 'media',
    title: 'Голос озвучки (edge-tts)',
    description: 'Выбор и прослушивание голоса для озвучки слов и предложений.',
    configKey: 'anki.ttsVoice',
    keywords: ['голос', 'озвучка', 'ttsVoice', 'edge-tts', 'прослушать', 'тест'],
  }),

  // ---- images ----
  item({
    id: 'images.backend',
    section: 'images',
    title: 'Маршрут и провайдер картинок',
    description: 'Основной провайдер картинок и цепочка запасных.',
    configKey: 'images.backend · images.fallbacks',
    keywords: ['картинки', 'изображения', 'маршрут', 'запасные', 'провайдер', 'fallbacks', 'backend'],
  }),
  item({
    id: 'images.style',
    section: 'images',
    title: 'Стиль картинок',
    description: 'Добавляется к каждому промпту генерации как «. Style: …».',
    configKey: 'images.style',
    keywords: ['стиль', 'промпт', 'style', 'картинки', 'иллюстрация'],
  }),
  item({
    id: 'images.omp',
    section: 'images',
    title: 'Картинки через omp',
    description: 'Модель картинки и модель агента omp для генерации.',
    configKey: 'images.omp',
    keywords: ['omp', 'картинки', 'agentModel', 'image'],
  }),
  item({
    id: 'images.gemini.apiKey',
    section: 'images',
    title: 'API-ключ Gemini',
    description: 'Google AI Studio для генерации картинок.',
    configKey: 'images.gemini.apiKey',
    keywords: ['ключ', 'gemini', 'google', 'картинки', 'api', 'key'],
    getStatus: ({ cfg }) =>
      secretStatus(cfg.images.gemini.apiKey, cfg.images.backend === 'gemini' || cfg.images.fallbacks.includes('gemini')),
  }),
  item({
    id: 'images.gemini.model',
    section: 'images',
    title: 'Модель картинок Gemini',
    description: 'gemini-*-image или imagen-*.',
    configKey: 'images.gemini.model',
    keywords: ['gemini', 'imagen', 'модель', 'картинки'],
  }),
  item({
    id: 'images.openai.apiKey',
    section: 'images',
    title: 'API-ключ OpenAI (картинки)',
    description: 'Ключ, адрес API, модель и размер для OpenAI-совместимой генерации.',
    configKey: 'images.openai.apiKey',
    keywords: ['ключ', 'openai', 'gpt-image', 'картинки', 'baseUrl', 'size'],
    getStatus: ({ cfg }) =>
      secretStatus(cfg.images.openai.apiKey, cfg.images.backend === 'openai' || cfg.images.fallbacks.includes('openai')),
  }),
  item({
    id: 'images.runware.apiKey',
    section: 'images',
    title: 'API-ключ Runware',
    description: 'Ключ и модель для генерации через Runware.',
    configKey: 'images.runware.apiKey',
    keywords: ['ключ', 'runware', 'картинки', 'api', 'key'],
    getStatus: ({ cfg }) =>
      secretStatus(cfg.images.runware.apiKey, cfg.images.backend === 'runware' || cfg.images.fallbacks.includes('runware')),
  }),

  // ---- lampa ----
  item({
    id: 'lampa.origins',
    section: 'lampa',
    title: 'Разрешённые адреса Lampa',
    description: 'Origin ваших инстансов Lampa; без адреса плагин получит отказ 403.',
    configKey: 'lampa.origins',
    keywords: ['lampa', 'origin', 'адрес', '403', 'cors', 'лампа'],
    getStatus: ({ cfg }) =>
      cfg.lampa.origins.length > 0
        ? { label: `адресов: ${cfg.lampa.origins.length}`, tone: 'success', icon: 'check_circle' }
        : { label: 'не добавлен', tone: 'error', icon: 'error' },
  }),
  item({
    id: 'lampa.plugin',
    section: 'lampa',
    title: 'Плагин Lampa (smartsubs.js)',
    description: 'Локальная ссылка для добавления в Lampa → Настройки → Расширения.',
    keywords: ['плагин', 'smartsubs.js', 'расширения', 'lampa'],
  }),
  item({
    id: 'torrserver.baseUrl',
    section: 'lampa',
    title: 'Адрес TorrServer',
    description: 'Нужен только если TorrServer работает за обратным прокси с паролем.',
    configKey: 'torrserver.baseUrl',
    keywords: ['torrserver', 'торрсервер', 'прокси', 'адрес', 'url'],
  }),
  item({
    id: 'torrserver.auth',
    section: 'lampa',
    title: 'Basic-auth TorrServer',
    description: 'Логин и пароль для доступа к TorrServer.',
    configKey: 'torrserver.username · password',
    keywords: ['torrserver', 'логин', 'пароль', 'auth', 'basic'],
  }),
  item({
    id: 'server.port',
    section: 'lampa',
    title: 'Порт сервера приложения',
    description: 'Lampa и ИИ-агенты обращаются к 127.0.0.1 на этот порт (нужен перезапуск).',
    configKey: 'server.port',
    keywords: ['порт', 'сервер', 'port', '47800', 'перезапуск'],
  }),

  // ---- keys ----
  item({
    id: 'keys.overview',
    section: 'keys',
    title: 'Горячие клавиши плеера',
    description: 'Переназначение клавиш воспроизведения, субтитров и панелей.',
    keywords: ['горячие', 'клавиши', 'hotkeys', 'shortcuts', 'бинды', 'сбросить'],
  }),

  // ---- system ----
  item({
    id: 'system.wizard',
    section: 'system',
    title: 'Мастер настройки',
    description: 'Пошаговая проверка зависимостей и базовых параметров.',
    keywords: ['мастер', 'помощь', 'настройка', 'wizard'],
  }),
  item({
    id: 'system.tour',
    section: 'system',
    title: 'Тур по приложению',
    description: 'Сбросить отметку просмотра и снова показать обзор плеера.',
    keywords: ['тур', 'обзор', 'обучение', 'tour'],
  }),
  item({
    id: 'system.guide',
    section: 'system',
    title: 'Как читать подсветку',
    description: 'Справка по цветам, подчёркиваниям, конструкциям и меткам Anki.',
    keywords: ['подсветка', 'легенда', 'справка', 'guide', 'цвета'],
  }),
  item({
    id: 'system.agentApi',
    section: 'system',
    title: 'API настройки для ИИ-агентов (llms.txt)',
    description: 'Адрес инструкции /llms.txt и локального HTTP API настройки.',
    keywords: ['агент', 'llms.txt', 'api', 'curl', 'настройка'],
  }),
  item({
    id: 'system.deps',
    section: 'system',
    title: 'Системные зависимости',
    description: 'Проверка наличия ffmpeg, ffprobe и uv.',
    keywords: ['зависимости', 'ffmpeg', 'ffprobe', 'uv', 'whisper', 'инструменты'],
  }),
  item({
    id: 'ffmpeg.vaapiDevice',
    section: 'system',
    title: 'Устройство VAAPI',
    description: 'Аппаратное декодирование и HDR tone mapping на Linux.',
    configKey: 'ffmpeg.vaapiDevice',
    keywords: ['vaapi', 'видео', 'gpu', 'hdr', 'linux', 'ffmpeg', 'renderD128'],
    getStatus: ({ systemInfo }) =>
      !systemInfo
        ? null
        : systemInfo.vaapiOk
          ? { label: 'самопроверка пройдена', tone: 'success', icon: 'check_circle' }
          : { label: 'не используется / ошибка', tone: 'neutral', icon: 'remove' },
  }),
  item({
    id: 'tutor.enabled',
    section: 'system',
    title: 'Использовать Tutor',
    description: 'Необязательное дополнение: уровень CEFR, импорт сценария и картинки.',
    configKey: 'tutor.enabled',
    keywords: ['tutor', 'дополнение', 'аддон', 'цефр'],
  }),
  item({
    id: 'tutor.connection',
    section: 'system',
    title: 'Папка и адрес Tutor',
    description: 'Расположение каталога tutor и URL Tutor API.',
    configKey: 'tutor.root · tutor.apiUrl',
    keywords: ['tutor', 'папка', 'root', 'apiUrl', '4820'],
  }),
  item({
    id: 'tutor.useImageSettings',
    section: 'system',
    title: 'Брать настройки картинок из Tutor',
    description: 'Основной провайдер картинок наследуется из Tutor.',
    configKey: 'tutor.useImageSettings',
    keywords: ['tutor', 'картинки', 'useImageSettings'],
  }),
  item({
    id: 'system.logs',
    section: 'system',
    title: 'Папка журналов (логи)',
    description: 'app, llm, ffmpeg, asr, events — секреты в них скрыты.',
    keywords: ['логи', 'журналы', 'logs', 'папка', 'отладка'],
  }),
  item({
    id: 'system.configDir',
    section: 'system',
    title: 'Папка настроек и базы данных',
    description: 'Каталог с config.json и data.db.',
    keywords: ['папка', 'конфиг', 'config.json', 'data.db', 'база'],
  }),
]

export const SETTINGS_INDEX: readonly SettingsIndexItem[] = CORE_ITEMS

/** Builds search index entries from `HOTKEY_ACTIONS` without pulling browser-only store state into `lib/`. */
export function hotkeyIndexItems(
  actions: readonly { id: string; label: string; combo: string }[],
): SettingsIndexItem[] {
  return actions.map((a) =>
    item({
      id: `keys.${a.id}`,
      section: 'keys',
      title: a.label,
      description: 'Горячая клавиша плеера.',
      keywords: ['клавиша', 'горячая', 'hotkey', a.id, a.combo, a.label],
    }),
  )
}

function scoreItem(entry: SettingsIndexItem, tokens: string[]): number {
  const title = entry.title.toLowerCase()
  const desc = entry.description.toLowerCase()
  const key = (entry.configKey ?? '').toLowerCase()
  const section = entry.sectionLabel.toLowerCase()
  const kw = entry.keywords.join(' ').toLowerCase()
  const haystack = `${title} ${desc} ${key} ${section} ${kw}`

  for (const t of tokens) {
    if (!haystack.includes(t)) return -1
  }

  let score = 0
  for (const t of tokens) {
    if (key === t) score += 120
    else if (key.includes(t)) score += 60
    if (title.startsWith(t)) score += 50
    else if (title.includes(t)) score += 30
    if (kw.includes(t)) score += 15
    if (desc.includes(t)) score += 10
  }
  return score
}

/** Searches settings by title, description, keywords and dotted config paths (e.g. `anki.quickAdd`). */
export function searchSettings(
  query: string,
  extraItems: readonly SettingsIndexItem[] = [],
): SettingsIndexItem[] {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return []
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []

  const pool = extraItems.length > 0 ? [...SETTINGS_INDEX, ...extraItems] : SETTINGS_INDEX
  return pool
    .map((entry, idx) => ({ entry, idx, score: scoreItem(entry, tokens) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .map((x) => x.entry)
}
