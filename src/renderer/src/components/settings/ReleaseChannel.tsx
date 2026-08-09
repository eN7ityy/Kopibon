import { useSettingsStore } from '../../stores/settings.store'
import type { ReleaseChannel as ReleaseChannelValue } from '../../stores/settings.store'
import Notice from '../shared/Notice'

/**
 * Persisted immediately, not via the page's Save button. This control lives on
 * the Advanced pane, which deliberately has no Save button (see SettingsPage's
 * `savable` flags), so staging the value in the store alone meant the choice
 * was never written to the DB — and so `allowPrerelease` never changed and a
 * newer beta was never offered. Saving here triggers settings.ipc.ts's
 * LIVE_SETTINGS for `releaseChannel`, which re-applies the channel in the
 * updater and immediately re-checks for updates.
 */
export default function ReleaseChannel(): React.JSX.Element {
  const releaseChannel = useSettingsStore((s) => s.releaseChannel)
  const setReleaseChannel = useSettingsStore((s) => s.setReleaseChannel)

  const handleChange = async (channel: ReleaseChannelValue): Promise<void> => {
    setReleaseChannel(channel)
    await window.api.settings.set('releaseChannel', channel)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <label htmlFor="release-channel" className="text-sm text-fg">
          Update channel
        </label>
        <select
          id="release-channel"
          value={releaseChannel}
          onChange={(e) => void handleChange(e.target.value as ReleaseChannelValue)}
          className="px-2 py-1.5 rounded-lg text-sm bg-raised border border-line text-fg"
        >
          <option value="stable">Stable</option>
          <option value="beta">Beta</option>
        </select>
      </div>

      {releaseChannel === 'beta' && (
        <Notice tone="warning">
          Beta builds get new features early but are less tested and more likely to have bugs.
          Switching back to Stable stops further beta updates, but will not roll back a beta version
          already installed.
        </Notice>
      )}
    </div>
  )
}
