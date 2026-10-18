import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  PROVIDER_PRESETS,
  type CustomProvider,
  type CustomProviderCheck,
  type CustomProviderInput,
  type ProviderApi
} from '../../shared/types'
import { catalogFile, modelInfoLookup, savedCatalog } from './catalog'
import type { Provider, Source } from './provider'
import { listModels, type Endpoint, type Model } from './wire'

/**
 * The providers the user adds in Settings: any API that speaks OpenAI Chat
 * Completions, OpenAI Responses or Anthropic Messages, at an address with a
 * key (or none, for a local server). Each is a source of the custom-api agent,
 * with the models it lists on /models, or the ones the user named.
 *
 * Kept in one file readable only by the user, keys included, as the Exa key
 * is (exa-key.ts). The window sees each key's last four characters only.
 */

interface Stored extends Omit<CustomProvider, 'keyHint'> {
  apiKey?: string
}

const file = join(app.getPath('userData'), 'data', 'providers.json')

const SIGN_IN = 'Add a provider in Settings (⌘,), then send your message again.'

let providers = load()

function load(): Stored[] {
  if (!existsSync(file)) return []
  try {
    const { providers } = JSON.parse(readFileSync(file, 'utf8')) as { providers?: unknown }
    return Array.isArray(providers) ? (providers as Stored[]) : []
  } catch (error) {
    console.error(`${file} could not be read:`, (error as Error).message)
    return []
  }
}

function save(next: Stored[]): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ providers: next }, null, 2), { mode: 0o600 })
  providers = next
}

const shown = ({ apiKey, ...provider }: Stored): CustomProvider => ({
  ...provider,
  keyHint: apiKey ? apiKey.slice(-4) : null
})

export function customProviders(): CustomProvider[] {
  return providers.map(shown)
}

const APIS: ProviderApi[] = ['chat', 'responses', 'messages']
/** A header name as HTTP allows it (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** Add a provider, or change one; returns it as the window sees it. */
export function saveCustomProvider(input: CustomProviderInput): CustomProvider {
  const name = input.name.trim()
  if (!name) throw new Error('Enter a name for the provider.')
  if (!APIS.includes(input.api)) throw new Error(`Unknown API "${input.api}".`)
  const baseURL = input.baseURL.trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    throw new Error('Enter the base URL, such as https://api.openai.com/v1.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The base URL must start with https:// or http://.')
  }
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.headers)) {
    const header = key.trim()
    if (!HEADER_NAME.test(header)) throw new Error(`"${header}" is not a valid header name.`)
    headers[header] = value.trim()
  }
  const models = [...new Set(input.models.map((m) => m.trim()).filter(Boolean))]

  const existing = input.id ? providers.find((p) => p.id === input.id) : undefined
  if (input.id && !existing) throw new Error('That provider was removed.')
  if (providers.some((p) => p.id !== input.id && p.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`A provider named ${name} is already added.`)
  }
  const apiKey = input.apiKey === undefined ? existing?.apiKey : input.apiKey?.trim() || undefined
  const provider: Stored = {
    id: existing?.id ?? crypto.randomUUID(),
    name,
    api: input.api,
    baseURL,
    headers,
    models,
    ...(apiKey ? { apiKey } : {})
  }
  save(
    existing
      ? providers.map((p) => (p.id === provider.id ? provider : p))
      : [...providers, provider]
  )
  return shown(provider)
}

export function removeCustomProvider(id: string): void {
  save(providers.filter((p) => p.id !== id))
  catalogs.delete(id)
  failures.delete(id)
  rmSync(catalogFile(catalogName(id)), { force: true })
}

/** Whether the provider answers now, and with how many models. */
export async function checkCustomProvider(id: string): Promise<CustomProviderCheck> {
  const provider = providers.find((p) => p.id === id)
  if (!provider) return { error: 'That provider was removed.' }
  try {
    const models = await modelsOf(provider, true)
    failures.delete(id)
    return { models: models.length }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

// --- Models -----------------------------------------------------------------

function endpointOf(provider: Stored): Endpoint {
  return {
    name: provider.name,
    signIn: `Check ${provider.name}'s key in Settings (⌘,), then send your message again.`,
    key: provider.apiKey,
    // The Anthropic SDK appends /v1/messages itself.
    messagesURL: provider.api === 'messages' ? provider.baseURL.replace(/\/v1$/, '') : undefined,
    chatURL: provider.baseURL,
    headers: provider.headers,
    // Token counts, for compaction, come on this route only when asked for.
    streamUsage: provider.api === 'chat'
  }
}

/** The models.dev provider at the same address as the provider (see PROVIDER_PRESETS). */
function catalogOf(provider: Stored): string | undefined {
  const host = new URL(provider.baseURL).host
  return PROVIDER_PRESETS.find((preset) => new URL(preset.baseURL).host === host)?.catalog
}

const catalogName = (id: string): string => `custom-${id}`

/**
 * Each provider's list, saved on disk like the plans' lists. It is fetched
 * again when the provider changes: the address, key, headers or named models.
 * Only a hash of them is saved with the list, never the key.
 */
const catalogs = new Map<string, { key: string; list: (fresh?: boolean) => Promise<Model[]> }>()

function modelsOf(provider: Stored, fresh = false): Promise<Model[]> {
  const { apiKey, api, baseURL, headers, models } = provider
  const key = createHash('sha256')
    .update(JSON.stringify([apiKey, api, baseURL, headers, models]))
    .digest('hex')
  let catalog = catalogs.get(provider.id)
  if (catalog?.key !== key) {
    catalog = {
      key,
      list: savedCatalog(
        catalogName(provider.id),
        async (): Promise<Model[]> => {
          const listed =
            models.length > 0
              ? models.map((id) => ({ id, name: id }))
              : await listModels(endpointOf(provider), api)
          const info = await modelInfoLookup(catalogOf(provider))
          return listed
            .map(({ id, name }) => {
              const { vision, maxOutput } = info(id)
              return { id, name, api, vision: vision ?? false, maxOutput }
            })
            .sort((a, b) => a.name.localeCompare(b.name))
        },
        key
      )
    }
    catalogs.set(provider.id, catalog)
  }
  return catalog.list(fresh)
}

/**
 * A provider whose list could not be fetched is not asked again for a
 * minute: every request lists all providers, and one that is down (a local
 * server not running) would otherwise hold up chats on the others.
 */
const FAILURE_KEPT_MS = 60_000
const failures = new Map<string, { at: number; key: string; message: string }>()

async function sourceOf(provider: Stored): Promise<Source> {
  const failed = failures.get(provider.id)
  const key = catalogs.get(provider.id)?.key
  if (failed && failed.key === key && Date.now() - failed.at < FAILURE_KEPT_MS) {
    return { id: provider.id, name: provider.name, models: [], error: failed.message }
  }
  try {
    const models = await modelsOf(provider)
    failures.delete(provider.id)
    return { id: provider.id, name: provider.name, models }
  } catch (error) {
    const message = (error as Error).message
    console.error(`[harness] ${provider.name} model list:`, message)
    failures.set(provider.id, { at: Date.now(), key: catalogs.get(provider.id)!.key, message })
    return { id: provider.id, name: provider.name, models: [], error: message }
  }
}

export const custom: Provider = {
  id: 'custom-api',
  name: 'Custom providers',
  signIn: SIGN_IN,
  notReady: `No provider is added yet. ${SIGN_IN}`,
  sourceLabel: 'Provider',
  alwaysNameSources: true,
  signedIn: async () => providers.length > 0,
  sources: () => Promise.all(providers.map(sourceOf)),
  async endpoint(source) {
    const provider = providers.find((p) => p.id === source)
    if (!provider) throw new Error(`This chat's provider was removed. ${SIGN_IN}`)
    return endpointOf(provider)
  },
  // A new chat starts on the model last picked, which the window remembers.
  preferred: async () => undefined,
  // MCP servers are set up in each CLI; these providers have none of their own.
  mcpServers: async () => []
}
