import { existsSync, realpathSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import slugify from '@sindresorhus/slugify'
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'
import { z } from 'zod'
import { clineMcpSettingsPath } from '../cline-mcp'
import type { InvalidServer, McpEntry, OAuthConfig } from './mcp'

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
 */
export async function opencodeMcpServers(cwd: string): Promise<McpEntry[]> {
  const env = process.env
  const globalDir = join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
  const root = gitRoot(cwd)
  const files = [
    join(globalDir, 'config.json'),
    join(globalDir, 'opencode.json'),
    join(globalDir, 'opencode.jsonc'),
    ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : [])
  ]
  if (!env.OPENCODE_DISABLE_PROJECT_CONFIG) {
    // Nearest folder last, so it wins; in one folder, .jsonc over .json.
    files.push(...up(cwd, root, ['opencode.jsonc', 'opencode.json']).reverse())
  }
  // As opencode lists them: the project's .opencode folders nearest first, then ~/.opencode.
  const dirs = [
    ...(env.OPENCODE_DISABLE_PROJECT_CONFIG ? [] : up(cwd, root, ['.opencode'])),
    ...up(homedir(), homedir(), ['.opencode']),
    ...(env.OPENCODE_CONFIG_DIR ? [env.OPENCODE_CONFIG_DIR] : [])
  ]
  for (const dir of [...new Set(dirs)]) {
    files.push(join(dir, 'opencode.json'), join(dir, 'opencode.jsonc'))
  }

  let mcp: Record<string, unknown> = {}
  const problems: InvalidServer[] = []
  const merge = async (text: string, source: string, dir: string): Promise<void> => {
    try {
      const config = parseJsonc(await substitute(text, dir), source)
      if (isObject(config) && isObject(config.mcp)) mcp = mergeDeep(mcp, config.mcp)
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
    const timeout = positiveInt(entry.timeout)
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
          ...(timeout ? { timeout } : {})
        }
      ]
    }
    if (entry.type === 'remote') {
      if (typeof entry.url !== 'string') return [invalid(name, '"url" is missing.')]
      return [
        {
          name,
          type: 'http-or-sse',
          url: entry.url,
          headers: stringRecord(entry.headers),
          oauth: entry.oauth === false ? false : opencodeOAuth(entry.oauth),
          ...(timeout ? { timeout } : {})
        }
      ]
    }
    // opencode skips entries without a type: a partial entry that only turns a server on or off.
    return []
  })
  return [...problems, ...servers]
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

const positiveInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined

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
    let path = match[0].slice('{file:'.length, -1)
    if (path.startsWith('~/')) path = join(homedir(), path.slice(2))
    const full = isAbsolute(path) ? path : resolve(dir, path)
    const content = await readText(full)
    if (content === undefined)
      throw new Error(`bad file reference: "${match[0]}" ${full} does not exist`)
    out += JSON.stringify(content.trim()).slice(1, -1)
  }
  return out + withEnv.slice(cursor)
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
    const timeout = clineTimeout(common.timeout)
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
