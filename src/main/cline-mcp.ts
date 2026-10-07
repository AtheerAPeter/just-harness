import { execFile } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { SERVER_NAME, type BrowserMcpEndpoint } from './browser-mcp'
import { loadShellPath } from './shell-env'

/**
 * Cline's ACP mode ignores the MCP servers a client passes in session/new and
 * only loads servers from its own settings. So the browser tools are added there
 * with `cline mcp add`. The last registration is remembered, and cline's own
 * settings are checked against it at launch: an entry another copy of the app
 * pointed at its own address is put back, and an entry the user removed in
 * cline stays removed.
 */
const recordFile = join(app.getPath('userData'), 'cline-mcp.json')

async function run(args: string[]): Promise<void> {
  await loadShellPath()
  return new Promise((resolve, reject) => {
    execFile('cline', args, { timeout: 60_000 }, (error, _stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve()
    )
  })
}

/**
 * Where cline keeps its MCP servers, found as cline 3 finds it:
 * CLINE_MCP_SETTINGS_PATH, else <data dir>/settings/cline_mcp_settings.json,
 * where the data dir is CLINE_DATA_DIR, else CLINE_DIR/data, else ~/.cline/data.
 * The app runs cline with its own environment, so this is the file that cline uses.
 */
function clineMcpSettingsPath(): string {
  const env = process.env
  const settings = env.CLINE_MCP_SETTINGS_PATH?.trim()
  if (settings) return settings
  const clineDir = env.CLINE_DIR?.trim() || join(homedir(), '.cline')
  const dataDir = env.CLINE_DATA_DIR?.trim() || join(clineDir, 'data')
  return join(dataDir, 'settings', 'cline_mcp_settings.json')
}

/** The browser's entry in cline's settings: missing, its address and auth, or unreadable. */
type ClineEntry = 'missing' | 'unknown' | { url?: unknown; authorization?: unknown }

function clineEntry(): ClineEntry {
  let settings: unknown
  try {
    settings = JSON.parse(readFileSync(clineMcpSettingsPath(), 'utf8'))
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown'
  }
  const servers = (settings as { mcpServers?: Record<string, unknown> })?.mcpServers
  if (!servers || typeof servers !== 'object') return 'unknown'
  const entry = servers[SERVER_NAME] as
    { transport?: { url?: unknown; headers?: Record<string, unknown> } } | undefined
  if (!entry) return 'missing'
  // Cline 3 nests the address under "transport".
  const transport = entry.transport
  if (!transport) return 'unknown'
  return { url: transport.url, authorization: transport.headers?.Authorization }
}

export async function registerBrowserWithCline(endpoint: BrowserMcpEndpoint): Promise<void> {
  const record = JSON.stringify(endpoint)
  const recorded = existsSync(recordFile) && readFileSync(recordFile, 'utf8') === record
  const entry = clineEntry()
  if (typeof entry === 'object') {
    const ours = entry.url === endpoint.url && entry.authorization === `Bearer ${endpoint.token}`
    if (ours) {
      if (!recorded) remember(record)
      return
    }
    // Otherwise the entry points elsewhere: an earlier address of this app, or
    // another copy of it (a second profile, a development build) took it over.
  } else if (recorded) {
    // Removed in cline after the app added it, or cline's settings could not be
    // read: either way, as the user or cline left it.
    return
  }
  // Replace an entry from another address; it is fine if there is none yet.
  await run(['mcp', 'remove', SERVER_NAME]).catch(() => undefined)
  await run([
    'mcp',
    'add',
    SERVER_NAME,
    '--transport',
    'http',
    '--header',
    `Authorization: Bearer ${endpoint.token}`,
    '--yes',
    endpoint.url
  ])
  remember(record)
}

/** Note the registration. It holds the browser token, so only the user may read it. */
function remember(record: string): void {
  writeFileSync(recordFile, record, { mode: 0o600 })
  chmodSync(recordFile, 0o600)
}
