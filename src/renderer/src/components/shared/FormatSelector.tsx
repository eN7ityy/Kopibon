import { useSettingsStore, type OutputFormat } from '../../stores/settings.store'

interface FormatSelectorProps {
  value: OutputFormat
  onChange: (format: OutputFormat) => void
  className?: string
}

export default function FormatSelector({
  value,
  onChange,
  className = ''
}: FormatSelectorProps): React.JSX.Element {
  const defaultFormat = useSettingsStore((s) => s.outputFormat)

  return (
    <select
      value={value || defaultFormat}
      onChange={(e) => onChange(e.target.value as OutputFormat)}
      className={`px-3 py-2 rounded-lg border border-line bg-surface text-sm text-fg focus:ring-2 focus:ring-accent focus:border-transparent ${className}`}
    >
      <option value="pdf">PDF</option>
      <option value="cbz">CBZ</option>
    </select>
  )
}
