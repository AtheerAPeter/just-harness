import { useEffect, useState } from 'react'
import { MoonIcon, SunIcon } from './icons'

/** Flips between light and dark. View → Appearance also offers "System". */
export function ThemeToggle(): React.JSX.Element {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)

  // Follows the effective appearance (the app setting, or macOS when set to System).
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setDark(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return (
    <button
      className="icon-btn"
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => window.api.setTheme(dark ? 'light' : 'dark')}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}
