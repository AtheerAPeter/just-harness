// Relays MCP JSON-RPC messages between stdio (what the agent spawns) and the
// app's browser MCP server over HTTP. The server answers with plain JSON
// (enableJsonResponse), so each message maps to one POST.
import { createInterface } from 'node:readline'

const url = process.env.HARNESS_MCP_URL
const token = process.env.HARNESS_MCP_TOKEN

async function relay(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`
      },
      body: line
    })
    const body = await response.text()
    if (body) process.stdout.write(body.trim() + '\n')
    else if (!response.ok && message.id !== undefined) throw new Error(`HTTP ${response.status}`)
  } catch (error) {
    if (message.id === undefined) return
    const reply = {
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32603, message: `Just Harness is not reachable: ${error.message}` }
    }
    process.stdout.write(JSON.stringify(reply) + '\n')
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim()) relay(line)
})
