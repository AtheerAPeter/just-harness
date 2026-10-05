import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { chmod, rename, writeFile } from 'node:fs/promises'
import { getJson, readJson, savedCatalog } from './catalog'
import type { Provider } from './provider'
import type { Model } from './wire'

/**
 * The Cline API (https://docs.cline.bot/api/overview): OpenAI Chat Completions
 * at api.cline.bot, for usage billing and ClinePass. It signs in with the
 * Cline CLI's own login (`cline auth`), or CLINE_API_KEY.
 */

const API = 'https://api.cline.bot/api/v1'
const SIGN_IN =
  'Run `cline auth` in a terminal (or set CLINE_API_KEY), then send your message again.'

// --- Sign-in ----------------------------------------------------------------

/**
 * The CLI keeps an OAuth access token in providers.json and refreshes it shortly
 * before it expires. The harness shares that login and refreshes it the same way
 * the CLI does (@cline/core: vx, Qm, _T, A0), so both keep working: under the
 * CLI's lock, re-read the file, refresh only if still due, write the new tokens
 * back. Refresh tokens may rotate, so none is ever kept outside the file.
 */
const PROVIDERS_FILE = join(homedir(), '.cline', 'data', 'settings', 'providers.json')
/** The CLI's lock: a SQLite file named after the storage provider ("cline"). */
const LOCK_FILE = `${PROVIDERS_FILE}.oauth-${createHash('sha256').update('cline').digest('hex')}.lock`
/** Refreshed this long before it expires, as the CLI does. */
const REFRESH_BEFORE_MS = 5 * 60_000
const LOCK_TIMEOUT_MS = 60_000
const TOKEN_PREFIX = 'workos:'

interface ClineAuth {
  accessToken?: string
  refreshToken?: string
  accountId?: string
  expiresAt?: number
  metadata?: Record<string, unknown>
}

interface ProvidersFile {
  lastUsedProvider?: string
  providers?: Record<
    string,
    { settings?: { auth?: ClineAuth; model?: string }; updatedAt?: string; tokenSource?: string }
  >
}

const readProviders = (): Promise<ProvidersFile | undefined> =>
  readJson<ProvidersFile>(PROVIDERS_FILE)

let refreshing: Promise<string> | undefined

async function clineToken(): Promise<string | undefined> {
  if (process.env.CLINE_API_KEY) return process.env.CLINE_API_KEY
  const auth = (await readProviders())?.providers?.cline?.settings?.auth
  if (!auth?.accessToken) return undefined
  if (!due(auth)) return auth.accessToken
  refreshing ??= withCliLock(refreshUnderLock).finally(() => (refreshing = undefined))
  return refreshing
}

const due = (auth: ClineAuth): boolean =>
  !auth.expiresAt || auth.expiresAt - Date.now() < REFRESH_BEFORE_MS

async function refreshUnderLock(): Promise<string> {
  // The CLI may have refreshed while this waited for the lock.
  const file = await readProviders()
  const entry = file?.providers?.cline
  const auth = entry?.settings?.auth
  if (!file || !entry?.settings || !auth?.accessToken)
    throw new Error(`Cline is not signed in. ${SIGN_IN}`)
  if (!due(auth)) return auth.accessToken
  if (!auth.refreshToken) throw new Error(`Cline's sign-in has expired. ${SIGN_IN}`)

  const response = await fetch(`${API}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: auth.refreshToken, grantType: 'refresh_token' }),
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) {
    throw new Error(
      response.status === 400 || response.status === 401
        ? `Cline's sign-in has expired. ${SIGN_IN}`
        : `Cline could not renew its sign-in: it answered ${response.status}.`
    )
  }
  const body = (await response.json()) as {
    success?: boolean
    data?: {
      accessToken?: string
      refreshToken?: string
      expiresAt?: string
      tokenType?: string
      userInfo?: { clineUserId?: string } & Record<string, unknown>
    }
  }
  const data = body.data
  const expiresAt = data?.expiresAt ? Date.parse(data.expiresAt) : NaN
  if (!body.success || !data?.accessToken || Number.isNaN(expiresAt)) {
    throw new Error('Cline sent an invalid sign-in renewal.')
  }

  // Saved as the CLI saves it (A0, saveProviderSettings).
  const accessToken = data.accessToken.trim().toLowerCase().startsWith(TOKEN_PREFIX)
    ? data.accessToken.trim()
    : `${TOKEN_PREFIX}${data.accessToken.trim()}`
  const metadata: Record<string, unknown> = {
    ...auth.metadata,
    provider: 'cline',
    tokenType: data.tokenType,
    userInfo: data.userInfo
  }
  delete metadata.startedAt
  entry.settings.auth = {
    ...auth,
    accessToken,
    refreshToken: data.refreshToken ?? auth.refreshToken,
    accountId: data.userInfo?.clineUserId ?? auth.accountId,
    expiresAt,
    metadata
  }
  entry.updatedAt = new Date().toISOString()
  entry.tokenSource = 'oauth'
  const tmp = `${PROVIDERS_FILE}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, PROVIDERS_FILE)
  await chmod(PROVIDERS_FILE, 0o600)
  return accessToken
}

/** Run under the CLI's refresh lock: an exclusive SQLite transaction on its lock file. */
async function withCliLock<T>(work: () => Promise<T>): Promise<T> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(LOCK_FILE)
  let locked = false
  try {
    db.exec('PRAGMA busy_timeout = 0;')
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    while (!locked) {
      try {
        db.exec('BEGIN EXCLUSIVE;')
        locked = true
      } catch (error) {
        if (!/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(String(error))) throw error
        if (Date.now() >= deadline)
          throw new Error('Timed out waiting for Cline to renew its sign-in.')
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    return await work()
  } finally {
    try {
      if (locked) db.exec('ROLLBACK;')
    } finally {
      db.close()
    }
  }
}

// --- Models -----------------------------------------------------------------

interface Listed {
  clinePass: Model[]
  all: Model[]
}

/** Image input by family: the lists do not say. */
const toModel = (id: string, name?: string): Model => ({
  id,
  name: name || id,
  api: 'chat',
  vision: /(claude|gpt-|gemini)/.test(id)
})

const catalog = savedCatalog('cline', async (): Promise<Listed> => {
  const [picked, all] = await Promise.all([
    getJson<Record<string, { id: string; name?: string }[]>>(
      `${API}/ai/cline/recommended-models`,
      "Cline's models"
    ),
    getJson<{ data?: { id: string }[] }>(`${API}/models`, "Cline's models")
  ])
  return {
    clinePass: (picked.clinePass ?? []).map((m) => toModel(m.id, m.name)),
    // The free models answer only Cline's own apps ("only available via Cline product surfaces").
    all: (all.data ?? []).filter((m) => !m.id.startsWith('cline-free/')).map((m) => toModel(m.id))
  }
})

/** Anthropic models are cached only where requests mark it. */
const isAnthropic = (model: string): boolean => /^anthropic\/|claude/.test(model)

export const cline: Provider = {
  id: 'cline-api',
  name: 'Cline',
  signIn: SIGN_IN,
  signedIn: async () =>
    Boolean(
      process.env.CLINE_API_KEY ||
      (await readProviders())?.providers?.cline?.settings?.auth?.accessToken
    ),
  async sources() {
    const listed = await catalog()
    return [
      { id: 'cline-pass', name: 'ClinePass', models: listed.clinePass },
      { id: 'cline', name: 'Usage billing', models: listed.all }
    ]
  },
  async endpoint() {
    const key = await clineToken()
    if (!key) throw new Error(`Cline is not signed in. ${SIGN_IN}`)
    return {
      name: 'Cline',
      signIn: SIGN_IN,
      key,
      chatURL: API,
      headers: { 'HTTP-Referer': 'https://cline.bot', 'X-Title': 'Just Harness' },
      reasoning: 'reasoning',
      cacheControl: isAnthropic,
      streamUsage: true
    }
  },
  async preferred() {
    const file = await readProviders()
    const used = file?.lastUsedProvider
    const model = used ? file?.providers?.[used]?.settings?.model : undefined
    if (!model) return undefined
    return { source: used === 'cline-pass' ? 'cline-pass' : 'cline', model }
  }
}
