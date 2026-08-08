import { useSettingsStore } from '../../stores/settings.store'
import type { ReleaseChannel as ReleaseChannelValue } from '../../stores/settings.store'
import Notice from '../shared/Notice'

/**
 * Like every other field on this page, the choice is staged here and only
 * takes effect in main once the page's Save button is pressed — see
 * settings.ipc.ts's LIVE_SETTINGS, which re-applies it and re-checks for
 * updates immediately after the save.
 */
export default function ReleaseChannel(): React.JSX.Element {
  const releaseChannel = useSettingsStore((s) => s.releaseChannel)
  const setReleaseChannel = useSettingsStore((s) => s.setReleaseChannel)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <label htmlFor="release-channel" className="text-sm text-fg">
          Update channel
        </label>
        <select
          id="release-channel"
          value={releaseChannel}
          onChange={(e) => setReleaseChannel(e.target.value as ReleaseChannelValue)}
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
