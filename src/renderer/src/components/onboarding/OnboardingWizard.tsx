import { useState } from 'react'
import { useSettingsStore } from '../../stores/settings.store'
import ProgressDots from './ProgressDots'
import StepWelcome from './StepWelcome'
import StepLibrary from './StepLibrary'
import StepThumbnails from './StepThumbnails'
import StepNhentai from './StepNhentai'
import StepKavita from './StepKavita'
import StepSummary from './StepSummary'

const STEPS = ['Welcome', 'Library', 'Thumbnails', 'nhentai', 'Kavita', 'Summary']

/**
 * First-boot setup wizard.
 *
 * A full-screen takeover rendered by App.tsx instead of the normal UI when
 * `onboardingCompleted` is not set. Each step owns its own form state and
 * saves values to the settings store (and the DB) as the user advances, so
 * closing the app mid-wizard keeps what was already entered. The
 * `onboardingCompleted` flag is only set on the final "Start using Kopibon"
 * click.
 */
export default function OnboardingWizard(): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [scanAfterSetup, setScanAfterSetup] = useState(true)
  const [nhentaiConfigured, setNhentaiConfigured] = useState(false)
  const [kavitaConfigured, setKavitaConfigured] = useState(false)

  const handleFinish = async (): Promise<void> => {
    // Set the flag in the store first so saveToDb (which reads the current
    // state) persists 'true' rather than the previous 'false'. Persisting
    // before unmounting means a quit right after finishing does not bring the
    // wizard back on the next launch.
    useSettingsStore.getState().setOnboardingCompleted(true)
    await useSettingsStore.getState().saveToDb()
  }

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-app p-6">
      <div className="w-full max-w-xl">
        <div className="mb-8">
          <ProgressDots steps={STEPS} current={step} onSelect={setStep} />
        </div>
        <div className="rounded-2xl border border-line bg-surface p-8 shadow-lg">
          {step === 0 && <StepWelcome onNext={() => setStep(1)} />}
          {step === 1 && (
            <StepLibrary
              onNext={() => setStep(2)}
              onBack={() => setStep(0)}
              scanAfterSetup={scanAfterSetup}
              setScanAfterSetup={setScanAfterSetup}
            />
          )}
          {step === 2 && <StepThumbnails onNext={() => setStep(3)} onBack={() => setStep(1)} />}
          {step === 3 && (
            <StepNhentai onNext={() => setStep(4)} onConfigured={setNhentaiConfigured} />
          )}
          {step === 4 && (
            <StepKavita onNext={() => setStep(5)} onConfigured={setKavitaConfigured} />
          )}
          {step === 5 && (
            <StepSummary
              onFinish={handleFinish}
              nhentaiConfigured={nhentaiConfigured}
              kavitaConfigured={kavitaConfigured}
              scanAfterSetup={scanAfterSetup}
            />
          )}
        </div>
      </div>
    </div>
  )
}
