import { homedir } from 'node:os'
import { isAbsolute, relative, resolve as resolvePath } from 'node:path'
import type * as acp from '@agentclientprotocol/sdk'
import type { AgentCommand, AgentOption, ChatItem } from '../shared/types'
import * as store from './store'

export interface AgentEvents {
  item(chatId: string, item: ChatItem): void
  options(chatId: string, options: AgentOption[]): void
  commands(chatId: string, commands: AgentCommand[]): void
  stateChanged(): void
}

export interface PendingPermission {
  chatId: string
  resolve: (response: acp.RequestPermissionResponse) => void
}

/** Permission requests waiting for the user, by permission item id. Shared by every agent. */
export type Permissions = Map<string, PendingPermission>

/** Save an item and show it; a permission item also updates whether the chat is waiting. */
export function emitItem(
  events: AgentEvents,
  permissions: Permissions,
  chatId: string,
  item: ChatItem
): void {
  events.item(chatId, store.upsertItem(chatId, item))
  if (item.kind !== 'permission') return
  const waiting = [...permissions.values()].some((p) => p.chatId === chatId)
  if (Boolean(store.getChat(chatId).waiting) === waiting) return
  store.updateChat(chatId, { waiting })
  events.stateChanged()
}

/**
 * Ask about a tool call: approved at once in bypass mode, otherwise shown to the
 * user until they pick an option or the turn is cancelled.
 */
export function requestPermission(
  events: AgentEvents,
  permissions: Permissions,
  chatId: string,
  toolCall: acp.ToolCallUpdate,
  options: acp.PermissionOption[]
): Promise<acp.RequestPermissionResponse> {
  const id = crypto.randomUUID()
  const item: Extract<ChatItem, { kind: 'permission' }> = {
    kind: 'permission',
    id,
    title: toolCall.title ?? 'Tool call',
    options: options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }))
  }
  const chat = store.getChat(chatId)
  // Project-only mode: anything outside the project always goes to the user,
  // bypass or not, with the agent's own options (including "always").
  const outside = chat.projectOnly
    ? outsidePath(store.getProject(chat.projectId).path, toolCall)
    : undefined
  if (outside) item.outside = outside
  const autoOption = chat.bypassPermissions && !outside ? bypassOption(item.options) : undefined
  if (autoOption) {
    emitItem(events, permissions, chatId, { ...item, resolved: autoOption, auto: true })
    return Promise.resolve({ outcome: { outcome: 'selected', optionId: autoOption } })
  }
  // Registered before the item is shown, so the chat counts as waiting.
  return new Promise((resolve) => {
    permissions.set(id, { chatId, resolve })
    emitItem(events, permissions, chatId, item)
  })
}

/** Paths that are never "outside": shell plumbing like 2>/dev/null. */
const HARMLESS_PATHS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin'])

/**
 * For project-only mode: the first path a tool request touches outside the
 * project, if any. Looks at the locations the agent declares and at absolute or
 * ~ paths anywhere in the tool's arguments, including shell commands. URLs are
 * not paths (the "/" there follows ":"), so they are ignored.
 */
export function outsidePath(projectPath: string, toolCall: acp.ToolCallUpdate): string | undefined {
  const candidates = (toolCall.locations ?? []).map((l) => l.path)
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const [, path] of value.matchAll(/(?:^|[\s"'=(])((?:~|\/)[^\s"'`;|&<>()]*)/g)) {
        candidates.push(path)
      }
    } else if (value && typeof value === 'object') {
      for (const inner of Object.values(value)) scan(inner)
    }
  }
  scan(toolCall.rawInput)
  for (const candidate of candidates) {
    if (HARMLESS_PATHS.has(candidate)) continue
    const absolute = resolvePath(projectPath, candidate.replace(/^~(?=\/|$)/, homedir()))
    const rel = relative(projectPath, absolute)
    if (rel.startsWith('..') || isAbsolute(rel)) return candidate
  }
  return undefined
}

/**
 * The option bypass mode picks: allow once, so no lasting rule is written into
 * the agent's own config. Falls back to allow always when that is all there is.
 */
export function bypassOption(options: { optionId: string; kind: string }[]): string | undefined {
  return (
    options.find((o) => o.kind === 'allow_once')?.optionId ??
    options.find((o) => o.kind === 'allow_always')?.optionId
  )
}
