const UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'] as const

/**
 * Human size in Russian: one decimal from a gigabyte up ("1,8 ГБ"), whole numbers below
 * ("350 МБ"). Sizes the subtitle estimate shows are all in the hundreds of megabytes or more.
 */
export function formatBytes(n: number): string {
 if (!Number.isFinite(n) || n <= 0) return '0 Б'
 let value = n
 let unit = 0
 while (value >= 1024 && unit < UNITS.length - 1) {
  value /= 1024
  unit += 1
 }
 const digits = unit >= 3 ? 1 : 0
 return `${value.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${UNITS[unit]}`
}
