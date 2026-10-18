import { app, net } from 'electron'
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Updates from the project's GitHub releases. Electron's autoUpdater needs an
 * app signed with a Developer ID, and this one is signed ad hoc, so the app
 * runs install.sh instead: the script users install it with, shipped in its
 * resources. The script quits the app, replaces it and opens the new one.
 */

const REPO = 'AtheerAPeter/just-harness'
const CHECK_EVERY = 6 * 60 * 60 * 1000

/** The newer release's version, once one is found. */
let latest: string | null = null
/** Told of each newer version found, by the timer or by the user's check. */
let notify: (version: string) => void = () => undefined

export function availableUpdate(): string | null {
  return latest
}

/** Check now and every few hours; `onFound` gets each newer version found. Packaged builds only. */
export function watchForUpdates(onFound: (version: string) => void): void {
  notify = onFound
  if (!app.isPackaged) return
  const check = (): void => {
    checkForUpdates().catch((error) => console.error('Could not check for updates:', error.message))
  }
  check()
  setInterval(check, CHECK_EVERY)
}

/** Check now: the newer release's version, or null when this app is the latest. */
export async function checkForUpdates(): Promise<string | null> {
  const version = await newerRelease()
  if (version && version !== latest) {
    latest = version
    notify(version)
  }
  return version
}

/** The latest release's version when it is newer than this app; null otherwise. */
async function newerRelease(): Promise<string | null> {
  const response = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' }
  })
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
  const release = (await response.json()) as { tag_name?: unknown; assets?: { name?: unknown }[] }
  // install.sh installs the release's .dmg, so a release without one is no update.
  const hasDmg = release.assets?.some((a) => typeof a.name === 'string' && a.name.endsWith('.dmg'))
  if (typeof release.tag_name !== 'string' || !hasDmg) return null
  const version = release.tag_name.replace(/^v/, '')
  return isNewer(version, app.getVersion()) ? version : null
}

/** Whether version a (as 1.0.53) comes after b. */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

let installing: Promise<void> | undefined

/**
 * Run install.sh, which quits the app on its way. Settles only if the script
 * ends while the app still runs: rejected with the script's reason when it failed.
 */
export function installUpdate(): Promise<void> {
  installing ??= runInstaller().finally(() => (installing = undefined))
  return installing
}

async function runInstaller(): Promise<void> {
  const log = join(app.getPath('userData'), 'update.log')
  const fd = openSync(log, 'w', 0o600)
  // Its own process group, so it lives on when the app quits for it. Its output
  // goes to a file: a pipe would close with the app, and the script's next
  // write would end it before it opens the new version.
  const child = spawn('/bin/bash', [join(process.resourcesPath, 'install.sh')], {
    detached: true,
    stdio: ['ignore', fd, fd]
  })
  closeSync(fd)
  child.unref()
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (code !== 0) throw new Error(failure(await readFile(log, 'utf8')))
}

/** The script's own message for what went wrong (its "✗" line), else its last line. */
function failure(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const own = lines.find((line) => line.startsWith('✗ '))
  return own?.slice(2) ?? lines.at(-1) ?? 'The update failed.'
}
