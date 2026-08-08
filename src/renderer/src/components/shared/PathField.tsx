import { FolderOpen } from 'lucide-react'
import Button from './Button'

/**
 * A path with a Browse button.
 *
 * The field stays editable: a path can be pasted, and on a network share typing
 * it is often easier than browsing to it. Browse seeds the dialog with whatever
 * is already there, or with `browseFrom` when the field is empty and showing a
 * resolved default.
 *
 * Extracted from SettingsPage so the onboarding wizard can reuse the same
 * input + native folder dialog without duplicating it.
 */
export default function PathField({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
  browseFrom
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  hint?: React.ReactNode
  browseFrom?: string
}): React.JSX.Element {
  const browse = async (): Promise<void> => {
    try {
      const result = await window.api.dialog.openDirectory(value || browseFrom || undefined)
      if (result.success && result.data) onChange(result.data as string)
    } catch {
      /* the dialog was dismissed, or no window was available */
    }
  }

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-fg mb-1">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className="min-w-0 flex-1 px-3 py-2 rounded-lg border border-line bg-surface font-mono text-sm text-fg placeholder-fg-faint focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <Button icon={<FolderOpen size={16} />} onClick={browse} extraClass="shrink-0">
          Browse
        </Button>
      </div>
      {hint && <p className="mt-1 text-xs text-fg-faint">{hint}</p>}
    </div>
  )
}
