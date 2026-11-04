import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { notify } from '@/common/api/notify'
import { api } from '@/common/api/tauri'

/** Warns once per launch when a required system tool (ffmpeg/ffprobe) is missing. */
export function useDepsCheck() {
  const query = useQuery({ queryKey: ['deps'], queryFn: api.depsCheck, staleTime: Infinity })
  const shown = useRef(false)

  useEffect(() => {
    if (shown.current || !query.data?.notice) return
    shown.current = true
    notify('error', query.data.notice)
  }, [query.data])
}
