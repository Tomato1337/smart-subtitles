import { Presence } from '@tomato1337/m3e-react'
import { HomeScreen } from '@/modules/Session'
import { SetupWizard, useSetupWizard } from '@/modules/Settings'

export function HomePage() {
  const wizard = useSetupWizard()
  return (
    <div className="h-full overflow-y-auto overflow-x-clip">
      <HomeScreen onOpenWizard={wizard.show} />
      <Presence>{wizard.open && <SetupWizard onClose={wizard.close} />}</Presence>
    </div>
  )
}
