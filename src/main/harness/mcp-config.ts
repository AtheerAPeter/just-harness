import { existsSync, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import slugify from '@sindresorhus/slugify'
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'
import { z } from 'zod'
import { clineMcpSettingsPath } from '../cline-mcp'
import type { InvalidServer, McpEntry, OAuthConfig, ProjectSource, Timeouts } from './mcp'

/**
 * The MCP servers each provider's CLI has set up, read the way that CLI reads
 * them, so a server that works in the terminal works in the app. Servers a CLI
 * turns off are left out; entries it could not use either come back as
 * InvalidServer, so the chat can say why.
 */

/** A file's text, or undefined when it does not exist. */
async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const invalid = (name: string, error: string): InvalidServer => ({ name, type: 'invalid', error })

/** One limit for starting a server, listing its tools and each call, as opencode 1 and Cline set it. */
const everyStep = (ms: number): Timeouts => ({ connect: ms, list: ms, call: ms })

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const stringRecord = (value: unknown): Record<string, string> =>
  isObject(value)
    ? Object.fromEntries(
        Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string')
      )
    : {}

// --- opencode ----------------------------------------------------------------

/**
 * opencode's config (https://opencode.ai/docs/config), merged in its order, later
 * files over earlier ones: the global folder's config.json, opencode.json and
 * opencode.jsonc; OPENCODE_CONFIG; opencode.json(c) from the git root down to the
 * project; the .opencode folders and OPENCODE_CONFIG_DIR; OPENCODE_CONFIG_CONTENT;
 * the managed folder. Config served by an organization's account or well-known
 * URL, and macOS managed preferences, are opencode's own sign-in and are not read.
 * Servers the project's own files set up or change are marked `fromProject`.
 * An OAuth redirect that leaves this machine is refused.
 */
export async function opencodeMcpServers(cwd: string): Promise<McpEntry[]> {
  const env = process.env
  const globalDir = join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
  const root = gitRoot(cwd)
  const projectFiles = new Set<string>()
  const files = [
    join(globalDir, 'config.json'),
    join(globalDir, 'opencode.json'),
    join(globalDir, 'opencode.jsonc'),
    ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : [])
  ]
  if (!env.OPENCODE_DISABLE_PROJECT_CONFIG) {
    // Nearest folder last, so it wins; in one folder, .jsonc over .json.
    const found = up(cwd, root, ['opencode.jsonc', 'opencode.json']).reverse()
    for (const file of found) if (isProjectDir(dirname(file))) projectFiles.add(file)
    files.push(...found)
  }
  // As opencode lists them: the project's .opencode folders nearest first, then ~/.opencode.
  const dirs = [
    ...(env.OPENCODE_DISABLE_PROJECT_CONFIG ? [] : up(cwd, root, ['.opencode'])),
    ...up(homedir(), homedir(), ['.opencode']),
    ...(env.OPENCODE_CONFIG_DIR ? [env.OPENCODE_CONFIG_DIR] : [])
  ]
  for (const dir of [...new Set(dirs)]) {
    const inDir = [join(dir, 'opencode.json'), join(dir, 'opencode.jsonc')]
    if (isProjectDir(dirname(dir)) && dir !== env.OPENCODE_CONFIG_DIR) {
      for (const file of inDir) projectFiles.add(file)
    }
    files.push(...inDir)
  }

  let mcp: Record<string, unknown> = {}
  /** The servers a project file set up or changed, with the last such file. */
  const fromProject = new Map<string, ProjectSource>()
  const problems: InvalidServer[] = []
  const merge = async (text: string, source: string, dir: string): Promise<void> => {
    try {
      let config: unknown
      let reads: Map<string, string[]> | undefined
      if (projectFiles.has(source)) {
        ;({ config, reads } = await substituteProject(text, source, dir))
      } else {
        config = parseJsonc(await substitute(text, dir), source)
      }
      if (!isObject(config) || !isObject(config.mcp)) return
      mcp = mergeDeep(mcp, config.mcp)
      if (reads) {
        for (const name of Object.keys(config.mcp)) {
          // Every project file that touched the server counts: an earlier one may have pulled in a secret.
          const earlier = fromProject.get(name)?.reads ?? []
          const now = reads.get(name) ?? []
          fromProject.set(name, { file: source, root, reads: [...new Set([...earlier, ...now])] })
        }
      }
    } catch (error) {
      problems.push(invalid(source, (error as Error).message))
    }
  }
  for (const file of files) {
    const text = await readText(file).catch(() => undefined)
    if (text !== undefined) await merge(text, file, dirname(file))
  }
  if (env.OPENCODE_CONFIG_CONTENT)
    await merge(env.OPENCODE_CONFIG_CONTENT, 'OPENCODE_CONFIG_CONTENT', cwd)
  const managed = '/Library/Application Support/opencode'
  for (const file of ['opencode.json', 'opencode.jsonc'].map((f) => join(managed, f))) {
    const text = await readText(file).catch(() => undefined)
    if (text !== undefined) await merge(text, file, managed)
  }

  const servers = Object.entries(mcp).flatMap(([name, entry]): McpEntry[] => {
    if (!isObject(entry) || entry.enabled === false) return []
    const ms = positiveInt(entry.timeout)
    const timeout = ms ? everyStep(ms) : undefined
    const project = fromProject.has(name) ? { fromProject: fromProject.get(name)! } : {}
    if (entry.type === 'local') {
      const command = Array.isArray(entry.command) ? entry.command : []
      if (command.length === 0 || command.some((part) => typeof part !== 'string')) {
        return [
          invalid(name, '"command" must be a list of strings, the command and its arguments.')
        ]
      }
      return [
        {
          name,
          type: 'stdio',
          command: command[0] as string,
          args: command.slice(1) as string[],
          env: stringRecord(entry.environment),
          cwd: typeof entry.cwd === 'string' ? resolve(cwd, entry.cwd) : cwd,
          ...(timeout ? { timeout } : {}),
          ...project
        }
      ]
    }
    if (entry.type === 'remote') {
      if (typeof entry.url !== 'string') return [invalid(name, '"url" is missing.')]
      const oauth = entry.oauth === false ? false : opencodeOAuth(entry.oauth)
      // The app takes the browser back only on this machine; anywhere else, the sign-in code would go to someone else.
      if (oauth && oauth.redirectUri && !isLoopback(oauth.redirectUri)) {
        return [
          invalid(name, 'oauth.redirectUri must be an http address on 127.0.0.1 or localhost.')
        ]
      }
      return [
        {
          name,
          type: 'http-or-sse',
          url: entry.url,
          headers: stringRecord(entry.headers),
          oauth,
          ...(timeout ? { timeout } : {}),
          ...project
        }
      ]
    }
    // opencode skips entries without a type: a partial entry that only turns a server on or off.
    return []
  })
  return [...problems, ...servers]
}

/**
 * opencode 2's config, in its order, later documents over earlier ones: the
 * global folder's opencode.json and opencode.jsonc (OPENCODE_CONFIG_DIR is that
 * folder when set); OPENCODE_CONFIG; opencode.json and opencode.jsonc in every
 * folder from the filesystem root down to the project; opencode.json and
 * opencode.jsonc in the .opencode folders on that walk, root first;
 * OPENCODE_CONFIG_CONTENT. Config served by an organization's well-known URL or
 * Console account is opencode's own sign-in and is not read.
 *
 * Unlike opencode 1, a later document replaces a server whole instead of
 * merging into it, and an entry that only turns a server on or off is ignored.
 * Servers come in opencode 1's form ("mcp": {name: …}) or opencode 2's own
 * ("mcp": {"servers": {name: …}, "timeout": …}), which `opencode mcp add`
 * writes. Servers the project's own files set up are marked `fromProject`.
 */
export async function opencodeV2McpServers(cwd: string): Promise<McpEntry[]> {
  const env = process.env
  const home = homedir()
  const names = ['opencode.json', 'opencode.jsonc']
  const globalDir = env.OPENCODE_CONFIG_DIR
    ? resolve(env.OPENCODE_CONFIG_DIR)
    : join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode')
  const root = gitRoot(cwd)

  const files = [
    ...names.map((name) => join(globalDir, name)),
    ...(env.OPENCODE_CONFIG ? [resolve(cwd, env.OPENCODE_CONFIG)] : [])
  ]
  const projectFiles = new Set<string>()
  const projectDisabled = /^(1|true)$/i.test(
    env.OPENCODE_CONFIG_PROJECT_DISABLE ?? env.OPENCODE_DISABLE_PROJECT_CONFIG ?? ''
  )
  if (!projectDisabled && realPath(cwd) !== realPath(globalDir)) {
    // The walk skips the global folder and its files, and ~/.claude and ~/.agents.
    const global = new Set(
      [globalDir, join(home, '.claude'), join(home, '.agents'), ...files.slice(0, 2)].map(realPath)
    )
    const visible = (path: string): boolean => !global.has(realPath(path))
    const walk: string[] = []
    for (let dir = resolve(cwd); ; dir = dirname(dir)) {
      walk.unshift(dir)
      if (dirname(dir) === dir) break
    }
    const direct = walk.flatMap((dir) => names.map((name) => join(dir, name)).filter(visible))
    const dotDirs = walk
      .map((dir) => join(dir, '.opencode'))
      .filter((d) => visible(d) && isDirectory(d))
    for (const file of direct) if (isProjectDir(dirname(file))) projectFiles.add(file)
    for (const dir of dotDirs) {
      if (isProjectDir(dirname(dir))) for (const name of names) projectFiles.add(join(dir, name))
    }
    files.push(...direct, ...dotDirs.flatMap((dir) => names.map((name) => join(dir, name))))
  }

  const servers = new Map<string, Record<string, unknown>>()
  /** The servers whose last definition is in a project file, with that file. */
  const fromProject = new Map<string, ProjectSource>()
  /** Global timeouts, merged key by key across documents. */
  const timeouts: V2Timeouts = {}
  const problems = new Map<string, InvalidServer>()
  const load = async (text: string, source: string, dir: string): Promise<void> => {
    let config: unknown
    let reads: Map<string, string[]> | undefined
    try {
      if (projectFiles.has(source)) {
        ;({ config, reads } = await substituteProject(text, source, dir, true))
      } else {
        config = parseJsonc(await substitute(text, dir), source)
      }
    } catch (error) {
      problems.set(source, invalid(source, (error as Error).message))
      return
    }
    if (!isObject(config)) return
    const document = v2Document(config)
    Object.assign(timeouts, document.timeout)
    for (const [name, server] of Object.entries(document.servers)) {
      // opencode drops a server it cannot read; one of that name from an earlier document stays.
      const problem = v2Problem(server)
      if (problem) {
        problems.set(name, invalid(name, `${problem} (in ${source})`))
        continue
      }
      servers.set(name, server as Record<string, unknown>)
      if (reads) fromProject.set(name, { file: source, root, reads: reads.get(name) ?? [] })
      else fromProject.delete(name)
    }
  }
  for (const file of files) {
    const text = await readText(file).catch(() => undefined)
    if (text !== undefined) await load(text, file, dirname(file))
  }
  if (env.OPENCODE_CONFIG_CONTENT)
    await load(env.OPENCODE_CONFIG_CONTENT, 'OPENCODE_CONFIG_CONTENT', cwd)

  const entries = [...servers].flatMap(([name, server]): McpEntry[] => {
    problems.delete(name)
    if (server.disabled === true) return []
    const timeout = v2Timeouts({ ...timeouts, ...v2TimeoutsOf(server.timeout) })
    const project = fromProject.has(name) ? { fromProject: fromProject.get(name)! } : {}
    if (server.type === 'local') {
      const command = server.command as string[]
      return [
        {
          name,
          type: 'stdio',
          command: command[0],
          args: command.slice(1),
          env: stringRecord(server.environment),
          cwd: typeof server.cwd === 'string' ? resolve(cwd, server.cwd) : cwd,
          timeout,
          ...project
        }
      ]
    }
    if (server.type === 'remote') {
      const oauth = server.oauth === false ? false : opencodeV2OAuth(server.oauth)
      if (oauth && oauth.redirectUri && !isLoopback(oauth.redirectUri)) {
        return [
          invalid(name, 'oauth.redirect_uri must be an http address on 127.0.0.1 or localhost.')
        ]
      }
      return [
        {
          name,
          type: 'http-or-sse',
          url: server.url as string,
          headers: stringRecord(server.headers),
          oauth,
          timeout,
          ...project
        }
      ]
    }
    return []
  })
  return [...problems.values(), ...entries]
}

/** Why opencode 2 cannot use a server, or undefined when it can. */
function v2Problem(server: unknown): string | undefined {
  if (!isObject(server)) return 'is not an object'
  if (server.type === 'local') {
    const command = server.command
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      command.some((p) => typeof p !== 'string')
    ) {
      return '"command" must be a list of strings, the command and its arguments'
    }
    return undefined
  }
  if (server.type === 'remote')
    return typeof server.url === 'string' ? undefined : '"url" is missing'
  return '"type" must be "local" or "remote"'
}

/** opencode 2's limits for a server, in milliseconds. */
interface V2Timeouts {
  startup?: number
  catalog?: number
  execution?: number
}

/** opencode 2 lets a tool call run 12 hours unless the config says otherwise (its client.ts). */
const V2_EXECUTION_MS = 12 * 60 * 60_000

const v2Timeouts = (t: V2Timeouts): Timeouts => ({
  ...(t.startup ? { connect: t.startup } : {}),
  ...(t.catalog ? { list: t.catalog } : {}),
  call: t.execution ?? V2_EXECUTION_MS
})

function v2TimeoutsOf(value: unknown): V2Timeouts {
  if (!isObject(value)) return {}
  const startup = positiveInt(value.startup)
  const catalog = positiveInt(value.catalog)
  const execution = positiveInt(value.execution)
  return {
    ...(startup ? { startup } : {}),
    ...(catalog ? { catalog } : {}),
    ...(execution ? { execution } : {})
  }
}

/** A server in opencode 1's form: it says its type. */
const isLegacyServer = (value: unknown): boolean =>
  isObject(value) && (value.type === 'local' || value.type === 'remote')

/**
 * One document's servers in opencode 2's form, as its normalizeMcp reads them:
 * opencode 1 entries are carried over (enabled becomes disabled, a timeout in
 * milliseconds limits listing and calls, OAuth fields become snake_case), and
 * a server in "servers" wins over an opencode 1 entry of the same name.
 */
function v2Document(config: Record<string, unknown>): {
  servers: Record<string, unknown>
  timeout: V2Timeouts
} {
  const timeout: V2Timeouts = {}
  const legacyTimeout = isObject(config.experimental)
    ? positiveInt(config.experimental.mcp_timeout)
    : undefined
  if (legacyTimeout) Object.assign(timeout, { catalog: legacyTimeout, execution: legacyTimeout })
  const legacy: Record<string, unknown> = {}
  const native: Record<string, unknown> = {}
  if (isObject(config.mcp)) {
    for (const [name, value] of Object.entries(config.mcp)) {
      // An entry without a type that only turns a server on or off.
      if (isObject(value) && !('type' in value) && typeof value.enabled === 'boolean') continue
      if (name === 'servers' && !isLegacyServer(value)) {
        if (isObject(value)) Object.assign(native, value)
      } else if (name === 'timeout' && !isLegacyServer(value)) {
        Object.assign(timeout, v2TimeoutsOf(value))
      } else {
        legacy[name] = isObject(value) ? fromV1(value) : value
      }
    }
  }
  return { servers: { ...legacy, ...native }, timeout }
}

/** An opencode 1 server in opencode 2's form, as its ConfigMigrateV1.migrateMcp. */
function fromV1(server: Record<string, unknown>): Record<string, unknown> {
  const { enabled, timeout, oauth, ...rest } = server
  const ms = positiveInt(timeout)
  return {
    ...rest,
    ...(typeof enabled === 'boolean' ? { disabled: !enabled } : {}),
    ...(ms ? { timeout: { catalog: ms, execution: ms } } : {}),
    ...(oauth === undefined
      ? {}
      : {
          oauth: isObject(oauth)
            ? {
                client_id: oauth.clientId,
                client_secret: oauth.clientSecret,
                scope: oauth.scope,
                callback_port: oauth.callbackPort,
                redirect_uri: oauth.redirectUri
              }
            : oauth
        })
  }
}

function opencodeV2OAuth(value: unknown): OAuthConfig {
  if (!isObject(value)) return {}
  const port = positiveInt(value.callback_port)
  const redirectUri =
    typeof value.redirect_uri === 'string'
      ? value.redirect_uri
      : port
        ? `http://127.0.0.1:${port}/callback`
        : undefined
  return {
    ...(typeof value.client_id === 'string' ? { clientId: value.client_id } : {}),
    ...(typeof value.client_secret === 'string' ? { clientSecret: value.client_secret } : {}),
    ...(typeof value.scope === 'string' ? { scope: value.scope } : {}),
    ...(redirectUri ? { redirectUri } : {})
  }
}

function opencodeOAuth(value: unknown): OAuthConfig {
  if (!isObject(value)) return {}
  const port = positiveInt(value.callbackPort)
  const redirectUri =
    typeof value.redirectUri === 'string'
      ? value.redirectUri
      : port
        ? `http://127.0.0.1:${port}/mcp/oauth/callback`
        : undefined
  return {
    ...(typeof value.clientId === 'string' ? { clientId: value.clientId } : {}),
    ...(typeof value.clientSecret === 'string' ? { clientSecret: value.clientSecret } : {}),
    ...(typeof value.scope === 'string' ? { scope: value.scope } : {}),
    ...(redirectUri ? { redirectUri } : {})
  }
}

function isLoopback(uri: string): boolean {
  try {
    const url = new URL(uri)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

const positiveInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined

/**
 * Whether opencode config in this folder is the project's: folders above the
 * home folder are the system's and the home folder itself is the user's
 * (outside a git checkout, opencode looks there too).
 */
function isProjectDir(dir: string): boolean {
  const fromHome = relative(dir, homedir())
  return fromHome !== '' && (fromHome.startsWith('..') || isAbsolute(fromHome))
}

/** The folder the git checkout starts at, where opencode stops looking for project config; / outside git. */
function gitRoot(cwd: string): string {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir
    if (dirname(dir) === dir) return dir
  }
}

/** The targets found in each folder from `start` up to `stop`, nearest first, as opencode's FSUtil.up. */
function up(start: string, stop: string, targets: string[]): string[] {
  const found: string[] = []
  for (let dir = start; ; dir = dirname(dir)) {
    for (const target of targets) if (existsSync(join(dir, target))) found.push(join(dir, target))
    if (dir === stop || dirname(dir) === dir) return found
  }
}

/**
 * opencode's {env:NAME} and {file:path}, replaced in the text before it is
 * parsed. A missing variable is empty; a file's trimmed content goes in as
 * JSON string text; paths are relative to the config's folder; a {file:} on a
 * line commented out with // is left alone.
 */
async function substitute(text: string, dir: string): Promise<string> {
  const withEnv = text.replace(/\{env:([^}]+)\}/g, (_, name: string) => process.env[name] || '')
  let out = ''
  let cursor = 0
  for (const match of withEnv.matchAll(/\{file:[^}]+\}/g)) {
    const index = match.index
    out += withEnv.slice(cursor, index)
    cursor = index + match[0].length
    const line = withEnv.slice(withEnv.lastIndexOf('\n', index - 1) + 1, index).trimStart()
    if (line.startsWith('//')) {
      out += match[0]
      continue
    }
    const full = filePath(match[0], dir)
    const content = await readText(full)
    if (content === undefined)
      throw new Error(`bad file reference: "${match[0]}" ${full} does not exist`)
    out += JSON.stringify(content.trim()).slice(1, -1)
  }
  return out + withEnv.slice(cursor)
}

/** The file a {file:path} names: ~ is the home folder, other relative paths start at the config's folder. */
function filePath(token: string, dir: string): string {
  let path = token.slice('{file:'.length, -1)
  if (path.startsWith('~/')) path = join(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(dir, path)
}

/**
 * A project file's "mcp", with {env:} and {file:} replaced as substitute does,
 * and for each server what its entry pulled in ($NAME for a variable, the path
 * for a file). The user's own files are substituted as text, as opencode does;
 * a project's file is parsed once and substituted inside its strings, keys and
 * values, so what the question says a server pulls in is exactly what lands in
 * it: text substitution also reaches into comments, where a file's content can
 * end one early and turn what was commented out into config. A project file
 * that names a server with a token, or puts one outside a string, is refused.
 */
async function substituteProject(
  text: string,
  source: string,
  dir: string,
  native = false
): Promise<{ config: unknown; reads: Map<string, string[]> }> {
  let config: unknown
  try {
    config = parseJsonc(text, source)
  } catch (error) {
    if (/\{(env|file):/.test(text)) {
      throw new Error(
        `${source} uses {env:} or {file:} outside a string, which a project's config may not do.`
      )
    }
    throw error
  }
  const reads = new Map<string, string[]>()
  if (!isObject(config) || !isObject(config.mcp)) return { config, reads }
  const substituteServer = async (name: string, entry: unknown): Promise<unknown> => {
    if (/\{(env|file):/.test(name)) {
      throw new Error(
        `${source} names an MCP server with {env:} or {file:}, which a project's config may not do.`
      )
    }
    const found = new Set<string>()
    const replace = async (value: string): Promise<string> => {
      const withEnv = value.replace(/\{env:([^}]+)\}/g, (_, variable: string) => {
        found.add(`$${variable}`)
        return process.env[variable] || ''
      })
      let out = ''
      let cursor = 0
      for (const match of withEnv.matchAll(/\{file:[^}]+\}/g)) {
        out += withEnv.slice(cursor, match.index)
        cursor = match.index + match[0].length
        const full = filePath(match[0], dir)
        const content = await readText(full)
        if (content === undefined) {
          throw new Error(`bad file reference: "${match[0]}" ${full} does not exist`)
        }
        found.add(full)
        out += content.trim()
      }
      return out + withEnv.slice(cursor)
    }
    const walk = async (value: unknown): Promise<unknown> => {
      if (typeof value === 'string') return replace(value)
      if (Array.isArray(value)) return Promise.all(value.map(walk))
      if (!isObject(value)) return value
      const out: Record<string, unknown> = {}
      for (const [key, inner] of Object.entries(value)) out[await replace(key)] = await walk(inner)
      return out
    }
    const substituted = await walk(entry)
    reads.set(name, [...found])
    return substituted
  }
  const servers: Record<string, unknown> = {}
  for (const [name, entry] of Object.entries(config.mcp)) {
    // opencode 2's own form keeps the servers in "servers", each named there.
    if (native && name === 'servers' && isObject(entry) && !isLegacyServer(entry)) {
      const inner: Record<string, unknown> = {}
      for (const [innerName, server] of Object.entries(entry)) {
        inner[innerName] = await substituteServer(innerName, server)
      }
      servers[name] = inner
    } else {
      servers[name] = await substituteServer(name, entry)
    }
  }
  return { config: { ...config, mcp: servers }, reads }
}

/** JSON with comments and trailing commas, as opencode parses its config. */
function parseJsonc(text: string, source: string): unknown {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    const first = errors[0]
    const line = text.slice(0, first.offset).split('\n').length
    throw new Error(
      `${source} is not valid JSON: ${printParseErrorCode(first.error)} on line ${line}`
    )
  }
  return value
}

/** remeda's mergeDeep, which opencode merges config with: objects merge key by key, anything else is replaced. */
function mergeDeep(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...target }
  for (const [key, value] of Object.entries(source)) {
    merged[key] =
      isObject(value) && isObject(merged[key])
        ? mergeDeep(merged[key] as Record<string, unknown>, value)
        : value
  }
  return merged
}

// --- Cline -------------------------------------------------------------------

/**
 * Cline's cline_mcp_settings.json, with the schema Cline 3 checks it against
 * (@cline/core, extensions/mcp/config-loader.ts): the nested form, with the
 * address under "transport", and the older flat form, where a URL without a
 * type means SSE. Unknown keys are ignored. Cline keeps its OAuth logins in the
 * same file; the app keeps its own (see mcp-auth.ts).
 */
const clineStdio = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional()
})
const clineUrl = z.object({
  type: z.enum(['sse', 'streamableHttp']),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional()
})
const clineCommon = {
  disabled: z.boolean().optional(),
  timeout: z.unknown().optional(),
  oauthClient: z
    .object({ clientId: z.string().min(1), clientSecret: z.string().min(1).optional() })
    .optional()
}
const clineNested = z.object({
  transport: z.discriminatedUnion('type', [clineStdio, clineUrl]),
  ...clineCommon
})
const clineFlatType = {
  type: z.enum(['stdio', 'sse', 'streamableHttp']).optional(),
  transportType: z.enum(['stdio', 'sse', 'http', 'streamableHttp']).optional()
}
const clineFlatStdio = z.object({ ...clineStdio.shape, ...clineFlatType, ...clineCommon })
const clineFlatUrl = z.object({ ...clineUrl.shape, ...clineFlatType, ...clineCommon })

/** Cline's timeout: seconds, 1 to 3600, 60 when unset or not a number. */
const clineTimeout = (value: unknown): number =>
  1000 *
  (typeof value === 'number' && Number.isFinite(value) ? Math.min(3600, Math.max(1, value)) : 60)

export async function clineMcpServers(cwd: string): Promise<McpEntry[]> {
  const path = clineMcpSettingsPath()
  let settings: unknown
  try {
    const text = await readText(path)
    if (text === undefined) return []
    settings = JSON.parse(text)
  } catch (error) {
    return [invalid(path, `could not be read: ${(error as Error).message}`)]
  }
  const servers = isObject(settings) ? settings.mcpServers : undefined
  if (!isObject(servers)) return []
  return Object.entries(servers).flatMap(([name, entry]): McpEntry[] => {
    const nested = clineNested.safeParse(entry)
    const flatStdio = nested.success ? undefined : clineFlatStdio.safeParse(entry)
    const flatUrl = nested.success || flatStdio?.success ? undefined : clineFlatUrl.safeParse(entry)
    let transport: z.infer<typeof clineStdio> | z.infer<typeof clineUrl>
    let common: { disabled?: boolean; timeout?: unknown; oauthClient?: OAuthConfig }
    if (nested.success) {
      transport = nested.data.transport
      common = nested.data
    } else if (flatStdio?.success) {
      const { type, transportType, disabled, timeout, oauthClient, ...rest } = flatStdio.data
      const declared = type ?? legacyType(transportType)
      if (declared && declared !== 'stdio') {
        return [invalid(name, 'Expected type "stdio" for command-based MCP server')]
      }
      transport = { ...rest, type: 'stdio' }
      common = { disabled, timeout, oauthClient }
    } else if (flatUrl?.success) {
      const { type, transportType, disabled, timeout, oauthClient, ...rest } = flatUrl.data
      const declared = type ?? legacyType(transportType) ?? 'sse'
      if (declared === 'stdio') {
        return [invalid(name, 'Expected type "sse" or "streamableHttp" for URL-based MCP server')]
      }
      transport = { ...rest, type: declared }
      common = { disabled, timeout, oauthClient }
    } else {
      return [invalid(name, `is not a valid entry in ${path}`)]
    }
    if (common.disabled === true) return []
    const timeout = everyStep(clineTimeout(common.timeout))
    if (transport.type === 'stdio') {
      return [
        {
          name,
          type: 'stdio',
          command: transport.command,
          args: transport.args ?? [],
          env: transport.env ?? {},
          cwd: transport.cwd ? resolve(cwd, transport.cwd) : cwd,
          timeout
        }
      ]
    }
    return [
      {
        name,
        type: transport.type === 'sse' ? 'sse' : 'http',
        url: transport.url,
        headers: transport.headers ?? {},
        oauth: common.oauthClient ?? {},
        timeout
      }
    ]
  })
}

const legacyType = (
  transportType: 'stdio' | 'sse' | 'http' | 'streamableHttp' | undefined
): 'stdio' | 'sse' | 'streamableHttp' | undefined =>
  transportType === 'http' ? 'streamableHttp' : transportType

// --- Command Code ------------------------------------------------------------

/**
 * Command Code's servers (https://commandcode.ai/docs/mcp), in the order it
 * loads them, a later entry replacing an earlier one of the same name:
 * settings.json's mcp.servers, ~/.commandcode/mcp.json and .mcp.json, the
 * project's .mcp.json, and the project's local ~/.commandcode/projects/<slug>/mcp.json.
 * Command Code reads a project's servers only once the user has trusted the
 * folder, which creates its projects/<slug> folder; until then the project's
 * shared .mcp.json, which comes with the code, is not read here either.
 */
export async function commandCodeMcpServers(cwd: string): Promise<McpEntry[]> {
  const home = join(homedir(), '.commandcode')
  const slug = slugify(realPath(cwd))
  const projectDir = join(home, 'projects', ...(slug ? [slug] : []))
  const trusted = slug ? isDirectory(projectDir) : true

  const entries = new Map<string, McpEntry | null>()
  const problems: InvalidServer[] = []
  const add = (name: string, entry: unknown): void => {
    entries.delete(name)
    entries.set(name, commandCodeEntry(name, entry, cwd))
  }
  const settingsFile = join(home, 'settings.json')
  const files = [
    join(home, 'mcp.json'),
    join(home, '.mcp.json'),
    ...(trusted ? [join(cwd, '.mcp.json')] : []),
    join(projectDir, 'mcp.json')
  ]
  for (const file of [settingsFile, ...files]) {
    let config: unknown
    try {
      const text = await readText(file)
      if (text === undefined) continue
      config = JSON.parse(text)
    } catch (error) {
      problems.push(invalid(file, `could not be read: ${(error as Error).message}`))
      continue
    }
    if (!isObject(config)) continue
    if (file === settingsFile) {
      const servers = isObject(config.mcp) ? config.mcp.servers : undefined
      if (Array.isArray(servers)) {
        for (const server of servers) {
          if (isObject(server) && typeof server.name === 'string') add(server.name, server)
        }
      }
    } else if (isObject(config.mcpServers)) {
      for (const [name, entry] of Object.entries(config.mcpServers)) add(name, entry)
    }
  }
  return [...problems, ...[...entries.values()].filter((e): e is McpEntry => e !== null)]
}

/** One Command Code entry; null when it is turned off. */
function commandCodeEntry(name: string, entry: unknown, cwd: string): McpEntry | null {
  if (!isObject(entry)) return invalid(name, 'is not an object.')
  if (entry.enabled === false) return null
  const declared = entry.transport ?? entry.type
  const transport =
    typeof declared === 'string'
      ? declared.toLowerCase()
      : typeof entry.url === 'string' && typeof entry.command !== 'string'
        ? 'http'
        : 'stdio'
  try {
    if (transport === 'stdio') {
      if (typeof entry.command !== 'string' || !entry.command) {
        return invalid(name, '"command" is missing.')
      }
      return {
        name,
        type: 'stdio',
        command: entry.command,
        args: Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === 'string') : [],
        env: expandAll('env', stringRecord(entry.env)),
        // Command Code starts servers in the folder it runs in: the project.
        cwd
      }
    }
    // Command Code reaches "sse" servers over Streamable HTTP too.
    if (transport === 'http' || transport === 'sse') {
      if (typeof entry.url !== 'string') return invalid(name, '"url" is missing.')
      const oauth = isObject(entry.oauth) ? entry.oauth : {}
      return {
        name,
        type: 'http',
        url: entry.url,
        headers: expandAll('header', stringRecord(entry.headers)),
        oauth: {
          ...(typeof oauth.clientId === 'string' ? { clientId: oauth.clientId } : {}),
          ...(typeof oauth.clientSecret === 'string' ? { clientSecret: oauth.clientSecret } : {}),
          ...(typeof oauth.scope === 'string' ? { scope: oauth.scope } : {})
        }
      }
    }
    return invalid(name, `has an unknown transport "${String(declared)}".`)
  } catch (error) {
    return invalid(name, (error as Error).message)
  }
}

/**
 * Command Code's ${NAME} and ${NAME:-default} in env values and headers: the
 * default stands in for a variable that is unset or empty, $${NAME} is the
 * text ${NAME}, and an unset variable without a default is an error.
 */
function expandAll(kind: 'env' | 'header', values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value.replace(
        /(\$?)\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
        (whole, escaped: string, variable: string, fallback: string | undefined) => {
          if (escaped) return whole.slice(1)
          const set = process.env[variable]
          if (set !== undefined && !(set === '' && fallback !== undefined)) return set
          if (fallback !== undefined) return fallback
          throw new Error(
            `${kind} "${key}" references \${${variable}} but ${variable} is not set in the app's environment.`
          )
        }
      )
    ])
  )
}

function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
