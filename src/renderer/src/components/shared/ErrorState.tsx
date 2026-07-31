interface ErrorStateProps {
  message?: string
  onRetry?: () => void
}

export default function ErrorState({
  message = 'Something went wrong',
  onRetry
}: ErrorStateProps): React.JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center max-w-sm px-4">
        <span className="text-5xl block mb-4">⚠️</span>
        <p className="text-lg font-medium text-danger">
          Error
        </p>
        <p className="text-sm mt-1 text-fg-muted">{message}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-4 px-4 py-2 rounded-lg bg-accent-fill text-white font-medium hover:bg-accent-hover transition-colors"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  )
}
