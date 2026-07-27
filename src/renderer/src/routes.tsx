import { Navigate, Route, Routes } from 'react-router-dom'
import AppShell from './components/layout/AppShell'
import SearchPage from './components/search/SearchPage'
import LibraryPage from './components/library/LibraryPage'
import DownloadsPage from './components/downloads/DownloadsPage'
import SettingsPage from './components/settings/SettingsPage'
import FavoritesPage from './components/favorites/FavoritesPage'
import FavoritesGuard from './components/favorites/FavoritesGuard'

export default function AppRoutes(): React.JSX.Element {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Navigate to="/search" replace />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route
          path="/favorites"
          element={
            <FavoritesGuard>
              <FavoritesPage />
            </FavoritesGuard>
          }
        />
        <Route path="/downloads" element={<DownloadsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  )
}
