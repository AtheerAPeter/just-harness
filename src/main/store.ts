import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppState, Chat, ChatItem, Project, Theme } from '../shared/types'
import { cleanStoredOutput } from './tool-output'
import { chatPreview } from './preview'

const dataDir = join(app.getPath('userData'), 'data')
const chatsDir = join(dataDir, 'chats')
const statePath = join(dataDir, 'state.json')

mkdirSync(chatsDir, { recursive: true })

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** Write via a temp file so a crash mid-write never leaves a truncated file. */
function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value))
  renameSync(tmp, path)
}

const state: AppState = readJson<AppState>(statePath, { projects: [], chats: [] })
for (const chat of state.chats) {
  // Nothing can be running or waiting right after launch.
  chat.running = false
  chat.waiting = false
  // Chats from before sidebar previews get theirs once; it is saved from then on.
  chat.preview ??= chatPreview(readJson<ChatItem[]>(join(chatsDir, `${chat.id}.json`), []))
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
    items = readJson<ChatItem[]>(join(chatsDir, `${chatId}.json`), [])
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
