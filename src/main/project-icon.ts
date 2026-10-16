import { dialog, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { listProjectFiles } from './files'

const NAMES = ['favicon', 'icon', 'apple-touch-icon']
/** Found icons by preference; a custom icon may also be a JPEG. */
const FOUND_TYPES = ['svg', 'png', 'ico']
const MIME: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg'
}
const CUSTOM_TYPES = ['png', 'svg', 'jpg', 'jpeg']
/** Larger files found in a project are not icons worth showing in a sidebar row. */
const MAX_SIZE = 512 * 1024

/** The icon the user chose for a project, kept in the project itself. */
const customIcon = (projectPath: string, type: string): string =>
  join(projectPath, '.just-harness', `icon.${type}`)

const found = new Map<string, Promise<string | null>>()

/**
 * The project's icon as a data URL, best effort: the custom icon the user
 * chose, else the shallowest favicon, icon or apple-touch-icon image in the
 * project, or null when it has none. Looked up once per project while the app runs.
 */
export function projectIcon(projectPath: string): Promise<string | null> {
  let icon = found.get(projectPath)
  if (!icon) {
    icon = findIcon(projectPath).catch(() => null)
    found.set(projectPath, icon)
  }
  return icon
}

/**
 * Let the user choose an image and save it as the project's custom icon. Returns
 * the new icon, or undefined when the user cancelled.
 */
export async function chooseProjectIcon(
  window: BrowserWindow,
  projectPath: string
): Promise<string | null | undefined> {
  const result = await dialog.showOpenDialog(window, {
    properties: ['openFile'],
    buttonLabel: 'Use as icon',
    filters: [{ name: 'Images', extensions: CUSTOM_TYPES }]
  })
  const source = result.filePaths[0]
  if (result.canceled || !source) return undefined
  const type = extname(source).slice(1).toLowerCase()
  await mkdir(join(projectPath, '.just-harness'), { recursive: true })
  for (const other of CUSTOM_TYPES) await rm(customIcon(projectPath, other), { force: true })
  await copyFile(source, customIcon(projectPath, type))
  found.delete(projectPath)
  return projectIcon(projectPath)
}

async function findIcon(projectPath: string): Promise<string | null> {
  const custom = CUSTOM_TYPES.find((type) => existsSync(customIcon(projectPath, type)))
  if (custom) return dataUrl(customIcon(projectPath, custom), custom)

  const pathspecs = NAMES.map((name) => `:(glob,icase)**/${name}.*`)
  const candidates = (await listProjectFiles(projectPath, pathspecs))
    .map((path) => {
      const match = /(?:^|\/)([^/]+)\.(svg|png|ico)$/i.exec(path)
      const name = NAMES.indexOf(match?.[1].toLowerCase() ?? '')
      if (!match || name === -1) return undefined
      const type = match[2].toLowerCase()
      return { path, type, rank: [path.split('/').length, name, FOUND_TYPES.indexOf(type)] }
    })
    .filter((c) => c !== undefined)
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2])
  for (const { path, type } of candidates) {
    const file = join(projectPath, path)
    if ((await stat(file)).size > MAX_SIZE) continue
    return dataUrl(file, type)
  }
  return null
}

async function dataUrl(file: string, type: string): Promise<string> {
  return `data:${MIME[type]};base64,${(await readFile(file)).toString('base64')}`
}
