import { app } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { commandVersion } from '../shell-env'
import { getJson, readJson, savedCatalog } from './catalog'
import { opencodeMcpServers, opencodeV2McpServers } from './mcp-config'
import type { Provider, Source } from './provider'
import type { Model } from './wire'

/**
 * OpenCode Zen and OpenCode Go (https://opencode.ai/docs/zen, /docs/go), with
 * the keys `opencode auth login` saves. Their /models lists only ids, so each
 * model's route and limits come from models.dev, which opencode reads too:
 * models marked @ai-sdk/anthropic answer on /v1/messages, those without a
 * package on /v1/chat/completions. Models only on /v1/responses or Google's
 * format are left out: the harness does not speak those. So are the free
 * models, which OpenCode serves only to its own app.
 */

const PLANS = [
  { id: 'opencode', name: 'Zen', base: 'https://opencode.ai/zen', env: 'OPENCODE_API_KEY' },
  { id: 'opencode-go', name: 'Go', base: 'https://opencode.ai/zen/go', env: 'OPENCODE_API_KEY' }
] as const
type PlanId = (typeof PLANS)[number]['id']

const SIGN_IN = 'Run `opencode auth login` in a terminal, then send your message again.'

/** opencode's data folder, where it saves keys, and state folder, where it keeps the models used last. */
const DATA_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode')
const STATE_DIR = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'opencode')

/**
 * The installed opencode's major version, which decides where its keys are,
 * how its config is read, and how the app gives it its MCP servers (agents.ts).
 * Read once per run, as the app reads each CLI's version.
 */
let installedMajor: Promise<number | undefined> | undefined

export async function opencodeMajor(): Promise<number | undefined> {
  installedMajor ??= commandVersion('opencode').then((version) => {
    const major = version?.match(/(\d+)\.\d+\.\d+/)?.[1]
    return major ? Number(major) : undefined
  })
  return installedMajor
}

/** The key opencode uses for a plan: the one `opencode auth login` saved, else the environment's (models.dev's name). */
async function planKey(plan: PlanId): Promise<string | undefined> {
  const saved =
    ((await opencodeMajor()) ?? 1) >= 2 ? await savedKeyV2(plan) : await savedKeyV1(plan)
  return saved || process.env[PLANS.find((p) => p.id === plan)!.env]
}

/** opencode 1 saves keys in auth.json. */
async function savedKeyV1(plan: PlanId): Promise<string | undefined> {
  const auth = await readJson<Record<string, { type?: string; key?: string }>>(
    join(DATA_DIR, 'auth.json')
  )
  const entry = auth?.[plan]
  return entry?.type === 'api' && entry.key ? entry.key : undefined
}

/**
 * opencode 2 saves keys in its database's credential table (it imports
 * auth.json once, the first time it runs). Of a plan's saved sign-ins it uses
 * the active one, else the newest, as its Credential.list().at(-1). A Console
 * account sign-in is not a key, and the app does not use it.
 */
async function savedKeyV2(plan: PlanId): Promise<string | undefined> {
  // As opencode's databasePath: OPENCODE_DB names another file, relative to the data folder.
  const name = process.env.OPENCODE_DB || 'opencode.db'
  if (name === ':memory:') return undefined
  const file = resolve(DATA_DIR, name)
  if (!existsSync(file)) return undefined
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true, timeout: 2000 })
  try {
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'credential'")
      .get()
    if (!table) return undefined
    const row = db
      .prepare(
        'SELECT value FROM credential WHERE integration_id = ? ORDER BY active DESC, time_created DESC, id DESC LIMIT 1'
      )
      .get(plan) as { value?: string } | undefined
    const value = row?.value
      ? (JSON.parse(row.value) as { type?: string; key?: string })
      : undefined
    return value?.type === 'key' && value.key ? value.key : undefined
  } finally {
    db.close()
  }
}

interface DevModel {
  id: string
  name?: string
  cost?: { input?: number; output?: number }
  limit?: { output?: number }
  modalities?: { input?: string[] }
  provider?: { npm?: string }
}

type Listed = Record<PlanId, { models: Model[]; free: string[] }>

const catalog = savedCatalog('opencode', async (): Promise<Listed> => {
  const dev = await getJson<Record<string, { models?: Record<string, DevModel> }>>(
    'https://models.dev/api.json',
    'the models.dev catalog'
  )
  const entries = await Promise.all(
    PLANS.map(async (plan) => {
      // Only what the plan serves today; models.dev can list models it has dropped.
      const live = await getJson<{ data?: { id: string }[] }>(
        `${plan.base}/v1/models`,
        `OpenCode ${plan.name}'s models`
      )
      const served = new Set((live.data ?? []).map((m) => m.id))
      const models = Object.values(dev[plan.id]?.models ?? {}).filter((m) => served.has(m.id))
      return [
        plan.id,
        {
          models: models.flatMap((m): Model[] => {
            const npm = m.provider?.npm
            const api = npm === '@ai-sdk/anthropic' ? 'messages' : npm ? undefined : 'chat'
            if (!api) return []
            return [
              {
                id: m.id,
                name: m.name || m.id,
                api,
                vision: m.modalities?.input?.includes('image') ?? false,
                maxOutput: m.limit?.output || undefined
              }
            ]
          }),
          free: models.filter((m) => !m.cost?.input && !m.cost?.output).map((m) => m.id)
        }
      ] as const
    })
  )
  return Object.fromEntries(entries) as Listed
})

export const openCode: Provider = {
  id: 'opencode-api',
  name: 'OpenCode',
  signIn: SIGN_IN,
  signedIn: async () => (await Promise.all(PLANS.map((p) => planKey(p.id)))).some(Boolean),
  async sources() {
    const listed = await catalog()
    const sources: Source[] = []
    for (const plan of PLANS) {
      if (!(await planKey(plan.id))) continue
      const { models, free } = listed[plan.id] ?? { models: [], free: [] }
      // The free models answer only OpenCode itself ("can only be used from within OpenCode").
      sources.push({
        id: plan.id,
        name: plan.name,
        models: models.filter((m) => !free.includes(m.id))
      })
    }
    return sources
  },
  async endpoint(source, chatId) {
    const plan = PLANS.find((p) => p.id === source) ?? PLANS[0]
    const key = await planKey(plan.id)
    if (!key) throw new Error(`OpenCode ${plan.name} is not signed in. ${SIGN_IN}`)
    return {
      name: `OpenCode ${plan.name}`,
      signIn: SIGN_IN,
      key,
      messagesURL: plan.base,
      // Required for Go, documented for third-party agents: their own user agent and a stable
      // session id per conversation (https://opencode.ai/docs/go/#where-can-i-use-it).
      headers: { 'User-Agent': `just-harness/${app.getVersion()}` },
      chatHeaders: { 'x-opencode-session': chatId },
      chatURL: `${plan.base}/v1`
    }
  },
  async preferred() {
    // opencode keeps the models used last, newest first.
    const state = await readJson<{ recent?: { providerID: string; modelID: string }[] }>(
      join(STATE_DIR, 'model.json')
    )
    const recent = state?.recent?.find((r) => PLANS.some((p) => p.id === r.providerID))
    return recent ? { source: recent.providerID, model: recent.modelID } : undefined
  },
  async mcpServers(cwd) {
    return ((await opencodeMajor()) ?? 1) >= 2 ? opencodeV2McpServers(cwd) : opencodeMcpServers(cwd)
  }
}
