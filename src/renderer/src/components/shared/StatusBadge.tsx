import type { DownloadStatus } from '../../types/api.types'
import {
  Check,
  Clock,
  Download,
  RefreshCw,
  X,
  type LucideIcon
} from 'lucide-react'

interface StatusBadgeProps {
  status: DownloadStatus
  size?: 'sm' | 'md'
  showLabel?: boolean
}

/**
 * Status was encoded three ways at once — a colour, an emoji, and a label —
 * where the emoji and the colour said the same thing and the emoji ignored the
 * theme. The colour and label stay; the glyph becomes a stroked icon inheriting
 * `currentColor`, so it takes the state colour from the wrapper.
 */
const STATUS_CONFIG: Record<
  DownloadStatus,
  { label: string; bg: string; text: string; Icon: LucideIcon | null; spin?: boolean }
> = {
  not_downloaded: {
    label: '',
    bg: '',
    text: '',
    Icon: null
  },
  in_library: {
    label: 'In Library',
    bg: 'bg-success-wash',
    text: 'text-success',
    Icon: Check
  },
  queued: {
    label: 'Queued',
    bg: 'bg-warning-wash',
    text: 'text-warning',
    Icon: Clock
  },
  downloading: {
    label: 'Downloading',
    bg: 'bg-info-wash',
    text: 'text-info',
    Icon: Download
  },
  converting: {
    label: 'Converting',
    bg: 'bg-accent-wash',
    text: 'text-accent',
    Icon: RefreshCw,
    spin: true
  },
  completed: {
    label: 'Completed',
    bg: 'bg-success-wash',
    text: 'text-success',
    Icon: Check
  },
  failed: {
    label: 'Failed',
    bg: 'bg-danger-wash',
    text: 'text-danger',
    Icon: X
  }
}

export default function StatusBadge({ status, size = 'sm', showLabel = true }: StatusBadgeProps): React.JSX.Element | null {
  if (status === 'not_downloaded') return null

  const config = STATUS_CONFIG[status]
  const sizeClasses = size === 'sm' ? 'text-xs px-1.5 py-0.5' : 'text-sm px-2 py-1'
  const iconSize = size === 'sm' ? 12 : 14
  const { Icon } = config

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium ${sizeClasses} ${config.bg} ${config.text}`}
      title={config.label}
    >
      {Icon && (
        <Icon
          size={iconSize}
          strokeWidth={2.5}
          className={config.spin ? 'animate-spin' : undefined}
          aria-hidden="true"
        />
      )}
      {showLabel && config.label}
    </span>
  )
}
