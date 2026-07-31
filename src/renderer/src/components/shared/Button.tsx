import type { ReactNode, ButtonHTMLAttributes } from 'react'

/**
 * The four button roles from the design audit.
 *
 * The Library toolbar previously put eight buttons in one row in eight
 * saturated hues — purple, green, blue, grey, green, indigo, orange, red — so
 * nothing receded and nothing led. Two of them were the same green for
 * different things, and "Remove from Library" and "Delete Files" were nearly
 * the same colour despite one being reversible and one not.
 *
 * The fix is that **importance is carried by fill versus outline, and hue only
 * ever means state**. One filled primary per view; everything else recedes.
 *
 * - `primary`   filled accent. At most one per view.
 * - `secondary` outlined. The default for ordinary actions.
 * - `ghost`     no border until hover. Minor, reversible actions.
 * - `danger`    red outline, for actions that destroy data. Filled red is
 *               reserved for the confirm dialog, where it is that dialog's
 *               primary and there is nothing to compete with.
 */
export type ButtonRole = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  role?: ButtonRole
  size?: ButtonSize
  /** Leading icon. Pass a lucide component at 14px (sm) or 16px (md). */
  icon?: ReactNode
  /** Trailing count, rendered in tabular figures so it does not shift width. */
  count?: number
  children?: ReactNode
  /** Escape hatch for layout only — never for colour. */
  extraClass?: string
}

const ROLE: Record<ButtonRole, string> = {
  primary: 'bg-accent-fill text-white border-transparent hover:bg-accent-hover',
  secondary: 'bg-transparent text-fg border-line hover:bg-raised',
  ghost: 'bg-transparent text-fg-muted border-transparent hover:bg-raised hover:text-fg',
  danger: 'bg-transparent text-danger border-danger hover:bg-danger-wash'
}

const SIZE: Record<ButtonSize, string> = {
  // Two sizes only. The old code split between px-4 py-2 and px-3 py-2 with no
  // distinction behind it, which is why the toolbars looked unaligned.
  sm: 'text-xs px-2.5 py-1.5 gap-1.5',
  md: 'text-sm px-3.5 py-2 gap-2'
}

export default function Button({
  role = 'secondary',
  size = 'md',
  icon,
  count,
  children,
  extraClass = '',
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      className={[
        'inline-flex items-center justify-center rounded-lg border font-medium',
        'transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
        ROLE[role],
        SIZE[size],
        extraClass
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {icon}
      {children}
      {count !== undefined && count > 0 && (
        <span className="tnum opacity-60">{count}</span>
      )}
    </button>
  )
}
