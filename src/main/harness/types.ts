/**
 * The harness transcript. It is append-only: nothing already in it is ever
 * rewritten, so every request is the previous one plus new turns, and the
 * provider's prompt cache always matches the prefix.
 */

/** Which Command Code route serves a model. */
export type Api = 'messages' | 'chat'

export type Part =
  { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }

export interface ToolCall {
  id: string
  name: string
  /** The arguments as JSON, exactly as the model sent them. */
  arguments: string
}

export interface ToolResult {
  callId: string
  content: Part[]
  isError: boolean
}

export type UserTurn = { role: 'user'; content: Part[] }

export interface AssistantTurn {
  role: 'assistant'
  model: string
  api: Api
  text: string
  toolCalls: ToolCall[]
  /**
   * The message as the API returned it (thinking blocks and signatures, reasoning
   * fields). Replayed unchanged when the same model continues; other models get
   * one built from `text` and `toolCalls`. Unset for a reply cut off midway.
   */
  native?: unknown
}

export type ToolTurn = { role: 'tool'; results: ToolResult[] }

export type Turn = UserTurn | AssistantTurn | ToolTurn

/** A tool as declared to the model. */
export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>
}

export type Effort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface Request {
  model: string
  effort: Effort
  system: string
  tools: ToolSpec[]
  turns: Turn[]
}

export interface StreamHandlers {
  text(delta: string): void
  thinking(delta: string): void
  /** Anything arrived, even a chunk with nothing to show. */
  activity(): void
}

/** Why a reply ended. */
export type Stop = 'end' | 'tool_use' | 'max_tokens' | 'refusal'

export interface Reply {
  turn: AssistantTurn
  stop: Stop
}
