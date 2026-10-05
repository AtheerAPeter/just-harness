import { app } from 'electron'
import { join } from 'node:path'
import { readFile, rename, writeFile } from 'node:fs/promises'

/**
 * A model list fetched from a provider and saved on disk: shown at once (even
 * offline), refreshed in the background once it is old, and waited for only
 * when there is none yet.
 */

const MAX_AGE_MS = 10 * 60_000
const ATTEMPTS = 3

interface Saved<T> {
  value: T
  fetchedAt: number
}

export function savedCatalog<T>(name: string, fetch: () => Promise<T>): () => Promise<T> {
  const file = join(app.getPath('userData'), `${name}-models.json`)
  let saved: Saved<T> | undefined
  let fetching: Promise<Saved<T>> | undefined

  const refresh = (): Promise<Saved<T>> => {
    fetching ??= fetchWithRetries(fetch)
      .then(async (value) => {
        saved = { value, fetchedAt: Date.now() }
        const tmp = `${file}.tmp`
        await writeFile(tmp, JSON.stringify(saved))
        await rename(tmp, file)
        return saved
      })
      .finally(() => (fetching = undefined))
    return fetching
  }

  return async () => {
    saved ??= await readJson<Saved<T>>(file)
    if (!saved) return (await refresh()).value
    if (Date.now() - saved.fetchedAt > MAX_AGE_MS) {
      refresh().catch((error) => console.error(`[harness] ${name} model list:`, error))
    }
    return saved.value
  }
}

async function fetchWithRetries<T>(fetch: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
    try {
      return await fetch()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/** GET a JSON document, failing on a non-2xx answer or after 10 seconds. */
export async function getJson<T>(url: string, what: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`Could not load ${what}: it answered ${response.status}.`)
  return (await response.json()) as T
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}
