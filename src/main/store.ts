import { app, dialog, type BrowserWindow } from 'electron'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { AppState, Chat, ChatItem, Project, Theme } from '../shared/types'
import { cleanStoredOutput } from './tool-output'
import { chatPreview } from './preview'

const dataDir = join(app.getPath('userData'), 'data')
const chatsDir = join(dataDir, 'chats')
const statePath = join(dataDir, 'state.json')

mkdirSync(chatsDir, { recursive: true })

/** A file's JSON, or `damaged` when it exists but cannot be parsed. */
type Read<T> = { value: T } | { damaged: string }

function readJson<T>(path: string, fallback: T): Read<T> {
  if (!existsSync(path)) return { value: fallback }
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) as T }
  } catch (error) {
    return { damaged: (error as Error).message }
  }
}

/**
 * Move a file that cannot be read out of the way, next to where it was, so it
 * is not overwritten and can still be recovered by hand. Returns where it went.
 */
function keepDamaged(path: string, reason: string): string {
  const kept = `${path}.damaged-${Date.now()}`
  renameSync(path, kept)
  console.error(`${path} could not be read (${reason}); it was moved to ${kept}.`)
  return kept
}

/**
 * Write via a temp file so a crash mid-write never leaves a truncated file;
 * synced before the rename so a power loss cannot leave an empty one.
 */
function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, JSON.stringify(value))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

/** Where a damaged state file was moved at launch, for telling the user once the window is up. */
let damagedState: string | undefined

const state = loadState()

/** The saved state; without it the app would not start, so a damaged file is set aside. */
function loadState(): AppState {
  const read = readJson<AppState>(statePath, { projects: [], chats: [] })
  if ('value' in read) return read.value
  damagedState = keepDamaged(statePath, read.damaged)
  return { projects: [], chats: [] }
}

/** Say that the saved projects and chats could not be read, if so (see loadState). */
export function reportDamagedState(window: BrowserWindow): void {
  if (!damagedState) return
  void dialog.showMessageBox(window, {
    type: 'warning',
    message: 'Just Harness could not read its saved projects and chats',
    detail: `The file was damaged, so the app started without them. The damaged file was kept at:\n\n${damagedState}\n\nEach chat's messages are stored separately and were not touched.`
  })
  damagedState = undefined
}

for (const chat of state.chats) {
  // Nothing can be running or waiting right after launch.
  chat.running = false
  chat.waiting = false
  // Chats from before sidebar previews get theirs once; it is saved from then on.
  if (chat.preview === undefined) {
    const read = readJson<ChatItem[]>(join(chatsDir, `${chat.id}.json`), [])
    chat.preview = 'value' in read ? chatPreview(read.value) : ''
  }
  // Before tabs, a chat's browser kept one page.
  const legacy = chat as Chat & { browserUrl?: string }
  if (legacy.browserUrl) {
    chat.browserTabs ??= { urls: [legacy.browserUrl], active: 0 }
    delete legacy.browserUrl
  }
}

const messages = new Map<string, ChatItem[]>()
const dirtyChats = new Set<string>()
let flushTimer: NodeJS.Timeout | undefined

function scheduleFlush(): void {
  flushTimer ??= setTimeout(flush, 500)
}

export function flush(): void {
  clearTimeout(flushTimer)
  flushTimer = undefined
  writeJson(statePath, state)
  for (const chatId of dirtyChats) {
    const items = messages.get(chatId)
    if (items) writeJson(join(chatsDir, `${chatId}.json`), items)
  }
  dirtyChats.clear()
}

export function getState(): AppState {
  return state
}

export function setTheme(theme: Theme): void {
  state.theme = theme
  scheduleFlush()
}

export function addProject(project: Project): void {
  state.projects.push(project)
  scheduleFlush()
}

export function removeProject(projectId: string): void {
  for (const chat of state.chats.filter((c) => c.projectId === projectId)) removeChat(chat.id)
  state.projects = state.projects.filter((p) => p.id !== projectId)
  scheduleFlush()
}

export function getProject(projectId: string): Project {
  const project = state.projects.find((p) => p.id === projectId)
  if (!project) throw new Error(`Unknown project ${projectId}`)
  return project
}

export function addChat(chat: Chat): void {
  state.chats.push(chat)
  messages.set(chat.id, [])
  dirtyChats.add(chat.id)
  scheduleFlush()
}

export function getChat(chatId: string): Chat {
  const chat = state.chats.find((c) => c.id === chatId)
  if (!chat) throw new Error(`Unknown chat ${chatId}`)
  return chat
}

export function updateChat(chatId: string, patch: Partial<Chat>): Chat {
  const chat = getChat(chatId)
  Object.assign(chat, patch)
  scheduleFlush()
  return chat
}

export function removeChat(chatId: string): void {
  state.chats = state.chats.filter((c) => c.id !== chatId)
  messages.delete(chatId)
  dirtyChats.delete(chatId)
  rmSync(join(chatsDir, `${chatId}.json`), { force: true })
  scheduleFlush()
}

export function getMessages(chatId: string): ChatItem[] {
  let items = messages.get(chatId)
  if (!items) {
    const path = join(chatsDir, `${chatId}.json`)
    const read = readJson<ChatItem[]>(path, [])
    if ('value' in read) {
      items = read.value
    } else {
      // The chat stays usable; what it showed before is kept aside, and the chat says so.
      const kept = keepDamaged(path, read.damaged)
      items = [
        {
          kind: 'error',
          id: crypto.randomUUID(),
          text: `This chat's earlier messages could not be read, so they are not shown. The damaged file was kept at ${kept}.`
        }
      ]
      dirtyChats.add(chatId)
      scheduleFlush()
    }
    for (const item of items) {
      // A permission prompt cannot survive a restart: the agent process that asked is gone.
      if (item.kind === 'permission' && !item.resolved) item.resolved = 'cancelled'
      // Nor a tool call that was still running when the app quit.
      if (item.kind === 'tool' && (item.status === 'pending' || item.status === 'in_progress')) {
        item.status = 'interrupted'
      }
      // Earlier versions kept tool output whole, screenshots included; slim it once.
      if (item.kind === 'tool' && item.output) {
        const output = cleanStoredOutput(item.output)
        if (output !== item.output) {
          item.output = output
          dirtyChats.add(chatId)
          scheduleFlush()
        }
      }
    }
    messages.set(chatId, items)
  }
  return items
}

/** Insert or replace an item by id. Returns the stored item. */
export function upsertItem(chatId: string, item: ChatItem): ChatItem {
  const items = getMessages(chatId)
  const index = items.findIndex((i) => i.id === item.id)
  if (index === -1) items.push(item)
  else items[index] = item
  dirtyChats.add(chatId)
  scheduleFlush()
  return item
}

export function findItem(chatId: string, itemId: string): ChatItem | undefined {
  return getMessages(chatId).find((i) => i.id === itemId)
}

export function lastItem(chatId: string): ChatItem | undefined {
  const items = getMessages(chatId)
  return items[items.length - 1]
}
