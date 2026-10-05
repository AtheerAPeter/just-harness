import { app } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getJson, readJson, savedCatalog } from './catalog'
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
  { id: 'opencode-go', name: 'Go', base: 'https://opencode.ai/zen/go', env: undefined }
] as const
type PlanId = (typeof PLANS)[number]['id']

const SIGN_IN = 'Run `opencode auth login` in a terminal, then send your message again.'

async function planKey(plan: PlanId): Promise<string | undefined> {
  const env = PLANS.find((p) => p.id === plan)?.env
  if (env && process.env[env]) return process.env[env]
  const auth = await readJson<Record<string, { type?: string; key?: string }>>(
    join(homedir(), '.local', 'share', 'opencode', 'auth.json')
  )
  const entry = auth?.[plan]
  return entry?.type === 'api' && entry.key ? entry.key : undefined
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
      join(homedir(), '.local', 'state', 'opencode', 'model.json')
    )
    const recent = state?.recent?.find((r) => PLANS.some((p) => p.id === r.providerID))
    return recent ? { source: recent.providerID, model: recent.modelID } : undefined
  }
}
