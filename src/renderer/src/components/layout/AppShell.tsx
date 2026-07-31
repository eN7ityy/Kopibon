import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import StatusBar from './StatusBar'

export default function AppShell(): React.JSX.Element {
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
