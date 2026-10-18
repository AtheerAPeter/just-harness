import { useState } from 'react'
import { errorMessage } from './errors'

/**
 * Installing the newer release, for the sidebar's update button and Settings.
 * The installer quits the app and opens the new one, so `install` settles only
 * when that fails.
 */
export function useUpdateInstall(): {
  installing: boolean
  error?: string
  install: () => Promise<void>
} {
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string>()

  async function install(): Promise<void> {
    setInstalling(true)
    setError(undefined)
    try {
      await window.api.update.install()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setInstalling(false)
    }
  }

  return { installing, error, install }
}
