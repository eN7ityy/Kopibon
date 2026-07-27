interface EmptyStateProps {
  icon?: string
  title: string
  description?: string
  actionLabel?: string
  onAction?: () => void
}

export default function EmptyState({
  icon = '📭',
  title,
  description,
  actionLabel,
  onAction
}: EmptyStateProps): React.JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center text-gray-400 dark:text-gray-500 max-w-sm px-4">
        <span className="text-5xl block mb-4">{icon}</span>
        <p className="text-lg font-medium text-gray-600 dark:text-gray-300">{title}</p>
        {description && <p className="text-sm mt-1">{description}</p>}
        {actionLabel && onAction && (
          <button
            onClick={onAction}
            className="mt-4 px-4 py-2 rounded-lg bg-purple-600 text-white font-medium hover:bg-purple-700 transition-colors"
          >
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  )
}
