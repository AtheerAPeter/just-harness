import { useEffect, useState } from 'react'
import { errorMessage } from '../lib/errors'
import { useUpdateInstall } from '../lib/update'

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
      setError(errorMessage(e))
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
      <UpdatesCard />
    </div>
  )
}

/** The app's version and a check for a newer release, which it can install from here. */
function UpdatesCard(): React.JSX.Element {
  const [version, setVersion] = useState<string>()
  /** The newer release found; null once a check finds none; undefined before any. */
  const [newer, setNewer] = useState<string | null>()
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string>()
  const update = useUpdateInstall()

  useEffect(() => {
    window.api.appVersion().then(setVersion)
    // The app checks on its own every few hours; a release it found shows at once.
    window.api.update.available().then((found) => found && setNewer(found))
    return window.api.update.onAvailable(setNewer)
  }, [])

  async function check(): Promise<void> {
    setChecking(true)
    setError(undefined)
    try {
      setNewer(await window.api.update.check())
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setChecking(false)
    }
  }

  return (
    <section className="settings-card">
      <h3>Updates</h3>
      <p>
        {newer
          ? `Version ${newer} is out. Updating quits Just Harness, installs it and opens it again.`
          : newer === null
            ? `Version ${version} is the latest.`
            : `This is version ${version ?? '…'}.`}
      </p>
      <div className="settings-row">
        {newer && (
          <button
            type="button"
            className="btn primary"
            disabled={update.installing}
            onClick={update.install}
          >
            {update.installing ? 'Updating…' : `Update to v${newer}`}
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={checking || update.installing}
          onClick={check}
        >
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
      {(error ?? update.error) && <div className="msg-error">{error ?? update.error}</div>}
    </section>
  )
}
