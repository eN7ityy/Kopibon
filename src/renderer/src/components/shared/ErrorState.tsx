import { AlertTriangle } from 'lucide-react'
import Button from './Button'

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
      <div className="flex flex-col items-center text-center max-w-sm px-4">
        <AlertTriangle
          size={40}
          strokeWidth={1.5}
          className="mb-4 text-danger"
          aria-hidden="true"
        />
        <p className="text-lg font-medium text-danger">Error</p>
        <p className="text-sm mt-1 text-fg-muted">{message}</p>
        {onRetry && (
          <Button role="primary" onClick={onRetry} extraClass="mt-4">
            Retry
          </Button>
        )}
      </div>
    </div>
  )
}
