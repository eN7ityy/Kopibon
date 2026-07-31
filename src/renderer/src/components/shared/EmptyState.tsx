import { Inbox, type LucideIcon } from 'lucide-react'
import Button from './Button'

interface EmptyStateProps {
  /** Pass a lucide component, e.g. `icon={Library}`. */
  icon?: LucideIcon
  title: string
  description?: string
  actionLabel?: string
  onAction?: () => void
}

export default function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  actionLabel,
  onAction
}: EmptyStateProps): React.JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="flex flex-col items-center text-center text-fg-faint max-w-sm px-4">
        {/*
          A stroked icon at a restrained size rather than a 48px emoji. The
          emoji brought its own colour and weight, so an empty state shouted
          louder than the content around it.
        */}
        <Icon size={40} strokeWidth={1.5} className="mb-4 text-fg-faint" aria-hidden="true" />
        <p className="text-lg font-medium text-fg-muted">{title}</p>
        {description && <p className="text-sm mt-1">{description}</p>}
        {actionLabel && onAction && (
          <Button role="primary" onClick={onAction} extraClass="mt-4">
            {actionLabel}
          </Button>
        )}
      </div>
    </div>
  )
}
