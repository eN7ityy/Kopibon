import type { DownloadStatus } from '../../types/api.types'

interface StatusBadgeProps {
  status: DownloadStatus
  size?: 'sm' | 'md'
  showLabel?: boolean
}

const STATUS_CONFIG: Record<
  DownloadStatus,
  { label: string; bg: string; text: string; icon: string }
> = {
  not_downloaded: {
    label: '',
    bg: '',
    text: '',
    icon: ''
  },
  in_library: {
    label: 'In Library',
    bg: 'bg-success-wash',
    text: 'text-success',
    icon: '✓'
  },
  queued: {
    label: 'Queued',
    bg: 'bg-warning-wash',
    text: 'text-warning',
    icon: '⏳'
  },
  downloading: {
    label: 'Downloading',
    bg: 'bg-info-wash',
    text: 'text-info',
    icon: '⬇'
  },
  converting: {
    label: 'Converting',
    bg: 'bg-accent-wash',
    text: 'text-accent',
    icon: '🔄'
  },
  completed: {
    label: 'Completed',
    bg: 'bg-success-wash',
    text: 'text-success',
    icon: '✓'
  },
  failed: {
    label: 'Failed',
    bg: 'bg-danger-wash',
    text: 'text-danger',
    icon: '✗'
  }
}

export default function StatusBadge({ status, size = 'sm', showLabel = true }: StatusBadgeProps): React.JSX.Element | null {
  if (status === 'not_downloaded') return null

  const config = STATUS_CONFIG[status]
  const sizeClasses = size === 'sm' ? 'text-xs px-1.5 py-0.5' : 'text-sm px-2 py-1'

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium ${sizeClasses} ${config.bg} ${config.text}`}
    >
      <span>{config.icon}</span>
      {showLabel && config.label}
    </span>
  )
}
