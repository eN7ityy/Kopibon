import type { ReactNode } from 'react'
import { AlertTriangle, Info, CheckCircle2, X } from 'lucide-react'

/**
 * One shape for every inline message.
 *
 * Pages previously stacked their own hand-rolled banners — Library had an error
 * banner, a storage warning, a progress stack and a resume banner, each with its
 * own padding, radius and margin, and two of them used the same red despite one
 * being a warning. With two showing at once the grid started below the fold.
 *
 * `tone` is the only thing a caller chooses; the icon follows from it, so a
 * warning cannot end up wearing the error colour.
 */
export type NoticeTone = 'error' | 'warning' | 'success' | 'info'

const TONE: Record<NoticeTone, { box: string; text: string; Icon: typeof AlertTriangle }> = {
  error: { box: 'bg-danger-wash border-danger', text: 'text-danger', Icon: AlertTriangle },
  warning: { box: 'bg-warning-wash border-warning', text: 'text-warning', Icon: AlertTriangle },
  success: { box: 'bg-success-wash border-success', text: 'text-success', Icon: CheckCircle2 },
  info: { box: 'bg-info-wash border-info', text: 'text-info', Icon: Info }
}

interface NoticeProps {
  tone?: NoticeTone
  children: ReactNode
  /** Renders a dismiss button when provided. */
  onDismiss?: () => void
}

export default function Notice({
  tone = 'info',
  children,
  onDismiss
}: NoticeProps): React.JSX.Element {
  const { box, text, Icon } = TONE[tone]

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${box} ${text}`}
    >
      <Icon size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0">{children}</div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 opacity-70 hover:opacity-100 transition-opacity"
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

/**
 * The single region a page puts its notices in, so they share one gap and one
 * position instead of each carrying its own bottom margin.
 */
export function NoticeRegion({ children }: { children: ReactNode }): React.JSX.Element | null {
  // An empty region should not contribute its gap or margin.
  const hasAny = Array.isArray(children)
    ? children.some(Boolean)
    : Boolean(children)
  if (!hasAny) return null

  return <div className="shrink-0 flex flex-col gap-2 mb-4">{children}</div>
}
