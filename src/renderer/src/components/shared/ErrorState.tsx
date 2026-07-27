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
        <p className="text-lg font-medium text-red-500 dark:text-red-400">
          Error
        </p>
        <p className="text-sm mt-1 text-gray-500 dark:text-gray-400">{message}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-4 px-4 py-2 rounded-lg bg-purple-600 text-white font-medium hover:bg-purple-700 transition-colors"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  )
}
