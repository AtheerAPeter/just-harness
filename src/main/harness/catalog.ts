import { app } from 'electron'
import { join } from 'node:path'
import { readFile, rename, writeFile } from 'node:fs/promises'

/**
 * A model list fetched from a provider and saved on disk: shown at once (even
 * offline), refreshed in the background once it is old, and waited for only
 * when there is none yet.
 */

const MAX_AGE_MS = 10 * 60_000
/** Raised when what is saved changes shape; a file in another shape is fetched again. */
const FORMAT = 3
const ATTEMPTS = 3

interface Saved<T> {
  format: number
  /** What the list was fetched for (see savedCatalog). */
  key?: string
  value: T
  fetchedAt: number
}

/** Where a saved model list is kept. */
export const catalogFile = (name: string): string =>
  join(app.getPath('userData'), `${name}-models.json`)

/**
 * `key` names what the list is fetched for, such as a provider's address and
 * key: a list saved for another is fetched again. Called with `fresh`, the
 * list is fetched now, whatever is saved.
 */
export function savedCatalog<T>(
  name: string,
  fetch: () => Promise<T>,
  key?: string
): (fresh?: boolean) => Promise<T> {
  const file = catalogFile(name)
  let saved: Saved<T> | undefined
  let fetching: Promise<Saved<T>> | undefined

  const refresh = (): Promise<Saved<T>> => {
    fetching ??= fetchWithRetries(fetch)
      .then(async (value) => {
        saved = { format: FORMAT, key, value, fetchedAt: Date.now() }
        const tmp = `${file}.tmp`
        await writeFile(tmp, JSON.stringify(saved))
        await rename(tmp, file)
        return saved
      })
      .finally(() => (fetching = undefined))
    return fetching
  }

  return async (fresh = false) => {
    if (fresh) return (await refresh()).value
    if (!saved) {
      const read = await readJson<Saved<T>>(file)
      if (read?.format === FORMAT && read.key === key) saved = read
    }
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

/** models.dev, the model catalog opencode reads too. */
export const MODELS_DEV_URL = 'https://models.dev/api.json'

interface DevModel {
  id: string
  modalities?: { input?: string[] }
  limit?: { output?: number }
}

/** What models.dev says about a model; a field is unset when it does not say. */
export interface ModelInfo {
  vision?: boolean
  maxOutput?: number
}

/**
 * Whether a model takes images, by models.dev, for providers whose lists do
 * not say (Command Code, Cline). Undefined when models.dev does not list it,
 * or cannot be reached.
 */
export async function imageInputLookup(): Promise<(id: string) => boolean | undefined> {
  const info = await modelInfoLookup()
  return (id) => info(id).vision
}

/**
 * A model's image input and output limit by models.dev. With `host`, a
 * models.dev provider id, as that host lists the model. Otherwise, and for
 * models the host does not list, image input as any host lists it: ids are a
 * maker's, as OpenRouter's are ("deepseek/deepseek-v4.1-flash"), or a plan's
 * ("cline-pass/deepseek-v4.1-flash"), looked up by the whole id first, then by
 * the model's own name. Output limits differ between hosts, so they come only
 * from the host's own list.
 */
export async function modelInfoLookup(host?: string): Promise<(id: string) => ModelInfo> {
  let dev: Record<string, { models?: Record<string, DevModel> }>
  try {
    dev = await getJson(MODELS_DEV_URL, 'the models.dev catalog')
  } catch (error) {
    console.error('[harness] models.dev:', error)
    return () => ({})
  }
  const hosted = new Map(Object.values(dev[host ?? '']?.models ?? {}).map((m) => [m.id, m]))
  const byId = new Map<string, boolean>()
  const byName = new Map<string, boolean>()
  // A model some host serves with image input takes images.
  const note = (map: Map<string, boolean>, key: string, image: boolean): void => {
    map.set(key, map.get(key) === true || image)
  }
  for (const provider of Object.values(dev)) {
    for (const model of Object.values(provider.models ?? {})) {
      const image = model.modalities?.input?.includes('image') ?? false
      note(byId, model.id, image)
      note(byName, nameOf(model.id), image)
    }
  }
  return (id) => {
    const own = hosted.get(id) ?? hosted.get(nameOf(id))
    if (own) {
      return {
        vision: own.modalities?.input?.includes('image') ?? false,
        maxOutput: own.limit?.output || undefined
      }
    }
    // "~maker/model" is a moving alias, "maker/model:batch" a variant of the model.
    const clean = id.replace(/^~/, '').replace(/:[^/]*$/, '')
    return { vision: byId.get(clean) ?? byName.get(nameOf(clean)) }
  }
}

const nameOf = (id: string): string => id.slice(id.lastIndexOf('/') + 1)
