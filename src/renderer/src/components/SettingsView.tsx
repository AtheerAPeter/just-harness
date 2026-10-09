import { useEffect, useState } from 'react'

export function SettingsView(): React.JSX.Element {
  /** The saved key's last four characters; null when none is saved, undefined while loading. */
  const [hint, setHint] = useState<string | null>()
  const [key, setKey] = useState('')
  const [error, setError] = useState<string>()

  useEffect(() => {
    window.api.exa.keyHint().then(setHint)
  }, [])

  async function save(value: string | null): Promise<void> {
    setError(undefined)
    try {
      setHint(await window.api.exa.setKey(value))
      setKey('')
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : String(e)
      )
    }
  }

  return (
    <div className="settings">
      <h2>Settings</h2>
      <section className="settings-card">
        <h3>Web search</h3>
        <p>
          OpenCode API, Cline API and Command Code API chats search the web with Exa, as opencode
          does. Searches work without a key on Exa&apos;s free, rate-limited tier. With a key from{' '}
          <code>dashboard.exa.ai</code>, they use your Exa account.
        </p>
        <form
          className="settings-row"
          onSubmit={(e) => {
            e.preventDefault()
            if (key.trim()) save(key)
          }}
        >
          <input
            type="password"
            aria-label="Exa API key"
            placeholder={hint ? `Saved key ending in ${hint}` : 'Exa API key'}
            value={key}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setKey(e.target.value)}
          />
          <button type="submit" className="btn primary" disabled={!key.trim()}>
            {hint ? 'Replace' : 'Save'}
          </button>
          {hint && (
            <button type="button" className="btn" onClick={() => save(null)}>
              Remove
            </button>
          )}
        </form>
        {error && <div className="msg-error">{error}</div>}
      </section>
    </div>
  )
}
