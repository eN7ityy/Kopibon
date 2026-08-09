import { NavLink, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useUiStore } from '../../stores/ui.store'
import { useAuthStore } from '../../stores/auth.store'
import {
  Search,
  Star,
  Library,
  Download,
  Settings,
  Sun,
  Moon,
  MonitorSmartphone,
  type LucideIcon
} from 'lucide-react'

interface NavItem {
  to: string
  label: string
  Icon: LucideIcon
  requiresAuth?: boolean
}

/**
 * Nav icons were emoji (🔍 ⭐ 📚 ⬇️ ⚙️), which render in the OS emoji font and
 * so carry their own colour, weight and baseline — none of which respond to the
 * palette, the type scale or the theme. These inherit `currentColor`, so the
 * active and hover states below style them for free.
 */
const navItems: NavItem[] = [
  { to: '/search', label: 'Search', Icon: Search },
  { to: '/favorites', label: 'Favorites', Icon: Star, requiresAuth: true },
  { to: '/library', label: 'Library', Icon: Library },
  { to: '/downloads', label: 'Downloads', Icon: Download },
  { to: '/settings', label: 'Settings', Icon: Settings }
]

export default function Sidebar(): React.JSX.Element {
  const { sidebarCollapsed, setActiveRoute, theme, setTheme } = useUiStore()
  const auth = useAuthStore()
  const location = useLocation()
  const [downloadCount, setDownloadCount] = useState(0)
  // True while an update is available, downloading, or ready to apply — the
  // Settings entry carries a tiny accent dot to draw the user in. It does not
  // auto-download, so nothing happens until they visit Settings and act.
  const [updatePending, setUpdatePending] = useState(false)

  useEffect(() => {
    setActiveRoute(location.pathname)
  }, [location.pathname, setActiveRoute])

  // Load auth status on mount
  useEffect(() => {
    if (!auth.loaded) {
      auth.loadAuthFromMain()
    }
  }, [auth])

  // Poll active + converting download count for badge
  useEffect(() => {
    const poll = async () => {
      try {
        const r = await window.api.downloads.getStatusCounts()
        if (r.success && r.data) {
          setDownloadCount(r.data.active)
        }
      } catch { /* ignore */ }
    }
    poll()
    const interval = setInterval(poll, 2000)
    return () => clearInterval(interval)
  }, [])

  // Flip the update indicator on the Settings entry as the updater moves
  // through its states. 'current' and 'error' clear it; 'idle'/'checking' leave
  // it untouched so a fresh check doesn't flash it off mid-flight.
  useEffect(() => {
    const off = window.api.onUpdateStatus((s) => {
      if (s.state === 'available' || s.state === 'downloading' || s.state === 'ready') {
        setUpdatePending(true)
      } else if (s.state === 'current' || s.state === 'error') {
        setUpdatePending(false)
      }
    })
    return () => { off() }
  }, [])

  const cycleTheme = (): void => {
    const order: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system']
    const idx = order.indexOf(theme)
    setTheme(order[(idx + 1) % order.length])
  }

  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : MonitorSmartphone
  const themeLabel = theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'System'
  // The button cycles, so say where it goes next rather than only where it is.
  const nextLabel = theme === 'light' ? 'Dark' : theme === 'dark' ? 'System' : 'Light'

  return (
    <aside
      className={`flex flex-col bg-chrome border-r border-line transition-all duration-200 ${
        sidebarCollapsed ? 'w-16' : 'w-56'
      }`}
    >
      {/* Wordmark. The accent carries the mark; the rest of the chrome stays quiet. */}
      <div className="flex items-center gap-2 h-14 px-4 border-b border-line">
        <span className="h-5 w-1 rounded-full bg-accent shrink-0" aria-hidden="true" />
        {!sidebarCollapsed && (
          <span className="text-lg font-bold tracking-tight text-fg truncate">
            Kopi<span className="text-accent">bon</span>
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 space-y-1 px-2">
        {navItems
          .filter((item) => !item.requiresAuth || auth.loggedIn)
          .map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              // The title is always set, not just when collapsed: a collapsed
              // sidebar was previously unreadable until you guessed by hovering,
              // because the labels were hidden with no tooltip behind them.
              title={item.label}
              className={({ isActive }) =>
                // `relative` so the collapsed-mode badge below anchors to this
                // row. Without it the absolutely positioned badge climbed to the
                // nearest positioned ancestor — of which there was none in the
                // sidebar — and landed in the wrong place entirely.
                `relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-accent-wash text-accent'
                    : 'text-fg-muted hover:bg-raised hover:text-fg'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {/*
                    A leading accent bar for the active row, rather than relying
                    on a tinted fill alone. It reads more deliberate and it
                    survives the palette change without needing a pale accent.
                  */}
                  {isActive && (
                    <span
                      className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded-r bg-accent"
                      aria-hidden="true"
                    />
                  )}
                  <item.Icon size={20} strokeWidth={isActive ? 2.25 : 2} className="shrink-0" />
                  {!sidebarCollapsed && (
                    <span className="truncate flex items-center gap-1.5">
                      {item.label}
                      {item.to === '/downloads' && downloadCount > 0 && (
                        <span className="tnum inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-label font-bold rounded-full bg-accent-fill text-white">
                          {downloadCount}
                        </span>
                      )}
                    </span>
                  )}
                  {sidebarCollapsed && item.to === '/downloads' && downloadCount > 0 && (
                    <span className="tnum absolute top-0.5 right-0.5 inline-flex items-center justify-center min-w-[16px] h-[16px] px-0.5 text-label font-bold rounded-full bg-accent-fill text-white">
                      {downloadCount}
                    </span>
                  )}
                  {item.to === '/settings' && updatePending && (
                    // `ml-auto` pins the dot to the right edge of the row in
                    // both collapsed and expanded modes — a small accent dot,
                    // not a popup or banner, to draw the eye to Settings.
                    <span
                      className="ml-auto h-2 w-2 shrink-0 rounded-full bg-accent"
                      aria-label="Update available"
                    />
                  )}
                </>
              )}
            </NavLink>
          ))}
      </nav>

      {/* Theme Toggle */}
      <div className="p-2 border-t border-line">
        <button
          onClick={cycleTheme}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium text-fg-muted hover:bg-raised hover:text-fg transition-colors"
          title={`Theme: ${themeLabel} — click for ${nextLabel}`}
        >
          <ThemeIcon size={20} className="shrink-0" />
          {!sidebarCollapsed && <span className="truncate">{themeLabel}</span>}
        </button>
      </div>
    </aside>
  )
}
