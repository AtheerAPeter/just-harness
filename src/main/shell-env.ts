import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'

const MARKER = '__JUST_HARNESS_PATH__'

let loading: Promise<void> | undefined

/**
 * Apps launched from Finder/Dock inherit launchd's minimal PATH, so CLIs installed
 * via Homebrew, npm or curl scripts are not found. Read PATH from the user's
 * interactive login shell instead, the same way terminals see it.
 *
 * Read once, starting at launch without holding up the window. Await it before
 * running a command found on PATH.
 */
export function loadShellPath(): Promise<void> {
  loading ??= readShellPath()
  return loading
}

function readShellPath(): Promise<void> {
  const shell = process.env.SHELL || userInfo().shell || '/bin/zsh'
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '${MARKER}%s${MARKER}' "$PATH"`],
      { timeout: 10_000, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } },
      (error, stdout) => {
        const match = stdout?.match(new RegExp(`${MARKER}(.*)${MARKER}`))
        if (match?.[1]) process.env.PATH = match[1]
        else if (error) console.error('Could not read PATH from login shell:', error.message)
        resolve()
      }
    )
  })
}
