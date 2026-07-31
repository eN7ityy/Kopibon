interface LoadingSkeletonProps {
  /** Number of skeleton cards to render (default: 1) */
  count?: number
  /** Variant: 'card' for gallery cards, 'detail' for detail panel, 'line' for text rows */
  variant?: 'card' | 'detail' | 'line'
}

export default function LoadingSkeleton({
  count = 1,
  variant = 'card'
}: LoadingSkeletonProps): React.JSX.Element {
  if (variant === 'card') {
    return (
      <>
        {Array.from({ length: count }, (_, i) => (
          <div
            key={i}
            className="rounded-lg overflow-hidden bg-raised animate-pulse"
          >
            {/* Cover placeholder */}
            <div className="aspect-[3/4] bg-raised" />
            {/* Text placeholders */}
            <div className="p-3 space-y-2">
              <div className="h-4 bg-raised rounded w-full" />
              <div className="h-4 bg-raised rounded w-2/3" />
              <div className="flex gap-2">
                <div className="h-5 bg-raised rounded w-16" />
                <div className="h-5 bg-raised rounded w-12" />
              </div>
            </div>
          </div>
        ))}
      </>
    )
  }

  if (variant === 'detail') {
    return (
      <div className="animate-pulse space-y-4 p-6">
        <div className="aspect-[3/4] max-w-sm mx-auto bg-raised rounded-lg" />
        <div className="h-7 bg-raised rounded w-3/4" />
        <div className="h-5 bg-raised rounded w-1/2" />
        <div className="flex gap-2">
          <div className="h-6 bg-raised rounded w-20" />
          <div className="h-6 bg-raised rounded w-20" />
          <div className="h-6 bg-raised rounded w-20" />
        </div>
        <div className="space-y-2">
          <div className="h-4 bg-raised rounded w-full" />
          <div className="h-4 bg-raised rounded w-5/6" />
        </div>
      </div>
    )
  }

  // line variant
  return (
    <div className="animate-pulse space-y-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="w-10 h-14 bg-raised rounded" />
          <div className="flex-1 space-y-2">
            <div className="h-4 bg-raised rounded w-3/4" />
            <div className="h-3 bg-raised rounded w-1/2" />
          </div>
        </div>
      ))}
    </div>
  )
}
