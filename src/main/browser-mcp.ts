import { createServer, type IncomingMessage, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { app, clipboard, ClipboardItem, nativeImage, type WebContents } from 'electron'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk'
import { z } from 'zod'
import { normalizeUrl, type BuiltinBrowser } from './browser'

/**
 * An MCP server that drives the built-in browser, on loopback HTTP guarded by a
 * bearer token. The port and token are kept between launches so agents that
 * register it in their own config (cline) keep a working address.
 */

/**
 * Distinct from "browser" on purpose: opencode ships a built-in tool by that
 * name, and agents confuse the two.
 */
export const SERVER_NAME = 'harness_browser'
/**
 * Sent to the model with the tool list. Agents also ship their own browser
 * tools (opencode has one named `browser`), so say plainly which one to use.
 */
export const BROWSER_GUIDANCE =
  "These tools control the browser panel inside the user's Just Harness app. The user can watch it, " +
  'and it is signed in to their accounts. For any web browsing or browser automation, use these tools ' +
  'instead of any other browser tool (built-in browser tools, Playwright, Puppeteer, computer use, or ' +
  'opening the system browser), unless the user explicitly asks for a different browser. Start with ' +
  'navigate or snapshot, then use the element refs from the snapshot for click and type.'

const endpointFile = join(app.getPath('userData'), 'browser-mcp.json')

export interface BrowserMcpEndpoint {
  url: string
  token: string
}

let endpoint: BrowserMcpEndpoint | undefined

function readSaved(): { port: number; token: string } | undefined {
  if (!existsSync(endpointFile)) return undefined
  return JSON.parse(readFileSync(endpointFile, 'utf8'))
}

function listen(http: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    http.once('error', reject)
    http.listen(port, '127.0.0.1', () => {
      http.off('error', reject)
      resolve((http.address() as AddressInfo).port)
    })
  })
}

/** Injected into the page: tags visible interactive elements with refs and returns an outline. */
const SNAPSHOT_SCRIPT = `(() => {
  const selector = 'a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=option], [contenteditable=true], [onclick]';
  document.querySelectorAll('[data-harness-ref]').forEach((el) => el.removeAttribute('data-harness-ref'));
  const lines = [];
  let ref = 0;
  for (const el of document.querySelectorAll(selector)) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
    ref += 1;
    el.setAttribute('data-harness-ref', String(ref));
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    const role = el.getAttribute('role');
    const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const value = 'value' in el && el.value && type !== 'password' ? ' value="' + String(el.value).slice(0, 60) + '"' : '';
    const href = tag === 'a' ? ' -> ' + el.getAttribute('href').slice(0, 100) : '';
    lines.push('[' + ref + '] ' + tag + (type ? '[' + type + ']' : '') + (role ? '(' + role + ')' : '') + ' "' + label + '"' + value + href);
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000);
  return 'URL: ' + location.href + '\\nTitle: ' + document.title + '\\n\\n## Page text\\n' + text + '\\n\\n## Interactive elements\\n' + lines.slice(0, 400).join('\\n');
})()`

function locateScript(ref: number): string {
  return `(() => {
    const el = document.querySelector('[data-harness-ref="${ref}"]');
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`
}

const text = (value: string): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: value }]
})

async function settle(page: WebContents): Promise<void> {
  // Give a click or key press time to start a navigation, then wait for it to finish.
  await new Promise((resolve) => setTimeout(resolve, 400))
  const deadline = Date.now() + 15_000
  while (page.isLoading() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * Put files into a page's upload control without the native file picker, which
 * an agent cannot operate. While the agent clicks the upload button, the page's
 * file-chooser request is intercepted over the DevTools protocol and answered
 * with the files; interception is switched off again right after, so the user's
 * own clicks still open the normal macOS picker.
 */
async function uploadFiles(page: WebContents, ref: number, paths: string[]): Promise<void> {
  const files = paths.map((path) => resolve(path.replace(/^~(?=\/|$)/, homedir())))
  const missing = files.filter((file) => !existsSync(file))
  if (missing.length) throw new Error(`File not found: ${missing.join(', ')}`)

  const cdp = page.debugger
  const attachedHere = !cdp.isAttached()
  if (attachedHere) cdp.attach('1.3')
  try {
    await cdp.sendCommand('Page.enable')
    await cdp.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
    const chooser = new Promise<number | undefined>((done) => {
      const timer = setTimeout(() => {
        cdp.off('message', onMessage)
        done(undefined)
      }, 3000)
      function onMessage(
        _event: unknown,
        method: string,
        params: { backendNodeId?: number }
      ): void {
        if (method !== 'Page.fileChooserOpened') return
        clearTimeout(timer)
        cdp.off('message', onMessage)
        done(params.backendNodeId)
      }
      cdp.on('message', onMessage)
    })
    await clickRef(page, ref)
    let backendNodeId = await chooser
    if (backendNodeId === undefined) {
      // No chooser opened: the ref may be the <input type=file> itself or sit next to one.
      const { root } = (await cdp.sendCommand('DOM.getDocument', { depth: 0 })) as {
        root: { nodeId: number }
      }
      const { nodeId } = (await cdp.sendCommand('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: `[data-harness-ref="${ref}"] input[type=file], input[type=file][data-harness-ref="${ref}"], input[type=file]`
      })) as { nodeId: number }
      if (!nodeId) throw new Error("No file upload control found. Click the upload button's ref.")
      ;({
        node: { backendNodeId }
      } = (await cdp.sendCommand('DOM.describeNode', { nodeId })) as {
        node: { backendNodeId: number }
      })
    }
    await cdp.sendCommand('DOM.setFileInputFiles', { files, backendNodeId })
  } finally {
    await cdp
      .sendCommand('Page.setInterceptFileChooserDialog', { enabled: false })
      .catch(() => undefined)
    if (attachedHere) cdp.detach()
  }
}

/**
 * PNG of the visible part of a page, as base64. Pages of background chats are
 * hidden and have no frame to copy, so capture through the DevTools protocol,
 * which renders one on request.
 */
async function screenshot(page: WebContents): Promise<string> {
  const cdp = page.debugger
  const attachedHere = !cdp.isAttached()
  if (attachedHere) cdp.attach('1.3')
  try {
    const { data } = (await cdp.sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true
    })) as { data: string }
    return data
  } finally {
    if (attachedHere) cdp.detach()
  }
}

async function clickRef(page: WebContents, ref: number): Promise<void> {
  const point = (await page.executeJavaScript(locateScript(ref))) as {
    x: number
    y: number
  } | null
  if (!point)
    throw new Error(
      `No element with ref ${ref}. Take a new snapshot; refs change when the page does.`
    )
  const x = Math.round(point.x)
  const y = Math.round(point.y)
  // Real input events, so pages see trusted clicks rather than synthetic ones.
  page.sendInputEvent({ type: 'mouseMove', x, y })
  page.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  page.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
}

type Modifier = 'cmd' | 'shift' | 'alt' | 'ctrl'
const MODIFIERS: Record<Modifier, 'meta' | 'shift' | 'alt' | 'control'> = {
  cmd: 'meta',
  shift: 'shift',
  alt: 'alt',
  ctrl: 'control'
}

function pressKey(contents: WebContents, key: string, modifiers: Modifier[] = []): void {
  // Editing shortcuts are menu commands on macOS; synthetic key events never reach
  // the menu, so run the command itself.
  if (modifiers.length === 1 && modifiers[0] === 'cmd' && key.length === 1) {
    const command = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo' }[
      key.toLowerCase()
    ]
    if (command) {
      contents[command as 'selectAll' | 'copy' | 'paste' | 'cut' | 'undo']()
      return
    }
  }
  const mods = modifiers.map((m) => MODIFIERS[m])
  contents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods })
  if (mods.length === 0 && (key.length === 1 || key === 'Enter')) {
    contents.sendInputEvent({ type: 'char', keyCode: key === 'Enter' ? '\r' : key })
  }
  contents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods })
}

/**
 * Paste an image into the focused element, the way a user would with ⌘V. The
 * user's clipboard is put back afterwards.
 */
async function pasteImage(page: WebContents, path: string): Promise<void> {
  const file = resolve(path.replace(/^~(?=\/|$)/, homedir()))
  const image = nativeImage.createFromPath(file)
  if (image.isEmpty()) throw new Error(`Not an image file, or not found: ${file}`)
  // Copy the user's clipboard out; Electron only writes newly built items.
  const previous = await Promise.all(
    (await clipboard.read()).map(
      async (item) =>
        new ClipboardItem(
          Object.fromEntries(
            await Promise.all(item.types.map(async (type) => [type, await item.getType(type)]))
          )
        )
    )
  )
  const png = new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' })
  await clipboard.write([new ClipboardItem({ 'image/png': png })])
  page.paste()
  // Let the page read the clipboard before restoring it.
  await new Promise((done) => setTimeout(done, 1000))
  await clipboard.write(previous)
}

/** Every tool takes this: which chat's browser to use, for agents that share one tool address. */
const browserArg = {
  browser: z
    .string()
    .optional()
    .describe('Your browser ID, if the conversation gave you one. Omit it otherwise.')
}

export interface BrowserRouting {
  /** The chat whose browser ID this is (IDs are the start of the chat id). */
  chatForBrowserId(id: string): string | undefined
  /** The chat to use when a request names none: the most recently active one. */
  fallbackChat(): string | undefined
}

/**
 * Tools for one request. `pathChat` is set when the agent called a per-chat
 * address (opencode); otherwise the chat comes from the `browser` argument
 * (cline is told its ID in each prompt) or falls back to the latest active chat.
 */
function buildServer(
  browser: BuiltinBrowser,
  routing: BrowserRouting,
  pathChat: string | undefined
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: '1.0.0' },
    { instructions: BROWSER_GUIDANCE }
  )

  const chatFor = (id: string | undefined): string => {
    const chatId =
      pathChat ?? (id ? routing.chatForBrowserId(id) : undefined) ?? routing.fallbackChat()
    if (!chatId) {
      throw new Error(
        'Could not tell which chat\'s browser to use. Pass your browser ID (given in the conversation) as "browser".'
      )
    }
    return chatId
  }
  const pageFor = (id: string | undefined): Promise<WebContents> => browser.ensureReady(chatFor(id))

  server.registerTool(
    'navigate',
    {
      description:
        "Open a URL in the user's Just Harness browser (signed in to their accounts). Prefer this over any other browser tool unless the user asks for a different browser.",
      inputSchema: { url: z.string().describe('URL to open'), ...browserArg }
    },
    async ({ url, browser: id }) => {
      const page = await pageFor(id)
      await page.loadURL(normalizeUrl(url))
      return text(await page.executeJavaScript(SNAPSHOT_SCRIPT))
    }
  )

  server.registerTool(
    'snapshot',
    {
      description:
        'Read the current page: URL, title, visible text and a numbered list of interactive elements. Use the numbers as `ref` for click and type.',
      inputSchema: { ...browserArg }
    },
    async ({ browser: id }) => text(await (await pageFor(id)).executeJavaScript(SNAPSHOT_SCRIPT))
  )

  server.registerTool(
    'click',
    {
      description: 'Click an element by its ref from the latest snapshot.',
      inputSchema: { ref: z.number().int().describe('Element ref from snapshot'), ...browserArg }
    },
    async ({ ref, browser: id }) => {
      const page = await pageFor(id)
      await clickRef(page, ref)
      await settle(page)
      return text(`Clicked [${ref}]. Now at ${page.getURL()}. Take a snapshot to see the result.`)
    }
  )

  server.registerTool(
    'type',
    {
      description:
        'Focus an element by ref, replace its content with text, and optionally press Enter.',
      inputSchema: {
        ref: z.number().int().describe('Element ref from snapshot'),
        text: z.string().describe('Text to enter'),
        submit: z.boolean().optional().describe('Press Enter afterwards'),
        ...browserArg
      }
    },
    async ({ ref, text: value, submit, browser: id }) => {
      const page = await pageFor(id)
      await clickRef(page, ref)
      await page.executeJavaScript(`(() => {
        const el = document.querySelector('[data-harness-ref="${ref}"]');
        if (el && 'select' in el) el.select();
        else if (el && el.isContentEditable) document.execCommand('selectAll');
      })()`)
      await page.insertText(value)
      if (submit) {
        pressKey(page, 'Enter')
        await settle(page)
      }
      return text(`Typed into [${ref}]${submit ? ' and pressed Enter' : ''}.`)
    }
  )

  server.registerTool(
    'press_key',
    {
      description:
        'Press a key or shortcut in the focused element, e.g. Enter, Escape, Tab, ArrowDown, or "a" with modifiers ["cmd"] for select all. ⌘A/C/V/X/Z run the real edit commands.',
      inputSchema: {
        key: z.string(),
        modifiers: z.array(z.enum(['cmd', 'shift', 'alt', 'ctrl'])).optional(),
        ...browserArg
      }
    },
    async ({ key, modifiers, browser: id }) => {
      const page = await pageFor(id)
      pressKey(page, key, modifiers)
      await settle(page)
      return text(`Pressed ${[...(modifiers ?? []), key].join('+')}.`)
    }
  )

  server.registerTool(
    'paste_image',
    {
      description:
        'Paste a local image into the focused element, like copying it and pressing ⌘V. Click the target field first. For other file types use upload.',
      inputSchema: { path: z.string().describe('Absolute path of the image'), ...browserArg }
    },
    async ({ path, browser: id }) => {
      const page = await pageFor(id)
      await pasteImage(page, path)
      await settle(page)
      return text('Pasted the image. Take a snapshot to confirm it was attached.')
    }
  )

  server.registerTool(
    'scroll',
    {
      description: 'Scroll the page vertically by a number of pixels (negative scrolls up).',
      inputSchema: { pixels: z.number(), ...browserArg }
    },
    async ({ pixels, browser: id }) => {
      await (await pageFor(id)).executeJavaScript(`window.scrollBy(0, ${Number(pixels)})`)
      return text(`Scrolled ${pixels}px.`)
    }
  )

  server.registerTool(
    'back',
    { description: 'Go back in browser history.', inputSchema: { ...browserArg } },
    async ({ browser: id }) => {
      const page = await pageFor(id)
      if (page.navigationHistory.canGoBack()) page.navigationHistory.goBack()
      await settle(page)
      return text(`Now at ${page.getURL()}.`)
    }
  )

  server.registerTool(
    'upload',
    {
      description:
        'Attach local files to the page: pass the ref of the upload button or file field (e.g. "Upload", "Files", "Attach") and absolute file paths. Use this instead of asking the user to pick files.',
      inputSchema: {
        ref: z.number().int().describe('Ref of the upload button or file input from snapshot'),
        paths: z.array(z.string()).min(1).describe('Absolute paths of the files to attach'),
        ...browserArg
      }
    },
    async ({ ref, paths, browser: id }) => {
      const page = await pageFor(id)
      await uploadFiles(page, ref, paths)
      await settle(page)
      return text(`Attached ${paths.length} file(s) via [${ref}]. Take a snapshot to confirm.`)
    }
  )

  server.registerTool(
    'download',
    {
      description:
        "Download a file from a URL using the browser's logins. It is saved to ~/Downloads and the saved path is returned, so you can read or upload it.",
      inputSchema: { url: z.string().describe('URL of the file'), ...browserArg }
    },
    async ({ url, browser: id }) => {
      const chatId = chatFor(id)
      await browser.ensureReady(chatId)
      const download = await browser.download(chatId, url)
      if (download.state !== 'completed') throw new Error(`Download ${download.state}: ${url}`)
      return text(`Saved to ${download.path}`)
    }
  )

  server.registerTool(
    'downloads',
    {
      description:
        'List recent downloads from the browser (including ones started by clicking links), newest first, with where each file was saved.',
      inputSchema: { ...browserArg }
    },
    async () => {
      if (browser.downloads.length === 0) return text('No downloads yet.')
      return text(browser.downloads.map((d) => `${d.state}\t${d.path}\t${d.url}`).join('\n'))
    }
  )

  server.registerTool(
    'screenshot',
    {
      description: 'Take a screenshot of the visible part of the page.',
      inputSchema: { ...browserArg }
    },
    async ({ browser: id }) => ({
      content: [{ type: 'image', data: await screenshot(await pageFor(id)), mimeType: 'image/png' }]
    })
  )

  server.registerTool(
    'evaluate',
    {
      description: 'Run a JavaScript expression in the page and return its JSON-serialized result.',
      inputSchema: { expression: z.string(), ...browserArg }
    },
    async ({ expression, browser: id }) => {
      const result = await (await pageFor(id)).executeJavaScript(expression, true)
      return text(JSON.stringify(result, null, 2) ?? 'undefined')
    }
  )

  return server
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function startBrowserMcp(
  browser: BuiltinBrowser,
  routing: BrowserRouting
): Promise<BrowserMcpEndpoint> {
  const saved = readSaved()
  const token = saved?.token ?? randomBytes(24).toString('hex')
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end()
      return
    }
    // "/mcp" is shared; "/mcp/<chat id>" is one chat's browser.
    const match = req.url?.match(/^\/mcp(?:\/([\w-]+))?\/?$/)
    if (req.method !== 'POST' || !match) {
      res.writeHead(req.method !== 'POST' ? 405 : 404).end()
      return
    }
    // Stateless mode: a fresh server and transport per request.
    const server = buildServer(browser, routing, match[1])
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    })
    res.on('close', () => {
      transport.close()
      server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, await readBody(req))
    } catch (error) {
      console.error('browser MCP request failed:', error)
      if (!res.headersSent) res.writeHead(500).end()
    }
  })
  let port: number
  try {
    port = await listen(http, saved?.port ?? 0)
  } catch (error) {
    // The saved port is taken by something else; pick a new one.
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    port = await listen(http, 0)
  }
  if (port !== saved?.port || token !== saved?.token) {
    // The token controls the signed-in browser, so only the user may read it.
    writeFileSync(endpointFile, JSON.stringify({ port, token }), { mode: 0o600 })
    chmodSync(endpointFile, 0o600)
  }
  endpoint = { url: `http://127.0.0.1:${port}/mcp`, token }
  return endpoint
}

/** The MCP server entry passed in a chat's ACP session: that chat's own browser. */
export function browserMcpServer(chatId: string): AcpMcpServer {
  if (!endpoint) throw new Error('Browser MCP server has not started')
  return {
    type: 'http',
    name: SERVER_NAME,
    url: `${endpoint.url}/${chatId}`,
    headers: [{ name: 'Authorization', value: `Bearer ${endpoint.token}` }]
  }
}
