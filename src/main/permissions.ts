import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
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
 * Shell features that can reach outside the project without an absolute path
 * in the text: parent folders, variables, command substitution. A command using any of them cannot be shown to stay inside.
 */
const SHELL_ESCAPES = /(?:^|[\s"'=/])(\.\.)(?=\/|\s|$|["'])|(\$\{?\w+|\$\()|(`)/

/**
 * Folder changes (cd, pushd, popd) and their folder, if given. A plain folder is
 * checked like any path; anything else (none, -, options, quotes) can go anywhere.
 */
const CD = /(?:^|[\s;&|(])(?:cd|pushd|popd)(?:\s+([^\s;&|)]+))?(?=\s|$|[;&|)])/g

/**
 * For project-only mode: the first path a tool request touches outside the
 * project, if any. Looks at the locations the agent declares and at absolute or
 * ~ paths anywhere in the tool's arguments, including shell commands. URLs are
 * not paths (the "/" there follows ":"), so they are ignored. Paths are compared
 * after resolving symlinks, so a link inside the project to a folder outside
 * counts as outside. A shell command that uses .., variables or command
 * substitution counts as outside too, and so does `cd` to a folder outside,
 * to the home folder (bare cd) or back (cd -).
 */
export function outsidePath(projectPath: string, toolCall: acp.ToolCallUpdate): string | undefined {
  const candidates = (toolCall.locations ?? []).map((l) => l.path)
  const scan = (value: unknown, key?: string): string | undefined => {
    if (typeof value === 'string') {
      if (key === 'command') {
        const escape = value.match(SHELL_ESCAPES)
        const found = escape?.slice(1).find(Boolean)
        if (found) return `${found} (the command may leave it)`
        for (const [whole, folder] of value.matchAll(CD)) {
          // With CDPATH set, `cd name` may resolve under another folder.
          const viaCdPath = process.env.CDPATH && folder && !/^\.{0,2}\//.test(folder)
          if (!folder || /^-|["']/.test(folder) || whole.trim().startsWith('popd') || viaCdPath) {
            return `${whole.trim()} (the command may leave it)`
          }
          candidates.push(folder)
        }
      }
      for (const [, path] of value.matchAll(/(?:^|[\s"'=(])((?:~|\/)[^\s"'`;|&<>()]*)/g)) {
        candidates.push(path)
      }
    } else if (value && typeof value === 'object') {
      for (const [k, inner] of Object.entries(value)) {
        const found = scan(inner, k)
        if (found) return found
      }
    }
    return undefined
  }
  const escape = scan(toolCall.rawInput)
  if (escape) return escape
  const root = realPath(projectPath)
  for (const candidate of candidates) {
    if (HARMLESS_PATHS.has(candidate)) continue
    const absolute = realPath(resolvePath(projectPath, candidate.replace(/^~(?=\/|$)/, homedir())))
    const rel = relative(root, absolute)
    if (rel.startsWith('..') || isAbsolute(rel)) return candidate
  }
  return undefined
}

/** A path with symlinks resolved, through its nearest existing folder when it does not exist yet. */
function realPath(path: string): string {
  let existing = path
  const rest: string[] = []
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(basename(existing))
    existing = dirname(existing)
  }
  try {
    return join(realpathSync(existing), ...rest)
  } catch {
    return path
  }
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
