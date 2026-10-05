import { homedir } from 'node:os'
import { join } from 'node:path'
import { getJson, readJson, savedCatalog } from './catalog'
import type { Provider } from './provider'
import type { Model } from './wire'

/**
 * Command Code's Provider API (https://commandcode.ai/docs/provider): every
 * model behind one key. Each model answers on one route, listed by /models:
 * Claude on /v1/messages, the rest on /v1/chat/completions.
 */

const BASE_URL = 'https://api.commandcode.ai/provider'
const SIGN_IN = 'Run `cmd login` in a terminal (or set CMD_API_KEY), then send your message again.'

/** The key `cmd login` saves, or CMD_API_KEY; read for every request, so signing in again needs no restart. */
async function apiKey(): Promise<string | undefined> {
  const env = process.env.CMD_API_KEY || process.env.COMMAND_CODE_API_KEY
  if (env) return env
  const auth = await readJson<{ apiKey?: string }>(join(homedir(), '.commandcode', 'auth.json'))
  return auth?.apiKey || undefined
}

interface ListedModel {
  id: string
  name?: string
  supported_endpoints?: string[]
  modalities?: { input?: string[] }
}

const catalog = savedCatalog('commandcode', async () => {
  const body = await getJson<{ data?: ListedModel[] }>(
    `${BASE_URL}/v1/models`,
    "Command Code's models"
  )
  if (!Array.isArray(body.data)) throw new Error('Command Code sent no model list.')
  return body.data.flatMap((item): Model[] => {
    const endpoints = item.supported_endpoints ?? []
    const api = endpoints.includes('/messages')
      ? 'messages'
      : endpoints.includes('/chat/completions')
        ? 'chat'
        : undefined
    if (!api) return []
    // Image input as the catalog reports it, else by family (it does not report it yet).
    const vision = item.modalities?.input
      ? item.modalities.input.includes('image')
      : /^(claude-|gpt-|google\/)/.test(item.id)
    return [{ id: item.id, name: item.name || item.id, api, vision }]
  })
})

export const commandCode: Provider = {
  id: 'commandcode-api',
  name: 'Command Code',
  signIn: SIGN_IN,
  signedIn: async () => Boolean(await apiKey()),
  sources: async () => [{ id: 'commandcode', name: 'Command Code', models: await catalog() }],
  async endpoint() {
    const key = await apiKey()
    if (!key) throw new Error(`Command Code is not signed in. ${SIGN_IN}`)
    return {
      name: 'Command Code',
      signIn: SIGN_IN,
      key,
      messagesURL: BASE_URL,
      chatURL: `${BASE_URL}/v1`
    }
  },
  async preferred() {
    const config = await readJson<{ model?: string }>(
      join(homedir(), '.commandcode', 'config.json')
    )
    return config?.model ? { model: config.model } : undefined
  }
}
