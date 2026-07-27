import { NavLink, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import { useUiStore } from '../../stores/ui.store'
import { useAuthStore } from '../../stores/auth.store'

interface NavItem {
  to: string
  label: string
  icon: string
  requiresAuth?: boolean
}

const navItems: NavItem[] = [
  { to: '/search', label: 'Search', icon: '🔍' },
  { to: '/library', label: 'Library', icon: '📚' },
  { to: '/favorites', label: 'Favorites', icon: '⭐', requiresAuth: true },
  { to: '/downloads', label: 'Downloads', icon: '⬇️' },
  { to: '/settings', label: 'Settings', icon: '⚙️' }
]

export default function Sidebar(): React.JSX.Element {
  const { sidebarCollapsed, setActiveRoute, theme, setTheme } = useUiStore()
  const auth = useAuthStore()
  const location = useLocation()

  useEffect(() => {
    setActiveRoute(location.pathname)
  }, [location.pathname, setActiveRoute])

  // Load auth status on mount
  useEffect(() => {
    if (!auth.loaded) {
      auth.loadAuthFromMain()
    }
  }, [auth])

  const cycleTheme = (): void => {
    const order: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system']
    const idx = order.indexOf(theme)
    setTheme(order[(idx + 1) % order.length])
  }

  const themeIcon = theme === 'dark' ? '🌙' : theme === 'light' ? '☀️' : '🖥️'
  const themeLabel = theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'System'

  return (
    <aside
      className={`flex flex-col bg-gray-100 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 transition-all duration-200 ${
        sidebarCollapsed ? 'w-16' : 'w-56'
      }`}
    >
      {/* App Title */}
      <div className="flex items-center h-14 px-4 border-b border-gray-200 dark:border-gray-800">
        {!sidebarCollapsed && (
          <span className="text-lg font-bold text-gray-800 dark:text-gray-200 truncate">
            Doujin DL
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
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-800'
                }`
              }
            >
              <span className="text-xl flex-shrink-0">{item.icon}</span>
              {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
            </NavLink>
          ))}
      </nav>

      {/* Theme Toggle */}
      <div className="p-2 border-t border-gray-200 dark:border-gray-800">
        <button
          onClick={cycleTheme}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors"
          title={`Theme: ${themeLabel}`}
        >
          <span className="text-xl flex-shrink-0">{themeIcon}</span>
          {!sidebarCollapsed && <span className="truncate">{themeLabel} Mode</span>}
        </button>
      </div>
    </aside>
  )
}
