import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/common/api/tauri'

const DONE_KEY = 'smartsubs.setupDone'

/**
  * Opens the first-run wizard once the setup status is known, unless it was finished or dismissed
  * before. `close` remembers that, so the wizard does not pop up on every start.
  */
export function useSetupWizard() {
  const [open, setOpen] = useState(false)
  const query = useQuery({ queryKey: ['setup'], queryFn: api.setupStatus })
  const checked = useRef(false)

  useEffect(() => {
    if (checked.current || !query.data) return
    checked.current = true
    const unfinished = query.data.steps.some((s) => s.importance !== 'optional' && !s.done)
    if (localStorage.getItem(DONE_KEY) !== '1' && unfinished) setOpen(true)
  }, [query.data])

  const show = useCallback(() => setOpen(true), [])
  const close = useCallback(() => {
    localStorage.setItem(DONE_KEY, '1')
    setOpen(false)
  }, [])

  return { open, show, close }
}
