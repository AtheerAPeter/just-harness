import { setTimeout as sleep } from 'node:timers/promises'
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
 * The wire formats the harness speaks, with the official SDKs: Anthropic
 * Messages, OpenAI Chat Completions and OpenAI Responses. Providers say where
 * to send them.
 */

/** A model as a provider serves it. */
export interface Model {
  id: string
  name: string
  api: Api
  vision: boolean
  /** Its output limit, when the provider says. */
  maxOutput?: number
}

/** Where and how to send a request. */
export interface Endpoint {
  /** For the Anthropic SDK, which appends /v1/messages. */
  messagesURL?: string
  /** For the OpenAI SDK, which appends /chat/completions or /responses. */
  chatURL: string
  /** Unset for a provider that takes none, such as a local server. */
  key?: string
  headers?: Record<string, string>
  /** Headers for this chat's requests only, such as a session id. */
  chatHeaders?: Record<string, string>
  /** Shown when the key is refused. */
  signIn: string
  /** The provider's name in errors. */
  name: string
  /** How the chat route takes effort: OpenAI's `reasoning_effort`, or OpenRouter's `reasoning` object. */
  reasoning?: 'reasoning_effort' | 'reasoning'
  /** Whether chat requests to this model carry Anthropic cache breakpoints (OpenRouter-style gateways). */
  cacheControl?(model: string): boolean
  /** Whether the stream must be asked for its token usage. */
  streamUsage?: boolean
}

/**
 * Retries for 429s ("upstream temporarily unavailable"), 5xx and dropped
 * connections, made here rather than by the SDKs: the Anthropic SDK waits as
 * long as Retry-After says, and a used-up quota answers 429 with a wait of days.
 */
const MAX_RETRIES = 4
/** A longer Retry-After means a limit, not a hiccup: the error is shown at once. */
const MAX_RETRY_WAIT_MS = 60_000

/** Output limits. Thinking counts against them; streaming keeps long replies under the HTTP timeout. */
const MESSAGES_MAX_TOKENS = 64_000
const CHAT_MAX_TOKENS = 32_768

/**
 * Claude models from Opus 4.6, Sonnet 4.6 and Fable 5 on take adaptive thinking
 * with an effort level (and reject a token budget). Others run without thinking.
 */
const ADAPTIVE_THINKING = /(opus[-.](4[-.][678]|5)|sonnet[-.](4[-.]6|5)|fable[-.]5|mythos[-.]5)/

/** The effort levels a model takes; the first entry of OpenAI-format models means "the provider's default". */
export function effortLevels(model: Model): Effort[] {
  if (model.api !== 'messages') return ['default', 'low', 'medium', 'high']
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
  endpoint: Endpoint,
  model: Model,
  request: Request,
  on: StreamHandlers,
  signal: AbortSignal
): Promise<Reply> {
  for (let attempt = 0; ; attempt++) {
    // Only a request that failed before anything arrived can be sent again.
    let received = false
    const handlers = { ...on, activity: () => ((received = true), on.activity()) }
    try {
      return model.api === 'messages'
        ? await streamMessages(endpoint, model, request, handlers, signal)
        : model.api === 'responses'
          ? await streamResponses(endpoint, model, request, handlers, signal)
          : await streamChat(endpoint, model, request, handlers, signal)
    } catch (error) {
      if (signal.aborted) throw error
      const wait = received || attempt >= MAX_RETRIES ? undefined : await retryDelay(error, attempt)
      if (wait === undefined) throw readableError(endpoint, error)
      // Stop ends the wait at once; the wait can be up to a minute.
      await sleep(wait, undefined, { signal }).catch(() => undefined)
      if (signal.aborted) throw error
    }
  }
}

/** How long to wait before retrying, or undefined when the error is not worth retrying. */
async function retryDelay(error: unknown, attempt: number): Promise<number | undefined> {
  const { status, headers } = error as { status?: unknown; headers?: Headers }
  // Both SDKs are loaded by now; their connection errors include timeouts.
  const [anthropicSdk, openaiSdk] = await Promise.all([
    import('@anthropic-ai/sdk'),
    import('openai')
  ])
  const transient =
    typeof status === 'number'
      ? status === 408 || status === 409 || status === 429 || status >= 500
      : error instanceof anthropicSdk.APIConnectionError ||
        error instanceof openaiSdk.APIConnectionError
  if (!transient) return undefined
  const ms = Number(headers?.get?.('retry-after-ms'))
  const seconds = Number(headers?.get?.('retry-after'))
  const asked = ms > 0 ? ms : seconds > 0 ? seconds * 1000 : undefined
  if (asked !== undefined) return asked <= MAX_RETRY_WAIT_MS ? asked : undefined
  // Exponential backoff from 0.5 s to 8 s with jitter, as the SDKs do.
  return Math.min(500 * 2 ** attempt, 8000) * (1 - Math.random() * 0.25)
}

/** The SDKs' errors carry the gateway's JSON body; show its message, not the raw JSON. */
function readableError(endpoint: Endpoint, error: unknown): Error {
  const status = (error as { status?: unknown }).status
  if (typeof status !== 'number') return error instanceof Error ? error : new Error(String(error))
  if (status === 401) {
    return new Error(`${endpoint.name} did not accept the sign-in. ${endpoint.signIn}`)
  }
  const body = (
    error as {
      error?: { message?: unknown; code?: unknown; error?: { message?: unknown; code?: unknown } }
    }
  ).error
  const message = body?.error?.message ?? body?.message
  const text = typeof message === 'string' ? message : (error as Error).message
  const code = body?.error?.code ?? body?.code
  // The chat only grows, so a request this large fails the same way every time.
  const full =
    status === 413
      ? ' The request is too large for the provider, often because of many images such as screenshots. Start a new chat to continue.'
      : status === 400 && (code === 'context_length_exceeded' || CONTEXT_FULL.test(text))
        ? ` ${CONTEXT_FULL_MESSAGE}`
        : ''
  return new Error(`${endpoint.name} answered ${status}: ${text}${full}`)
}

/**
 * How providers word a request over the context window: Anthropic ("prompt is
 * too long"), OpenAI ("maximum context length"), and gateways in between.
 */
const CONTEXT_FULL =
  /prompt is too long|maximum context length|context (length|window)|too many tokens/i

export const CONTEXT_FULL_MESSAGE =
  "This chat no longer fits in the model's context window. Start a new chat to continue."

/** Clients by URL, key and headers: one per provider and sign-in. */
const clients = new Map<string, Anthropic | OpenAI>()

/**
 * Both SDKs insist on a key, and without one the Anthropic SDK looks for the
 * user's own Anthropic credentials. A provider that takes no key is given this
 * stand-in, and the header that would carry it is left out (the SDKs' way to
 * omit their auth header), so nothing is sent in its place.
 */
const NO_KEY = 'none'

async function anthropicClient(endpoint: Endpoint): Promise<Anthropic> {
  if (!endpoint.messagesURL) throw new Error(`${endpoint.name} has no Messages route.`)
  const id = JSON.stringify(['messages', endpoint.messagesURL, endpoint.key, endpoint.headers])
  let client = clients.get(id) as Anthropic | undefined
  if (!client) {
    const { default: Client } = await import('@anthropic-ai/sdk')
    client = new Client({
      apiKey: endpoint.key ?? NO_KEY,
      baseURL: endpoint.messagesURL,
      defaultHeaders: endpoint.key ? endpoint.headers : { 'X-Api-Key': null, ...endpoint.headers },
      maxRetries: 0
    })
    clients.set(id, client)
  }
  return client
}

async function openaiClient(endpoint: Endpoint): Promise<OpenAI> {
  const id = JSON.stringify(['chat', endpoint.chatURL, endpoint.key, endpoint.headers])
  let client = clients.get(id) as OpenAI | undefined
  if (!client) {
    const { default: Client } = await import('openai')
    client = new Client({
      apiKey: endpoint.key ?? NO_KEY,
      baseURL: endpoint.chatURL,
      defaultHeaders: endpoint.key
        ? endpoint.headers
        : { Authorization: null, ...endpoint.headers },
      maxRetries: 0
    })
    clients.set(id, client)
  }
  return client
}

/** How long listing an endpoint's models may take. */
const LIST_TIMEOUT_MS = 15_000

/**
 * The models an endpoint lists on its /models, in the format it speaks: every
 * page of Anthropic's, or the OpenAI-style list. Named as the list names them
 * (OpenAI's has ids only; gateways such as OpenRouter add a name).
 */
export async function listModels(
  endpoint: Endpoint,
  api: Api
): Promise<{ id: string; name: string }[]> {
  const models: { id: string; name: string }[] = []
  try {
    if (api === 'messages') {
      const client = await anthropicClient(endpoint)
      const pages = client.models.list({ limit: 1000 }, { timeout: LIST_TIMEOUT_MS })
      // Compatible servers may leave the name out.
      for await (const model of pages) {
        models.push({ id: model.id, name: model.display_name || model.id })
      }
    } else {
      const client = await openaiClient(endpoint)
      for await (const model of client.models.list({ timeout: LIST_TIMEOUT_MS })) {
        const name = (model as { name?: unknown }).name
        models.push({ id: model.id, name: typeof name === 'string' && name ? name : model.id })
      }
    }
  } catch (error) {
    // A connection error says only "Connection error.": say who could not be reached.
    if (typeof (error as { status?: unknown }).status !== 'number') {
      const url = api === 'messages' ? endpoint.messagesURL : endpoint.chatURL
      throw new Error(`Could not reach ${endpoint.name} at ${url}: ${(error as Error).message}`)
    }
    throw readableError(endpoint, error)
  }
  return models
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
  endpoint: Endpoint,
  model: Model,
  request: Request,
  on: StreamHandlers,
  signal: AbortSignal
): Promise<Reply> {
  const client = await anthropicClient(endpoint)
  const messages = toAnthropicMessages(request.turns, request.model)
  const last = messages.at(-1)?.content
  if (Array.isArray(last) && last.length > 0) {
    last[last.length - 1] = {
      ...last[last.length - 1],
      cache_control: CACHE
    } as (typeof last)[number]
  }
  const levels = effortLevels(model)
  const effort = levels.includes(request.effort) ? request.effort : 'high'
  const stream = client.messages.stream(
    {
      model: request.model,
      max_tokens: Math.min(MESSAGES_MAX_TOKENS, model.maxOutput ?? MESSAGES_MAX_TOKENS),
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
    { signal, headers: endpoint.chatHeaders }
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
    `[harness] ${request.model}: ${usage.input_tokens} in, ${usage.cache_read_input_tokens ?? 0} cache read, ${usage.cache_creation_input_tokens ?? 0} cache write, ${usage.output_tokens} out`
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
      : message.stop_reason === 'model_context_window_exceeded'
        ? 'context_full'
        : message.stop_reason === 'refusal'
          ? 'refusal'
          : toolCalls.length > 0
            ? 'tool_use'
            : 'end'
  const contextTokens =
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    usage.output_tokens
  return {
    turn: {
      role: 'assistant',
      model: request.model,
      api: 'messages',
      text,
      toolCalls,
      native,
      contextTokens
    },
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
  endpoint: Endpoint,
  model: Model,
  request: Request,
  on: StreamHandlers,
  signal: AbortSignal
): Promise<Reply> {
  const client = await openaiClient(endpoint)
  const messages = toChatMessages(request, model.vision)
  if (endpoint.cacheControl?.(model.id)) addChatBreakpoints(messages)
  const effort = request.effort === 'default' ? undefined : request.effort
  const stream = await client.chat.completions.create(
    {
      model: request.model,
      messages,
      max_tokens: Math.min(CHAT_MAX_TOKENS, model.maxOutput ?? CHAT_MAX_TOKENS),
      stream: true,
      ...(endpoint.streamUsage ? { stream_options: { include_usage: true } } : {}),
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
      ...(effort && endpoint.reasoning === 'reasoning'
        ? // OpenRouter's form, which Cline's gateway takes; the SDK passes unknown fields through.
          ({ reasoning: { effort } } as object)
        : effort
          ? { reasoning_effort: effort as OpenAI.ReasoningEffort }
          : {})
    },
    { signal, headers: endpoint.chatHeaders }
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
  if (!finish) throw new Error(`${endpoint.name} ended the reply before it was finished.`)
  if (usage) {
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
    console.log(
      `[harness] ${request.model}: ${usage.prompt_tokens} in, ${cached} cache read, ${usage.completion_tokens} out`
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
    turn: {
      role: 'assistant',
      model: request.model,
      api: 'chat',
      text,
      toolCalls: calls,
      native,
      // Prompt tokens include the cached ones.
      ...(usage ? { contextTokens: usage.prompt_tokens + usage.completion_tokens } : {})
    },
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

// --- Responses (OpenAI's newer route) ----------------------------------------

/**
 * Sent with `store: false`, so nothing is kept on the provider's side and every
 * request carries the whole conversation, as on the other routes. A reply is
 * replayed as the output items it came as; its reasoning then has to come back
 * with the encrypted content the provider sent (asked for with `include`).
 */
async function streamResponses(
  endpoint: Endpoint,
  model: Model,
  request: Request,
  on: StreamHandlers,
  signal: AbortSignal
): Promise<Reply> {
  const client = await openaiClient(endpoint)
  const effort = request.effort === 'default' ? undefined : request.effort
  const stream = await client.responses.create(
    {
      model: request.model,
      instructions: request.system,
      input: toResponsesInput(request, model.vision),
      max_output_tokens: Math.min(CHAT_MAX_TOKENS, model.maxOutput ?? CHAT_MAX_TOKENS),
      store: false,
      stream: true,
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function' as const,
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              strict: false
            }))
          }
        : {}),
      ...(effort
        ? {
            reasoning: { effort: effort as OpenAI.ReasoningEffort, summary: 'auto' as const },
            include: ['reasoning.encrypted_content' as const]
          }
        : {})
    },
    { signal, headers: endpoint.chatHeaders }
  )

  let response: OpenAI.Responses.Response | undefined
  for await (const event of stream) {
    on.activity()
    switch (event.type) {
      case 'response.output_text.delta':
        on.text(event.delta)
        break
      // Summaries for OpenAI's models, the reasoning itself for open models served this way.
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        on.thinking(event.delta)
        break
      case 'response.reasoning_summary_part.added':
        if (event.summary_index > 0) on.thinking('\n\n')
        break
      case 'response.completed':
      case 'response.incomplete':
        response = event.response
        break
      case 'response.failed':
        throw new Error(
          `${endpoint.name} could not finish the reply: ${event.response.error?.message ?? 'it gave no reason.'}`
        )
      case 'error':
        throw new Error(`${endpoint.name} answered: ${event.message}`)
    }
  }
  if (!response) throw new Error(`${endpoint.name} ended the reply before it was finished.`)
  const usage = response.usage
  if (usage) {
    console.log(
      `[harness] ${request.model}: ${usage.input_tokens} in, ${usage.input_tokens_details?.cached_tokens ?? 0} cache read, ${usage.output_tokens} out`
    )
  }

  let text = ''
  let refused = false
  const toolCalls: ToolCall[] = []
  for (const item of response.output) {
    if (item.type === 'message') {
      for (const part of item.content) {
        if (part.type === 'output_text') text += part.text
        else {
          text += part.refusal
          refused = true
        }
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments })
    }
  }
  const reason = response.incomplete_details?.reason
  const stop: Stop =
    reason === 'max_output_tokens'
      ? 'max_tokens'
      : reason === 'content_filter' || refused
        ? 'refusal'
        : toolCalls.length > 0
          ? 'tool_use'
          : 'end'
  return {
    turn: {
      role: 'assistant',
      model: request.model,
      api: 'responses',
      text,
      toolCalls,
      native: response.output,
      // Input tokens include the cached ones.
      ...(usage ? { contextTokens: usage.input_tokens + usage.output_tokens } : {})
    },
    stop
  }
}

/**
 * A reply replays as its output items when the same model continues and its
 * reasoning can be sent back: reasoning returned without encrypted content
 * (the provider's default effort, which `include` is not sent with) cannot be,
 * and the calls that came with it are tied to it. Other replies are rebuilt
 * from their text and calls.
 */
function responsesReplay(turn: AssistantTurn, model: string): OpenAI.Responses.ResponseInputItem[] {
  if (replays(turn, model, 'responses')) {
    const items = turn.native as OpenAI.Responses.ResponseOutputItem[]
    if (items.every((item) => item.type !== 'reasoning' || item.encrypted_content)) {
      return items as OpenAI.Responses.ResponseInputItem[]
    }
  }
  return [
    ...(turn.text ? [{ role: 'assistant' as const, content: turn.text }] : []),
    ...turn.toolCalls.map((call) => ({
      type: 'function_call' as const,
      call_id: call.id,
      name: call.name,
      arguments: call.arguments
    }))
  ]
}

function responsesContent(
  parts: Part[],
  vision: boolean
): OpenAI.Responses.ResponseInputMessageContentList {
  return parts.map((part) =>
    part.type === 'text'
      ? { type: 'input_text', text: part.text }
      : vision
        ? {
            type: 'input_image',
            image_url: `data:${part.mimeType};base64,${part.data}`,
            detail: 'auto'
          }
        : { type: 'input_text', text: NO_VISION }
  )
}

function toResponsesInput(request: Request, vision: boolean): OpenAI.Responses.ResponseInput {
  const input: OpenAI.Responses.ResponseInput = []
  for (const turn of request.turns) {
    if (turn.role === 'user') {
      input.push({ role: 'user', content: responsesContent(turn.content, vision) })
    } else if (turn.role === 'assistant') {
      input.push(...responsesReplay(turn, request.model))
    } else {
      for (const result of turn.results) {
        // Text alone as a string, which every server takes; images in a list with it.
        const output = result.content.some((p) => p.type === 'image')
          ? responsesContent(result.content, vision)
          : result.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
        input.push({ type: 'function_call_output', call_id: result.callId, output })
      }
    }
  }
  return input
}

/**
 * Anthropic models behind an OpenAI-compatible gateway (OpenRouter, Cline) are
 * cached only where a text part carries cache_control: the system prompt and
 * the newest message, as on the Messages route.
 */
function addChatBreakpoints(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): void {
  const mark = (message: OpenAI.Chat.Completions.ChatCompletionMessageParam): void => {
    const content = message.content
    if (typeof content === 'string') {
      message.content = [{ type: 'text', text: content, cache_control: CACHE }] as never
    } else if (Array.isArray(content)) {
      const index = content.findLastIndex((part) => part.type === 'text')
      if (index >= 0) content[index] = { ...content[index], cache_control: CACHE } as never
    }
  }
  mark(messages[0])
  const last = messages.at(-1)
  if (last && last !== messages[0] && (last.role === 'user' || last.role === 'tool')) mark(last)
}
