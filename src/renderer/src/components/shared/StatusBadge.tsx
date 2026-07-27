import type { DownloadStatus } from '../../types/api.types'

interface StatusBadgeProps {
  status: DownloadStatus
  size?: 'sm' | 'md'
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
    bg: 'bg-green-100 dark:bg-green-900/30',
    text: 'text-green-700 dark:text-green-400',
    icon: '✓'
  },
  queued: {
    label: 'Queued',
    bg: 'bg-orange-100 dark:bg-orange-900/30',
    text: 'text-orange-700 dark:text-orange-400',
    icon: '⏳'
  },
  downloading: {
    label: 'Downloading',
    bg: 'bg-blue-100 dark:bg-blue-900/30',
    text: 'text-blue-700 dark:text-blue-400',
    icon: '⬇'
  },
  converting: {
    label: 'Converting',
    bg: 'bg-purple-100 dark:bg-purple-900/30',
    text: 'text-purple-700 dark:text-purple-400',
    icon: '🔄'
  },
  completed: {
    label: 'Completed',
    bg: 'bg-green-100 dark:bg-green-900/30',
    text: 'text-green-700 dark:text-green-400',
    icon: '✓'
  },
  failed: {
    label: 'Failed',
    bg: 'bg-red-100 dark:bg-red-900/30',
    text: 'text-red-700 dark:text-red-400',
    icon: '✗'
  }
}

export default function StatusBadge({ status, size = 'sm' }: StatusBadgeProps): React.JSX.Element | null {
  if (status === 'not_downloaded') return null

  const config = STATUS_CONFIG[status]
  const sizeClasses = size === 'sm' ? 'text-xs px-1.5 py-0.5' : 'text-sm px-2 py-1'

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium ${sizeClasses} ${config.bg} ${config.text}`}
    >
      <span>{config.icon}</span>
      {config.label}
    </span>
  )
}
