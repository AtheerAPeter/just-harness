import type { McpEntry } from './mcp'
import type { Endpoint, Model } from './wire'

import type { HarnessAgentId } from '../../shared/types'
export { HARNESS_AGENTS, isHarnessAgent, type HarnessAgentId } from '../../shared/types'

/** One list of models with one bill: a plan, a key, or the free tier. */
export interface Source {
  id: string
  name: string
  models: Model[]
  /** Why it lists no models right now. */
  error?: string
}

export interface Provider {
  id: HarnessAgentId
  /** The provider's name in messages. */
  name: string
  /** What to do when it is not signed in. */
  signIn: string
  /** Why it cannot be used when signedIn() is false, if not "<name> is not signed in. <signIn>". */
  notReady?: string
  /** What a source is called in the chat's options; "Plan" when unset. */
  sourceLabel?: string
  /** Name the source in the picker even when there is only one (the user's own providers). */
  alwaysNameSources?: boolean
  signedIn(): Promise<boolean>
  /** The sources this sign-in can use, each with the models it serves now. */
  sources(): Promise<Source[]>
  /** Where to send a chat's requests for a source, with fresh credentials. */
  endpoint(source: string, chatId: string): Promise<Endpoint>
  /** The model the provider's own CLI is set to, to start new chats on. */
  preferred(): Promise<{ source?: string; model: string } | undefined>
  /** The MCP servers the provider's own CLI has set up for the project (see mcp-config.ts). */
  mcpServers(cwd: string): Promise<McpEntry[]>
}
