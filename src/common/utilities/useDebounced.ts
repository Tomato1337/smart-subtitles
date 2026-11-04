import { useEffect, useState } from 'react'

/** Debounces a JSON-valued draft (a plain object, so its serialization is its identity). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  const json = JSON.stringify(value)
  useEffect(() => {
    const t = setTimeout(() => setV(JSON.parse(json) as T), ms)
    return () => clearTimeout(t)
  }, [json, ms])
  return v
}
