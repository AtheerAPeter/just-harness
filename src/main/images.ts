import { app, nativeImage, net, protocol } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IMAGE_SCHEME } from '../shared/types'

/**
 * Images shown in chats: sent with the user's messages, returned by tools
 * (browser screenshots, images a tool read) or sent by the agent. Chat files
 * keep only their names; each chat's images live in images/<chatId>/, named
 * by a hash of their contents, so an image sent again is stored once. The
 * window loads them as chat-image://<chatId>/<file>.
 */
const imagesDir = join(app.getPath('userData'), 'images')

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

/** Larger images are not kept for the chat. */
const MAX_IMAGE = 15 * 1024 * 1024

const CHAT_ID = /^[0-9a-f-]{36}$/
const FILE = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/

/** Writes still in progress, by path: a request for one waits for it. */
const writing = new Map<string, Promise<void>>()

/**
 * Save an image for a chat and return its file name, or undefined for a type
 * the window cannot show or an image over MAX_IMAGE. Returns at once; the
 * write finishes in the background.
 */
export function saveImage(chatId: string, mimeType: string, data: Buffer): string | undefined {
  const ext = EXTENSIONS[mimeType]
  if (!ext || data.length === 0 || data.length > MAX_IMAGE) return undefined
  const file = `${createHash('sha256').update(data).digest('hex')}.${ext}`
  const dir = join(imagesDir, chatId)
  const path = join(dir, file)
  if (!writing.has(path) && !existsSync(path)) {
    const done = mkdir(dir, { recursive: true })
      .then(() => writeFile(path, data))
      .catch((error) => console.error(`Could not save an image of chat ${chatId}:`, error))
      .finally(() => writing.delete(path))
    writing.set(path, done)
  }
  return file
}

/** Save an image file for a chat, as saveImage does; undefined when it cannot be read. */
export async function saveImageFile(
  chatId: string,
  mimeType: string,
  path: string
): Promise<string | undefined> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_IMAGE) return undefined
    return saveImage(chatId, mimeType, await readFile(path))
  } catch {
    return undefined
  }
}

/** Save images given as base64, as tools and agents send them; returns the names of those kept. */
export function saveImages(chatId: string, images: { mimeType: string; data: string }[]): string[] {
  const files = images.flatMap((image) => {
    const file = saveImage(chatId, image.mimeType, Buffer.from(image.data, 'base64'))
    return file ? [file] : []
  })
  return [...new Set(files)]
}

export function removeChatImages(chatId: string): void {
  rmSync(join(imagesDir, chatId), { recursive: true, force: true })
}

/** Must run before the app is ready. */
export function registerImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true } }
  ])
}

/** Serve chat images to the window. Only its session has the scheme; the browser panel's pages do not. */
export function handleImageRequests(): void {
  protocol.handle(IMAGE_SCHEME, async (request) => {
    const { host, pathname } = new URL(request.url)
    const file = pathname.slice(1)
    if (!CHAT_ID.test(host) || !FILE.test(file)) return new Response(null, { status: 404 })
    const path = join(imagesDir, host, file)
    await writing.get(path)
    return net.fetch(pathToFileURL(path).href)
  })
}

/** A small preview of an image file on disk, as a data URL; null when it cannot be read. */
export async function thumbnail(path: string): Promise<string | null> {
  try {
    const image = await nativeImage.createThumbnailFromPath(path, { width: 96, height: 96 })
    return image.isEmpty() ? null : image.toDataURL()
  } catch {
    return null
  }
}
