import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The Exa API key the web search tool sends, where opencode reads EXA_API_KEY.
 * Optional: without one, Exa serves searches on its free, rate-limited tier.
 * Kept in its own file, readable only by the user (as opencode keeps its
 * auth.json), and never sent to the window, which only sees its last characters.
 */

const keyPath = join(app.getPath('userData'), 'data', 'exa.json')

let key = load()

function load(): string | undefined {
  if (!existsSync(keyPath)) return undefined
  try {
    const { apiKey } = JSON.parse(readFileSync(keyPath, 'utf8')) as { apiKey?: unknown }
    return typeof apiKey === 'string' && apiKey ? apiKey : undefined
  } catch (error) {
    console.error(`${keyPath} could not be read:`, (error as Error).message)
    return undefined
  }
}

export function exaKey(): string | undefined {
  return key
}

/** The saved key's last four characters, for telling keys apart; null when none is saved. */
export function exaKeyHint(): string | null {
  return key ? key.slice(-4) : null
}

/** Save a key, or remove the saved one (null). Returns the new hint. */
export function setExaKey(value: string | null): string | null {
  const trimmed = value?.trim()
  if (value !== null && !trimmed) throw new Error('Enter an Exa API key.')
  if (trimmed) {
    mkdirSync(dirname(keyPath), { recursive: true })
    writeFileSync(keyPath, JSON.stringify({ apiKey: trimmed }), { mode: 0o600 })
  } else {
    rmSync(keyPath, { force: true })
  }
  key = trimmed
  return exaKeyHint()
}
