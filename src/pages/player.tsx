import { useNavigate } from '@tanstack/react-router'
import { WatchScreen } from '@/modules/Watch'

export function PlayerPage() {
  const navigate = useNavigate()
  return <WatchScreen onClose={() => void navigate({ to: '/' })} />
}
