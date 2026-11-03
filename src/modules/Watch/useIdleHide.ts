import { useEffect, useState } from 'react'

/** Controls stay visible while `keepVisible`, otherwise hide after `ms` without mouse movement. */
export function useIdleVisible(keepVisible: boolean, ms = 3000) {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const wake = () => {
      setVisible(true)
      clearTimeout(timer)
      if (!keepVisible) timer = setTimeout(() => setVisible(false), ms)
    }
    wake()
    window.addEventListener('mousemove', wake)
    window.addEventListener('keydown', wake)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('mousemove', wake)
      window.removeEventListener('keydown', wake)
    }
  }, [keepVisible, ms])
  return visible
}
