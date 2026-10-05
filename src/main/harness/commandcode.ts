import { app } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, rename, writeFile } from 'node:fs/promises'
import type Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'
import type {
  Api,
  AssistantTurn,
  Effort,
  Part,
  Reply,
  Request,
  Stop,
  StreamHandlers,
  ToolCall,
  Turn
} from './types'

/**
 * Command Code's Provider API (https://commandcode.ai/docs/provider): every
 * model it serves behind one key, called with the official Anthropic and
 * OpenAI SDKs. Each model answers on one route: Claude on /v1/messages, the
 * rest on /v1/chat/completions.
 */

/** The Anthropic SDK appends /v1/messages itself; the OpenAI SDK appends /chat/completions. */
const BASE_URL = 'https://api.commandcode.ai/provider'
const MODELS_URL = `${BASE_URL}/v1/models`

/** Retries for 429s ("upstream temporarily unavailable"), 5xx and dropped connections. */
const MAX_RETRIES = 4

/** Output limits. Thinking counts against them; streaming keeps long replies under the HTTP timeout. */
const CLAUDE_MAX_TOKENS = 64_000
const CHAT_MAX_TOKENS = 32_768

const NO_KEY =
  'Command Code is not signed in. Run `cmd login` in a terminal (or set CMD_API_KEY), then send your message again.'

/**
 * The key `cmd login` saves, or CMD_API_KEY. Read for every request, so signing
 * in again takes effect without restarting the app.
 */
export async function apiKey(): Promise<string | undefined> {
  const env = process.env.CMD_API_KEY || process.env.COMMAND_CODE_API_KEY
  if (env) return env
  const auth = await readJson<{ apiKey?: string }>(join(homedir(), '.commandcode', 'auth.json'))
  return auth?.apiKey || undefined
}

// ---------------------------------------------------------------------------
// Model catalog

/** One entry of GET /provider/v1/models. */
interface ListedModel {
  id: string
  name?: string
  supported_endpoints?: string[]
  modalities?: { input?: string[] }
}

export interface Model {
  id: string
  name: string
  api: Api
  vision: boolean
}

interface Catalog {
  models: ListedModel[]
  fetchedAt: number
}

/** The last catalog fetched, so the model list shows at once, even offline. */
const catalogFile = join(app.getPath('userData'), 'commandcode-models.json')
/** Older than this, the catalog is fetched again in the background while the saved one is used. */
const CATALOG_MAX_AGE_MS = 10 * 60_000
const CATALOG_TIMEOUT_MS = 10_000

let catalog: Catalog | undefined
let fetching: Promise<Catalog> | undefined

/**
 * The models Command Code serves now. Returns the saved list straight away and
 * refreshes it when it is old; waits for the network only when there is none.
 */
export async function listModels(): Promise<Model[]> {
  catalog ??= await readJson<Catalog>(catalogFile)
  if (!catalog) return toModels((await refreshCatalog()).models)
  if (Date.now() - catalog.fetchedAt > CATALOG_MAX_AGE_MS) {
    refreshCatalog().catch((error) => console.error('[commandcode-api] model list:', error))
  }
  return toModels(catalog.models)
}

function refreshCatalog(): Promise<Catalog> {
  fetching ??= fetchCatalog()
    .then(async (fetched) => {
      catalog = fetched
      const tmp = `${catalogFile}.tmp`
      await writeFile(tmp, JSON.stringify(fetched))
      await rename(tmp, catalogFile)
      return fetched
    })
    .finally(() => (fetching = undefined))
  return fetching
}

async function fetchCatalog(): Promise<Catalog> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
    try {
      const response = await fetch(MODELS_URL, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) })
      if (!response.ok) throw new Error(`it answered ${response.status}`)
      const body = (await response.json()) as { data?: ListedModel[] }
      if (!Array.isArray(body.data)) throw new Error('it sent no model list')
      return { models: body.data, fetchedAt: Date.now() }
    } catch (error) {
      lastError = error
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`Could not load Command Code's models: ${reason}.`)
}

/** Models with a route this harness speaks, in the order Command Code lists them. */
function toModels(listed: ListedModel[]): Model[] {
  return listed.flatMap((item) => {
    const endpoints = item.supported_endpoints ?? []
    const api: Api | undefined = endpoints.includes('/messages')
      ? 'messages'
      : endpoints.includes('/chat/completions')
        ? 'chat'
        : undefined
    if (!api) return []
    return [{ id: item.id, name: item.name || item.id, api, vision: hasVision(item) }]
  })
}

/** Image input: as the catalog reports it, else by family (the catalog does not report it yet). */
function hasVision(item: ListedModel): boolean {
  if (item.modalities?.input) return item.modalities.input.includes('image')
  return /^(claude-|gpt-|google\/)/.test(item.id)
}

/** A model by id. One gone from the catalog still works on the route its family uses. */
export async function findModel(id: string): Promise<Model> {
  const found = (await listModels()).find((m) => m.id === id)
  if (found) return found
  const claude = id.startsWith('claude-')
  return { id, name: id, api: claude ? 'messages' : 'chat', vision: hasVision({ id }) }
}

/** The model chosen in Command Code's CLI, when it is still served; else the first listed. */
export async function defaultModel(models: Model[]): Promise<string | undefined> {
  const config = await readJson<{ model?: string }>(join(homedir(), '.commandcode', 'config.json'))
  return models.find((m) => m.id === config?.model)?.id ?? models[0]?.id
}

/**
 * Claude models from Opus 4.6, Sonnet 4.6 and Fable 5 on take adaptive thinking
 * with an effort level (and reject a token budget). Others run without thinking.
 */
const ADAPTIVE_THINKING = /(opus[-.](4[-.][678]|5)|sonnet[-.](4[-.]6|5)|fable[-.]5|mythos[-.]5)/

/** The effort levels a model takes; the first entry of chat models means "the provider's default". */
export function effortLevels(model: Model): Effort[] {
  if (model.api === 'chat') return ['default', 'low', 'medium', 'high']
  if (!ADAPTIVE_THINKING.test(model.id)) return []
  // xhigh arrived with Opus 4.7.
  return /4[-.]6/.test(model.id)
    ? ['low', 'medium', 'high', 'max']
    : ['low', 'medium', 'high', 'xhigh', 'max']
}

export function defaultEffort(model: Model): Effort {
  return model.api === 'messages' ? 'high' : 'default'
}

// ---------------------------------------------------------------------------
// Requests

/** Stream one reply. Rejects with a readable error; an abort rejects as the SDK raises it. */
export async function streamReply(
  request: Request,
  on: StreamHandlers,
  signal: AbortSignal
): Promise<Reply> {
  const key = await apiKey()
  if (!key) throw new Error(NO_KEY)
  const model = await findModel(request.model)
  try {
    return model.api === 'messages'
      ? await streamMessages(key, request, on, signal)
      : await streamChat(key, model, request, on, signal)
  } catch (error) {
    throw signal.aborted ? error : readableError(error)
  }
}

/** The SDKs' errors carry the gateway's JSON body; show its message, not the raw JSON. */
function readableError(error: unknown): Error {
  const status = (error as { status?: unknown }).status
  if (typeof status !== 'number') return error instanceof Error ? error : new Error(String(error))
  if (status === 401) {
    return new Error(
      'Command Code did not accept the API key. Run `cmd login` in a terminal, then try again.'
    )
  }
  const body = (error as { error?: { message?: unknown; error?: { message?: unknown } } }).error
  const message = body?.error?.message ?? body?.message
  return new Error(
    `Command Code answered ${status}: ${typeof message === 'string' ? message : (error as Error).message}`
  )
}

let anthropic: { key: string; client: Anthropic } | undefined
let openai: { key: string; client: OpenAI } | undefined

async function anthropicClient(key: string): Promise<Anthropic> {
  if (anthropic?.key !== key) {
    const { default: Client } = await import('@anthropic-ai/sdk')
    anthropic = {
      key,
      client: new Client({ apiKey: key, baseURL: BASE_URL, maxRetries: MAX_RETRIES })
    }
  }
  return anthropic.client
}

async function openaiClient(key: string): Promise<OpenAI> {
  if (openai?.key !== key) {
    const { default: Client } = await import('openai')
    openai = {
      key,
      client: new Client({ apiKey: key, baseURL: `${BASE_URL}/v1`, maxRetries: MAX_RETRIES })
    }
  }
  return openai.client
}

/** Tool arguments as an object; arguments that are not a JSON object become {}. */
export function parseArguments(json: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(json || '{}')
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** Whether a stored reply can be replayed as is: same model, same route. */
function replays(turn: AssistantTurn, model: string, api: Api): boolean {
  return turn.native !== undefined && turn.model === model && turn.api === api
}

// --- Anthropic Messages (Claude) --------------------------------------------

/**
 * Three cache breakpoints, as pi places them: the end of the tools, of the
 * system prompt, and of the newest message. Each request then reads everything
 * up to the previous request's last message from the cache.
 */
const CACHE = { type: 'ephemeral' } as const

async function streamMessages(
  key: string,
  request: Request,
  on: StreamHandlers,
  signal: AbortSignal
): Promise<Reply> {
  const client = await anthropicClient(key)
  const messages = toAnthropicMessages(request.turns, request.model)
  const last = messages.at(-1)?.content
  if (Array.isArray(last) && last.length > 0) {
    last[last.length - 1] = {
      ...last[last.length - 1],
      cache_control: CACHE
    } as (typeof last)[number]
  }
  const levels = effortLevels({ id: request.model, name: '', api: 'messages', vision: true })
  const effort = levels.includes(request.effort) ? request.effort : 'high'
  const stream = client.messages.stream(
    {
      model: request.model,
      max_tokens: CLAUDE_MAX_TOKENS,
      system: [{ type: 'text', text: request.system, cache_control: CACHE }],
      tools: request.tools.map((tool, index) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters as Anthropic.Tool.InputSchema,
        ...(index === request.tools.length - 1 ? { cache_control: CACHE } : {})
      })),
      messages,
      ...(levels.length > 0
        ? {
            thinking: { type: 'adaptive', display: 'summarized' },
            output_config: { effort: effort as Exclude<Effort, 'default'> }
          }
        : {})
    },
    { signal }
  )
  for await (const event of stream) {
    on.activity()
    if (event.type !== 'content_block_delta') continue
    if (event.delta.type === 'text_delta') on.text(event.delta.text)
    else if (event.delta.type === 'thinking_delta') on.thinking(event.delta.thinking)
  }
  const message = await stream.finalMessage()
  const usage = message.usage
  console.log(
    `[commandcode-api] ${request.model}: ${usage.input_tokens} in, ${usage.cache_read_input_tokens ?? 0} cache read, ${usage.cache_creation_input_tokens ?? 0} cache write, ${usage.output_tokens} out`
  )

  const native = message.content.flatMap(toBlockParam)
  const toolCalls: ToolCall[] = message.content.flatMap((block) =>
    block.type === 'tool_use'
      ? [{ id: block.id, name: block.name, arguments: JSON.stringify(block.input) }]
      : []
  )
  const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
  const stop: Stop =
    message.stop_reason === 'max_tokens'
      ? 'max_tokens'
      : message.stop_reason === 'refusal'
        ? 'refusal'
        : toolCalls.length > 0
          ? 'tool_use'
          : 'end'
  return {
    turn: { role: 'assistant', model: request.model, api: 'messages', text, toolCalls, native },
    stop
  }
}

/**
 * A response block as the request field it is sent back as: the same content,
 * without response-only fields (citations, parsed output).
 */
function toBlockParam(block: Anthropic.ContentBlock): Anthropic.ContentBlockParam[] {
  switch (block.type) {
    case 'text':
      return [{ type: 'text', text: block.text }]
    case 'thinking':
      return [{ type: 'thinking', thinking: block.thinking, signature: block.signature }]
    case 'redacted_thinking':
      return [{ type: 'redacted_thinking', data: block.data }]
    case 'tool_use':
      return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }]
    default:
      return [block as unknown as Anthropic.ContentBlockParam]
  }
}

/** Anthropic tool ids allow letters, digits, _ and - only; other models' ids may not fit. */
function anthropicId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

function anthropicPart(part: Part): Anthropic.TextBlockParam | Anthropic.ImageBlockParam {
  return part.type === 'text'
    ? { type: 'text', text: part.text }
    : {
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.mimeType as Anthropic.Base64ImageSource['media_type'],
          data: part.data
        }
      }
}

function toAnthropicMessages(turns: Turn[], model: string): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = []
  for (const turn of turns) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: turn.content.map(anthropicPart) })
    } else if (turn.role === 'tool') {
      messages.push({
        role: 'user',
        content: turn.results.map((result) => ({
          type: 'tool_result',
          tool_use_id: anthropicId(result.callId),
          content: result.content.map(anthropicPart),
          ...(result.isError ? { is_error: true } : {})
        }))
      })
    } else {
      const content: Anthropic.ContentBlockParam[] = replays(turn, model, 'messages')
        ? (turn.native as Anthropic.ContentBlockParam[])
        : [
            ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
            ...turn.toolCalls.map((call) => ({
              type: 'tool_use' as const,
              id: anthropicId(call.id),
              name: call.name,
              input: parseArguments(call.arguments) ?? {}
            }))
          ]
      // An empty assistant message is rejected; a reply cut off before any text has nothing to keep.
      if (content.length > 0) messages.push({ role: 'assistant', content })
    }
  }
  return messages
}

// --- Chat Completions (everything else) -------------------------------------

/**
 * Upstreams return reasoning in one of these fields; it is sent back in the same
 * one (DeepSeek and Kimi require it on tool-call turns). Some send the same text
 * in two, so only the first field seen is kept.
 */
const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_text'] as const

/** OpenRouter-style structured reasoning; sent back instead of a reasoning field when present. */
type ReasoningDetail = { type: string; text?: string; summary?: string; [key: string]: unknown }

type ChatDelta = OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta &
  Partial<Record<(typeof REASONING_FIELDS)[number], string>> & {
    reasoning_details?: ReasoningDetail[]
  }

async function streamChat(
  key: string,
  model: Model,
  request: Request,
  on: StreamHandlers,
  signal: AbortSignal
): Promise<Reply> {
  const client = await openaiClient(key)
  const stream = await client.chat.completions.create(
    {
      model: request.model,
      messages: toChatMessages(request, model.vision),
      max_tokens: CHAT_MAX_TOKENS,
      stream: true,
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function' as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters
              }
            }))
          }
        : {}),
      ...(request.effort !== 'default'
        ? { reasoning_effort: request.effort as OpenAI.ReasoningEffort }
        : {})
    },
    { signal }
  )

  let text = ''
  let reasoning = ''
  let reasoningField: (typeof REASONING_FIELDS)[number] | undefined
  const details: ReasoningDetail[] = []
  const calls: ToolCall[] = []
  const callsByIndex = new Map<number, ToolCall>()
  let finish: string | undefined
  let usage: OpenAI.CompletionUsage | undefined

  for await (const chunk of stream) {
    on.activity()
    if (chunk.usage) usage = chunk.usage
    const choice = chunk.choices[0]
    if (!choice) continue
    const delta = choice.delta as ChatDelta
    if (delta.content) {
      text += delta.content
      on.text(delta.content)
    }
    const field = REASONING_FIELDS.find((f) => typeof delta[f] === 'string' && delta[f])
    if (field && (reasoningField ?? field) === field) {
      reasoningField = field
      reasoning += delta[field]
      on.thinking(delta[field]!)
    }
    for (const detail of delta.reasoning_details ?? []) {
      appendDetail(details, detail)
      const shown = detail.text ?? detail.summary
      if (!reasoningField && typeof shown === 'string') on.thinking(shown)
    }
    for (const delta_ of delta.tool_calls ?? []) {
      let call = callsByIndex.get(delta_.index)
      // Some upstreams number every call 0 and tell them apart by id.
      if (!call || (delta_.id && call.id && delta_.id !== call.id)) {
        call = { id: delta_.id ?? '', name: '', arguments: '' }
        calls.push(call)
        callsByIndex.set(delta_.index, call)
      }
      if (delta_.id && !call.id) call.id = delta_.id
      if (delta_.function?.name && !call.name) call.name = delta_.function.name
      call.arguments += delta_.function?.arguments ?? ''
    }
    if (choice.finish_reason) finish = choice.finish_reason
  }
  if (!finish) throw new Error('Command Code ended the reply before it was finished.')
  if (usage) {
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
    console.log(
      `[commandcode-api] ${request.model}: ${usage.prompt_tokens} in, ${cached} cache read, ${usage.completion_tokens} out`
    )
  }

  // A call without an id could not be answered; give it one, kept in the replay too.
  for (const call of calls) call.id ||= `call_${crypto.randomUUID().slice(0, 8)}`
  const native: Record<string, unknown> = { role: 'assistant', content: text || null }
  if (calls.length > 0) {
    native.tool_calls = calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments }
    }))
  }
  if (details.length > 0) native.reasoning_details = details
  else if (reasoningField && reasoning) native[reasoningField] = reasoning

  const stop: Stop =
    finish === 'length'
      ? 'max_tokens'
      : finish === 'content_filter'
        ? 'refusal'
        : calls.length > 0
          ? 'tool_use'
          : 'end'
  return {
    turn: { role: 'assistant', model: request.model, api: 'chat', text, toolCalls: calls, native },
    stop
  }
}

/** Streamed reasoning details arrive in pieces: consecutive text or summary pieces form one entry. */
function appendDetail(details: ReasoningDetail[], detail: ReasoningDetail): void {
  const last = details.at(-1)
  if (
    last &&
    last.type === detail.type &&
    (detail.type === 'reasoning.text' || detail.type === 'reasoning.summary')
  ) {
    const field = detail.type === 'reasoning.text' ? 'text' : 'summary'
    last[field] = `${last[field] ?? ''}${detail[field] ?? ''}`
    for (const [name, value] of Object.entries(detail)) {
      if (last[name] === undefined || last[name] === null) last[name] = value
    }
    return
  }
  details.push({ ...detail })
}

const NO_VISION = '[An image was attached, but this model cannot see images.]'

function chatUserContent(
  parts: Part[],
  vision: boolean
): OpenAI.Chat.Completions.ChatCompletionUserMessageParam['content'] {
  if (!parts.some((p) => p.type === 'image')) {
    return parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n\n')
  }
  return parts.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : vision
        ? { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } }
        : { type: 'text', text: NO_VISION }
  )
}

function toChatMessages(
  request: Request,
  vision: boolean
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  // `system`, not `developer`: several upstreams on this route reject `developer`.
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: request.system }
  ]
  for (const turn of request.turns) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: chatUserContent(turn.content, vision) })
    } else if (turn.role === 'assistant') {
      if (replays(turn, request.model, 'chat')) {
        messages.push(turn.native as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam)
      } else if (turn.text || turn.toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: turn.text || null,
          ...(turn.toolCalls.length > 0
            ? {
                tool_calls: turn.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function' as const,
                  function: { name: call.name, arguments: call.arguments }
                }))
              }
            : {})
        })
      }
    } else {
      // Tool messages carry text only: images follow in one user message.
      const images: Part[] = []
      for (const result of turn.results) {
        const text = result.content
          .map((part) => {
            if (part.type === 'text') return part.text
            images.push(part)
            return vision ? '[Image attached below.]' : NO_VISION
          })
          .join('\n')
        messages.push({ role: 'tool', tool_call_id: result.callId, content: text })
      }
      if (vision && images.length > 0) {
        messages.push({
          role: 'user',
          content: chatUserContent(
            [{ type: 'text', text: 'Images returned by the tools above:' }, ...images],
            true
          )
        })
      }
    }
  }
  return messages
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}
