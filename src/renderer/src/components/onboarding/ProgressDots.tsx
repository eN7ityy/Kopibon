import { Fragment } from 'react'
import { Check } from 'lucide-react'

/**
 * The step indicator row shown at the top of every wizard step.
 *
 * The current step is filled, completed steps show a checkmark, future steps
 * are hollow. Clicking a completed step goes back to it; clicking a future
 * step does nothing. Informational only — it shows where the user is in the
 * flow without overwhelming them.
 */
export default function ProgressDots({
  steps,
  current,
  onSelect
}: {
  steps: string[]
  current: number
  onSelect: (index: number) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-center">
      {steps.map((label, i) => {
        const state = i === current ? 'current' : i < current ? 'done' : 'future'
        return (
          <Fragment key={label}>
            {i > 0 && <span className="h-px w-4 bg-line" aria-hidden="true" />}
            <button
              type="button"
              onClick={() => {
                if (i < current) onSelect(i)
              }}
              disabled={i > current}
              aria-current={i === current ? 'step' : undefined}
              title={label}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
                state === 'current'
                  ? 'text-accent'
                  : state === 'done'
                    ? 'text-fg-muted hover:text-fg'
                    : 'text-fg-faint cursor-default'
              }`}
            >
              <span
                className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${
                  state === 'current'
                    ? 'bg-accent-fill text-white'
                    : state === 'done'
                      ? 'bg-success text-white'
                      : 'border border-line text-fg-faint'
                }`}
              >
                {state === 'done' ? <Check size={10} aria-hidden="true" /> : null}
              </span>
              <span className="hidden sm:inline">{label}</span>
            </button>
          </Fragment>
        )
      })}
    </div>
  )
}
