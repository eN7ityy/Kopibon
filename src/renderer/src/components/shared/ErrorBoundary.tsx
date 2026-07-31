import { Component, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  errorId: string | null
}

type LogBridge = {
  log?: {
    write?: (level: string, scope: string, msg: string, fields?: Record<string, unknown>) => unknown
  }
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null, errorId: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorId: null }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Generate an error identifier for the user to quote
    const errorId = `E-${Math.random().toString(36).slice(2, 10).toUpperCase()}`
    this.setState({ errorId })

    // Log to the main process so it reaches the log file
    try {
      ;(window as unknown as { api?: LogBridge }).api?.log?.write?.('error', 'renderer:ErrorBoundary', error.message, {
        err: { name: error.name, message: error.message, stack: error.stack },
        componentStack: errorInfo.componentStack,
        errorId
      })
    } catch {
      // Logger unavailable — carry on
    }

    // Also fire-and-forget to console in dev so devtools still sees it
    console.error('[ErrorBoundary]', error.message, errorInfo.componentStack)
  }

  handleCopyErrorId = (): void => {
    if (this.state.errorId) {
      navigator.clipboard.writeText(this.state.errorId).catch(() => {
        /* clipboard may be denied */
      })
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-full">
          <div className="text-center text-danger">
            <AlertTriangle size={40} strokeWidth={1.5} className="mx-auto mb-3 text-danger" aria-hidden="true" />
            <p className="text-lg font-medium">Something went wrong</p>
            <p className="text-sm mt-1 max-w-md break-all">
              {this.state.error?.message}
            </p>
            {this.state.errorId && (
              <p className="text-xs mt-2 text-fg-muted">
                Error ID:{' '}
                <code className="bg-raised px-1 py-0.5 rounded font-mono">
                  {this.state.errorId}
                </code>
                <button
                  onClick={this.handleCopyErrorId}
                  className="ml-2 text-xs underline hover:no-underline text-accent"
                  title="Copy error ID to clipboard"
                >
                  Copy
                </button>
              </p>
            )}
            <button
              onClick={() =>
                this.setState({ hasError: false, error: null, errorId: null })
              }
              className="mt-4 px-4 py-2 rounded-lg bg-accent-fill text-white font-medium hover:bg-accent-hover transition-colors"
            >
              Try Again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
