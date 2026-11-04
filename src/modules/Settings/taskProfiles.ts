import type { Effort, TaskKey } from '@/common/types/ipc'

export type Weight = 'light' | 'medium' | 'heavy'

export type TaskProfile = {
  key: TaskKey
  title: string
  about: string
  weight: Weight
  /** What one `input`/`output` pair covers, e.g. «вопрос» for the chat. */
  unit: string
  input: number
  cached: number
  output: number
}

// Averages from llm.log (2026-11-04); the film script (~38K tokens) goes into every request and is usually read from the provider cache.
export const TASKS: TaskProfile[] = [
  { key: 'annotate', title: 'Разбор диалогов', about: 'Перевод реплик и подсветка выражений, фоном для всего фильма', weight: 'heavy', unit: 'фильм (~1 400 реплик, 35 запросов)', input: 1_450_000, cached: 1_300_000, output: 100_000 },
  { key: 'explain', title: 'Объяснение фразы', about: 'Подсказка по клику на выражение; ответ кэшируется', weight: 'light', unit: 'объяснение', input: 39_000, cached: 38_000, output: 230 },
  { key: 'draft', title: 'Черновик карточки Anki', about: 'Перевод, cloze и подсказка для картинки', weight: 'light', unit: 'карточку', input: 32_000, cached: 31_000, output: 120 },
  { key: 'chat', title: 'Чат с агентом', about: 'Каждый вопрос отправляет сценарий и всю переписку; инструменты добавляют до 5 повторных запросов', weight: 'medium', unit: 'вопрос', input: 41_000, cached: 33_000, output: 550 },
  { key: 'cost', title: 'Оценка стоимости', about: 'Только если цены модели разбора нет в каталоге', weight: 'light', unit: 'оценку', input: 260, cached: 0, output: 160 },
]

export const WEIGHT_LABEL: Record<Weight, string> = { light: 'Лёгкая', medium: 'Средняя', heavy: 'Тяжёлая' }

export const EFFORT_LABEL: Record<Effort, string> = { off: 'Выключено', low: 'Низкое', medium: 'Среднее', high: 'Высокое' }
