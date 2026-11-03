import { HomeScreen } from '@/modules/Session'
import { SettingsPanel } from '@/modules/Settings'

export function HomePage() {
  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1">
        <HomeScreen />
      </div>
      <SettingsPanel />
    </div>
  )
}
