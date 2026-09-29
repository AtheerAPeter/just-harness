import { createServer, type IncomingMessage } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpServerStdio } from '@agentclientprotocol/sdk'
import { z } from 'zod'
import bridgeScript from '../../resources/mcp-stdio-bridge.mjs?asset&asarUnpack'
import type { BuiltinBrowser } from './browser'

/**
 * An MCP server that drives the built-in browser. It listens on loopback HTTP
 * guarded by a random token; agents reach it through a small stdio bridge
 * (cline only supports stdio MCP servers over ACP).
 */

/**
 * Distinct from "browser" on purpose: opencode ships a built-in tool by that
 * name, and agents confuse the two.
 */
export const SERVER_NAME = 'harness_browser'
const token = randomBytes(24).toString('hex')
let endpoint: string | undefined

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

async function settle(browser: BuiltinBrowser): Promise<void> {
  // Give a click or key press time to start a navigation, then wait for it to finish.
  await new Promise((resolve) => setTimeout(resolve, 400))
  const deadline = Date.now() + 15_000
  while (browser.contents.isLoading() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function clickRef(browser: BuiltinBrowser, ref: number): Promise<void> {
  const point = (await browser.contents.executeJavaScript(locateScript(ref))) as {
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
  browser.contents.sendInputEvent({ type: 'mouseMove', x, y })
  browser.contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  browser.contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
}

function pressKey(browser: BuiltinBrowser, key: string): void {
  browser.contents.sendInputEvent({ type: 'keyDown', keyCode: key })
  if (key.length === 1 || key === 'Enter') {
    browser.contents.sendInputEvent({ type: 'char', keyCode: key === 'Enter' ? '\r' : key })
  }
  browser.contents.sendInputEvent({ type: 'keyUp', keyCode: key })
}

function buildServer(browser: BuiltinBrowser): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: '1.0.0' })

  server.registerTool(
    'navigate',
    {
      description:
        "Open a URL in the browser panel of the Just Harness app, which the user can watch. It keeps the user's logins, so authenticated pages work.",
      inputSchema: { url: z.string().describe('URL to open') }
    },
    async ({ url }) => {
      await browser.ensureVisible()
      await browser.navigate(url)
      return text(await browser.contents.executeJavaScript(SNAPSHOT_SCRIPT))
    }
  )

  server.registerTool(
    'snapshot',
    {
      description:
        'Read the current page: URL, title, visible text and a numbered list of interactive elements. Use the numbers as `ref` for click and type.'
    },
    async () => {
      await browser.ensureVisible()
      return text(await browser.contents.executeJavaScript(SNAPSHOT_SCRIPT))
    }
  )

  server.registerTool(
    'click',
    {
      description: 'Click an element by its ref from the latest snapshot.',
      inputSchema: { ref: z.number().int().describe('Element ref from snapshot') }
    },
    async ({ ref }) => {
      await browser.ensureVisible()
      await clickRef(browser, ref)
      await settle(browser)
      return text(
        `Clicked [${ref}]. Now at ${browser.contents.getURL()}. Take a snapshot to see the result.`
      )
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
        submit: z.boolean().optional().describe('Press Enter afterwards')
      }
    },
    async ({ ref, text: value, submit }) => {
      await browser.ensureVisible()
      await clickRef(browser, ref)
      await browser.contents.executeJavaScript(`(() => {
        const el = document.querySelector('[data-harness-ref="${ref}"]');
        if (el && 'select' in el) el.select();
        else if (el && el.isContentEditable) document.execCommand('selectAll');
      })()`)
      await browser.contents.insertText(value)
      if (submit) {
        pressKey(browser, 'Enter')
        await settle(browser)
      }
      return text(`Typed into [${ref}]${submit ? ' and pressed Enter' : ''}.`)
    }
  )

  server.registerTool(
    'press_key',
    {
      description:
        'Press a key in the focused element, e.g. Enter, Escape, Tab, Backspace, ArrowDown.',
      inputSchema: { key: z.string() }
    },
    async ({ key }) => {
      await browser.ensureVisible()
      pressKey(browser, key)
      await settle(browser)
      return text(`Pressed ${key}.`)
    }
  )

  server.registerTool(
    'scroll',
    {
      description: 'Scroll the page vertically by a number of pixels (negative scrolls up).',
      inputSchema: { pixels: z.number() }
    },
    async ({ pixels }) => {
      await browser.ensureVisible()
      await browser.contents.executeJavaScript(`window.scrollBy(0, ${Number(pixels)})`)
      return text(`Scrolled ${pixels}px.`)
    }
  )

  server.registerTool('back', { description: 'Go back in browser history.' }, async () => {
    browser.back()
    await settle(browser)
    return text(`Now at ${browser.contents.getURL()}.`)
  })

  server.registerTool(
    'screenshot',
    { description: 'Take a screenshot of the visible part of the page.' },
    async () => {
      await browser.ensureVisible()
      const image = await browser.contents.capturePage()
      return {
        content: [{ type: 'image', data: image.toPNG().toString('base64'), mimeType: 'image/png' }]
      }
    }
  )

  server.registerTool(
    'evaluate',
    {
      description: 'Run a JavaScript expression in the page and return its JSON-serialized result.',
      inputSchema: { expression: z.string() }
    },
    async ({ expression }) => {
      await browser.ensureVisible()
      const result = await browser.contents.executeJavaScript(expression, true)
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

export function startBrowserMcp(browser: BuiltinBrowser): Promise<void> {
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    // Stateless mode: a fresh server and transport per request.
    const server = buildServer(browser)
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
  return new Promise((resolve) => {
    http.listen(0, '127.0.0.1', () => {
      endpoint = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`
      resolve()
    })
  })
}

/** The MCP server entry passed to every ACP session. */
export function browserMcpServer(): McpServerStdio {
  if (!endpoint) throw new Error('Browser MCP server has not started')
  return {
    name: SERVER_NAME,
    // Electron's own binary doubles as a Node runtime, so no separate Node install is needed.
    command: process.execPath,
    args: [bridgeScript],
    env: [
      { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
      { name: 'HARNESS_MCP_URL', value: endpoint },
      { name: 'HARNESS_MCP_TOKEN', value: token }
    ]
  }
}
