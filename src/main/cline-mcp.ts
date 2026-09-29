import { execFile } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { SERVER_NAME, type BrowserMcpEndpoint } from './browser-mcp'

/**
 * Cline's ACP mode ignores the MCP servers a client passes in session/new and
 * only loads servers from its own settings. So the browser tools are added there
 * with `cline mcp add`. The last registration is remembered, and cline is only
 * called again when the address or token changes; if the user removes the entry
 * in cline, it stays removed.
 */
const recordFile = join(app.getPath('userData'), 'cline-mcp.json')

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('cline', args, { timeout: 60_000 }, (error, _stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve()
    )
  })
}

export async function registerBrowserWithCline(endpoint: BrowserMcpEndpoint): Promise<void> {
  const record = JSON.stringify(endpoint)
  if (existsSync(recordFile) && readFileSync(recordFile, 'utf8') === record) return
  // Replace an entry from an earlier address; it is fine if there is none yet.
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
  // Holds the browser token; owner-only like the endpoint file.
  writeFileSync(recordFile, record, { mode: 0o600 })
  chmodSync(recordFile, 0o600)
}
