import { useState } from 'react'
import { Check, Eye, EyeOff } from 'lucide-react'
import { useAuthStore } from '../../stores/auth.store'
import Button from '../shared/Button'
import Notice from '../shared/Notice'

type ConnState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'connected'; username: string }
  | { status: 'failed'; error: string }

/**
 * Step 4 — nhentai API key.
 *
 * Skippable. Uses the same validation as the Settings page
 * (`window.api.auth.validateKey`), which also persists the key to the DB on
 * success. "Skip for now" advances without saving a key.
 */
export default function StepNhentai({
  onNext,
  onConfigured
}: {
  onNext: () => void
  onConfigured: (configured: boolean) => void
}): React.JSX.Element {
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [conn, setConn] = useState<ConnState>({ status: 'idle' })

  const validate = async (value: string): Promise<boolean> => {
    setConn({ status: 'testing' })
    try {
      const r = await window.api.auth.validateKey(value)
      if (r.success) {
        setConn({ status: 'connected', username: r.data.username })
        useAuthStore.getState().setAuth(true, r.data.username)
        return true
      }
      setConn({ status: 'failed', error: r.error || 'Invalid API key' })
      return false
    } catch (err) {
      setConn({ status: 'failed', error: String(err) })
      return false
    }
  }

  const handleTest = async (): Promise<void> => {
    if (!key.trim()) return
    await validate(key.trim())
  }

  const handleContinue = async (): Promise<void> => {
    if (!key.trim()) {
      onConfigured(false)
      onNext()
      return
    }
    if (conn.status !== 'connected') {
      const ok = await validate(key.trim())
      if (!ok) return
    }
    onConfigured(true)
    onNext()
  }

  const handleSkip = (): void => {
    onConfigured(false)
    onNext()
  }

  return (
    <div>
      <h2 className="text-2xl font-bold tracking-tight text-fg">Connect to nhentai (optional)</h2>
      <p className="mt-3 text-sm text-fg-muted">
        An API key lets you browse, search and favorite galleries directly from the app. Without
        one you can still use the library and download galleries by their ID number.
      </p>

      <div className="mt-6">
        <label htmlFor="onboarding-nhentai-key" className="block text-sm font-medium text-fg mb-1">
          API key
        </label>
        <div className="flex gap-2">
          <input
            id="onboarding-nhentai-key"
            type={show ? 'text' : 'password'}
            value={key}
            onChange={(e) => {
              setKey(e.target.value)
              if (conn.status !== 'idle') setConn({ status: 'idle' })
            }}
            placeholder="nhentai API key"
            spellCheck={false}
            className="min-w-0 flex-1 px-3 py-2 rounded-lg border border-line bg-surface font-mono text-sm text-fg placeholder-fg-faint focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? 'Hide API key' : 'Show API key'}
            className="shrink-0 px-3 py-2 rounded-lg border border-line text-fg-muted hover:bg-raised"
          >
            {show ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
          </button>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <Button
            onClick={handleTest}
            disabled={!key.trim() || conn.status === 'testing'}
          >
            {conn.status === 'testing' ? 'Testing…' : 'Test Connection'}
          </Button>
          {conn.status === 'connected' && (
            <span className="inline-flex items-center gap-1 text-sm text-success">
              <Check size={14} aria-hidden="true" /> Connected
            </span>
          )}
        </div>

        {conn.status === 'failed' && (
          <div className="mt-3">
            <Notice tone="error">{conn.error}</Notice>
          </div>
        )}

        <p className="mt-4 text-xs text-fg-faint">
          How to get one: Settings → Account on nhentai.net → API Key Management.
        </p>
      </div>

      <div className="mt-8 flex items-center justify-between">
        <Button onClick={handleSkip}>Skip for now</Button>
        <Button role="primary" onClick={handleContinue}>
          Continue
        </Button>
      </div>
    </div>
  )
}
