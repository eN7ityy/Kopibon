import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../stores/auth.store'

interface Props {
  children: React.ReactNode
}

export default function FavoritesGuard({ children }: Props): React.JSX.Element {
  const auth = useAuthStore()
  const navigate = useNavigate()

  useEffect(() => {
    if (!auth.loaded) {
      auth.loadAuthFromMain()
    }
  }, [auth])

  useEffect(() => {
    if (auth.loaded && !auth.loggedIn) {
      navigate('/search', { replace: true })
    }
  }, [auth.loaded, auth.loggedIn, navigate])

  if (!auth.loaded) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-fg-faint">Checking authentication...</div>
      </div>
    )
  }

  if (!auth.loggedIn) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-fg-faint">Redirecting...</div>
      </div>
    )
  }

  return <>{children}</>
}
