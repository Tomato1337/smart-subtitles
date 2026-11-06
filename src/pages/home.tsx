import { Presence } from '@tomato1337/m3e-react'
import { HomeScreen } from '@/modules/Session'
import { SettingsPanel, SetupWizard, useSetupWizard } from '@/modules/Settings'

export function HomePage() {
  const wizard = useSetupWizard()
  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1">
        <HomeScreen />
      </div>
      <SettingsPanel onOpenWizard={wizard.show} />
      <Presence>{wizard.open && <SetupWizard onClose={wizard.close} />}</Presence>
    </div>
  )
}
