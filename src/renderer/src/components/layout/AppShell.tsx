import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import StatusBar from './StatusBar'
import { useCdnConfigStore } from '../../stores/cdn.store'

export default function AppShell(): React.JSX.Element {
  // Fetch the CDN server list once on mount, before any page renders cards, so
  // the rotation hook has servers to use by the time images start loading.
  useEffect(() => {
    useCdnConfigStore.getState().fetch()
  }, [])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-app">
      <Sidebar />
      <div className="flex flex-1 flex-col min-w-0">
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
        <StatusBar />
      </div>
    </div>
  )
}
