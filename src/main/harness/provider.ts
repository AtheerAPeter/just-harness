import type { Endpoint, Model } from './wire'

/** The agents the app runs itself, one per provider API. */
export const HARNESS_AGENTS = ['commandcode-api', 'opencode-api', 'cline-api'] as const
export type HarnessAgentId = (typeof HARNESS_AGENTS)[number]

export function isHarnessAgent(agent: string): agent is HarnessAgentId {
  return (HARNESS_AGENTS as readonly string[]).includes(agent)
}

/** One list of models with one bill: a plan, a key, or the free tier. */
export interface Source {
  id: string
  name: string
  models: Model[]
}

export interface Provider {
  id: HarnessAgentId
  /** The provider's name in messages. */
  name: string
  /** What to do when it is not signed in. */
  signIn: string
  signedIn(): Promise<boolean>
  /** The sources this sign-in can use, each with the models it serves now. */
  sources(): Promise<Source[]>
  /** Where to send a chat's requests for a source, with fresh credentials. */
  endpoint(source: string, chatId: string): Promise<Endpoint>
  /** The model the provider's own CLI is set to, to start new chats on. */
  preferred(): Promise<{ source?: string; model: string } | undefined>
}
