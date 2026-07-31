import { useState } from 'react'
import { useSettingsStore } from '../../stores/settings.store'

interface ConvertToCbzDialogProps {
  /** How many PDFs will actually be converted. */
  count: number
  onCancel: () => void
  onConfirm: (keepOriginal: boolean) => void
}

/**
 * Confirmation for PDF → CBZ conversion, whose only real decision is what
 * happens to the source PDFs.
 *
 * This is a dialog rather than a silent read of the setting because deleting the
 * originals is irreversible and the choice is worth making per batch: keeping
 * them roughly doubles disk use, deleting them removes the fallback. The stored
 * setting supplies the default.
 */
export default function ConvertToCbzDialog({
  count,
  onCancel,
  onConfirm
}: ConvertToCbzDialogProps): React.JSX.Element {
  const defaultKeep = useSettingsStore((s) => s.cbzKeepOriginal)
  const [keepOriginal, setKeepOriginal] = useState(defaultKeep)
  const [confirmDelete, setConfirmDelete] = useState(false)

  /**
   * Switch mode, clearing the acknowledgement on the way back to "keep".
   *
   * Done here rather than in an effect so there is no render where the option is
   * "keep" while a stale confirmation is still ticked — and so toggling twice
   * cannot carry an old acknowledgement into a new choice.
   */
  const choose = (keep: boolean): void => {
    setKeepOriginal(keep)
    if (keep) setConfirmDelete(false)
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl bg-surface shadow-2xl border border-line"
      >
        <div className="px-5 py-4 border-b border-line">
          <h3 className="text-base font-semibold text-fg">
            Convert {count} file{count === 1 ? '' : 's'} to CBZ
          </h3>
          <p className="mt-1 text-xs text-fg-muted">
            Pages are copied without re-compressing, so the CBZ keeps the original image quality.
          </p>
        </div>

        <div className="px-5 py-4 space-y-2">
          <label className="flex gap-3 p-3 rounded-lg border cursor-pointer transition-colors border-line hover:bg-raised has-[:checked]:border-accent has-[:checked]:bg-accent-wash">
            <input
              type="radio"
              name="keep-original"
              checked={keepOriginal}
              onChange={() => choose(true)}
              className="mt-0.5 text-accent focus:ring-accent"
            />
            <span>
              <span className="block text-sm font-medium text-fg">
                Keep the original PDFs
              </span>
              <span className="block text-xs text-fg-muted mt-0.5">
                Moved to <code className="text-[11px]">_originals/</code> in your library. Uses
                roughly twice the disk space, and lets you go back.
              </span>
            </span>
          </label>

          <label className="flex gap-3 p-3 rounded-lg border cursor-pointer transition-colors border-line hover:bg-raised has-[:checked]:border-danger has-[:checked]:bg-danger-wash">
            <input
              type="radio"
              name="keep-original"
              checked={!keepOriginal}
              onChange={() => choose(false)}
              className="mt-0.5 text-danger focus:ring-danger"
            />
            <span>
              <span className="block text-sm font-medium text-fg">
                Delete the original PDFs
              </span>
              <span className="block text-xs text-fg-muted mt-0.5">
                Removed once the CBZ is verified as readable. Saves the space; cannot be undone.
              </span>
            </span>
          </label>

          {!keepOriginal && (
            <div className="p-3 rounded-lg bg-warning-wash border border-warning space-y-2">
              <p className="text-xs text-warning">
                A PDF is only deleted after its CBZ opens and every page is accounted for. Files
                that need the fallback converter are kept regardless, since for those the PDF is the
                better copy.
              </p>
              <label className="flex items-center gap-2 text-xs font-medium text-warning cursor-pointer">
                <input
                  type="checkbox"
                  checked={confirmDelete}
                  onChange={(e) => setConfirmDelete(e.target.checked)}
                  className="rounded text-danger focus:ring-danger"
                />
                I understand the PDFs will be deleted
              </label>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-line flex gap-2">
          <button
            onClick={() => onConfirm(keepOriginal)}
            disabled={!keepOriginal && !confirmDelete}
            className={`flex-1 px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed ${
              keepOriginal ? 'bg-accent-fill hover:bg-accent-hover' : 'bg-danger-fill hover:bg-danger-fill'
            }`}
          >
            {keepOriginal ? 'Convert and keep PDFs' : 'Convert and delete PDFs'}
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg bg-raised text-sm font-medium text-fg hover:bg-raised"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
