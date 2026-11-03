import { useEffect } from 'react'
import { api, onEvent } from '@/common/api/tauri'
import type { InirTheme } from '@/common/types/ipc'
import { themeVars } from './lib/themeVars'

function apply(t: InirTheme): void {
  for (const [k, v] of Object.entries(themeVars(t))) document.documentElement.style.setProperty(k, v)
  document.documentElement.style.colorScheme = t.mode
}

/** Keeps the CSS variables in step with inir: one read at startup, then one push per wallpaper change. */
export function useInirTheme(): void {
  useEffect(() => {
    void api.themeCurrent().then((t) => { if (t) apply(t) }).catch(() => { })
    const un = onEvent('theme:changed', apply)
    return () => { void un.then((f) => f()) }
  }, [])
}
