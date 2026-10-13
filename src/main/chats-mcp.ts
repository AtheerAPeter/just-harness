import { randomBytes } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Finished, Running } from './background'

/**
 * An MCP server that lets a chat start other chats in its project and message
 * them: hand a task to a new chat, which reports back when done, and
 * coordinate with chats working alongside. It is served next to the browser's
 * (see browser-mcp.ts), so every agent gets it the same way.
 *
 * A message starts a turn in the chat it is sent to, or waits until that
 * chat's turn ends. Agents are told to start chats only when the user asks
 * (GUIDANCE, which agents put in their system prompt), and a chat takes only
 * so many messages from other chats between the user's own, so two chats
 * cannot keep each other going.
 *
 * A chat calls with its own private key, which proves who calls: chat IDs are
 * how chats name each other, so anyone may know them. A message cannot reach a
 * chat with broader permissions than the sender's, and a chat whose turn
 * another chat started cannot start chats, so a chain of chats ends there.
 */

export const SERVER_NAME = 'harness_chats'

/** Messages from other chats, commands and timers a chat takes since the user last wrote in it. */
export const MAX_FROM_CHATS = 20

/** The longest a timer can be set for: a day. */
const MAX_TIMER_SECONDS = 24 * 60 * 60

/** Sent to the model as the server's instructions; the harness puts it in its system prompt. */
export const CHATS_GUIDANCE =
  "These tools start and message other chats of the user's project in Just Harness. Start new " +
  'chats only when the user asks for them; each one runs on its own and costs its own requests, ' +
  'so otherwise do the work yourself. A chat you start works alongside you and reports back with ' +
  'send_message. Its report arrives as a new message once your turn has ended, and when it ends ' +
  'its turn without reporting (it finished, failed or was stopped), you are told that instead, ' +
  'with why. So never wait or poll for it: end your turn, and you are woken. list_chats shows how ' +
  'each chat you started is doing, and send_message gets a stopped one going again. delete_chat ' +
  'removes a chat you started. run_in_background runs a long command (a download, a long build or ' +
  'test run, a dev server) and wakes this chat with its result when it ends; list_background, ' +
  'read_background and stop_background check on it and stop it. set_timer wakes this chat later, ' +
  'to check on something nothing else tells you about.'

/** "45s", "3m 12s", "1h 5m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Each chat's private key, kept for this launch only (see chatKey). */
const keys = new Map<string, string>()

/** The key a chat passes to these tools, made on first use. */
export function chatKey(chatId: string): string {
  let key = keys.get(chatId)
  if (!key) keys.set(chatId, (key = randomBytes(16).toString('hex')))
  return key
}

/** The chat a key belongs to; throws a message the model can act on. */
function chatForKey(key: string): string {
  for (const [chatId, k] of keys) if (k === key) return chatId
  throw new Error(
    'Unknown key. Pass your own harness_chats key, given in the conversation, as "chat".'
  )
}

/**
 * What the chat tools do, implemented by the agent manager. The caller is a
 * chat's full id, taken from its key; other chats are named by their chat IDs.
 */
export interface ChatsApi {
  /** Start a chat like the caller's and send it the task; returns its ID and title. */
  startChat(caller: string, prompt: string): { id: string; title: string }
  /** Send a message: 'started' when it started a turn, 'steering' when it joins the running turn at its next step. */
  message(caller: string, to: string, text: string): 'started' | 'steering'
  /** The chats the caller started, and the project's other working chats. */
  listChats(caller: string): ChatListing[]
  /** Delete a chat the caller started, stopping it first if it works; returns its title. */
  deleteStartedChat(caller: string, id: string): Promise<string>
  /**
   * Run a command in the caller's project, after the same permission check as
   * a shell command, stopped after `timeout` seconds if given; when it ends,
   * its result wakes the caller.
   */
  runInBackground(caller: string, command: string, timeout?: number): Promise<Running>
  /** The caller's running background commands, and its timer. */
  listBackground(caller: string): { commands: Running[]; timer?: Timer }
  /** One of the caller's running background commands, with the end of its output. */
  readBackground(caller: string, pid: number): Promise<Running & { output: string }>
  /** Stop one of the caller's background commands; resolves once it has ended. */
  stopBackground(caller: string, pid: number): Promise<Finished>
  /** Wake the caller with `note` after `seconds`, replacing its timer. */
  setTimer(caller: string, seconds: number, note: string): void
  /** Clear the caller's timer; false when it had none. */
  cancelTimer(caller: string): boolean
}

/** A chat as list_chats shows it. */
export interface ChatListing {
  id: string
  title: string
  self: boolean
  /** Started by the caller, with start_chat. */
  started: boolean
  /** "working", "waiting for the user", or how its last turn ended. */
  state: string
  /** The file its conversation is saved in, for the chats the caller started. */
  file?: string
}

/** A chat's timer (see set_timer). */
export interface Timer {
  note: string
  /** When it goes off, in ms since the epoch. */
  at: number
}

/** What a chat's agent is sent for a message from another chat. */
export function fromChatPrompt(title: string, id: string, text: string, first: boolean): string {
  if (first) {
    return `The chat "${title}" (chat ID ${id}) started this chat to hand you this task:

${text}

Work on it on your own. When you are done, report back to that chat with send_message: what you did or found, and anything it must know or decide. Your report is all it sees of your work. If you cannot go on, report that too, with why.`
  }
  return `Message from the chat "${title}" (chat ID ${id}):

${text}

If it needs an answer, send it with send_message. Do not send messages only to acknowledge or thank.`
}

type ToolResult = { content: { type: 'text'; text: string }[] }

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] })

const chatArg = {
  chat: z
    .string()
    .describe('Your harness_chats key, given in the conversation. Never put it in a message.')
}

/** The chat tools for one request; a refusal is thrown and reaches the model as an error. */
export async function buildChatsServer(chats: ChatsApi): Promise<McpServer> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const server = new McpServer(
    { name: SERVER_NAME, version: '1.0.0' },
    {
      instructions: CHATS_GUIDANCE
    }
  )

  server.registerTool(
    'start_chat',
    {
      description: `Start a new chat in this project, with the same agent, model and permissions as yours, and send it a task. Only when the user asks for new chats; otherwise do the work yourself. A chat another chat started cannot start chats. The new chat sees none of this conversation: put everything it needs in "prompt" (the goal, the relevant paths, constraints, and what to report). It works on its own, alongside you, and reports back with send_message. Its report arrives here as a new message once your turn has ended; if it ends its turn without reporting (it finished, failed or was stopped), you are told that instead, with why. So do not wait or poll for it: start the chats you need, tell the user, and end your turn.`,
      inputSchema: {
        prompt: z.string().describe('The complete task, with all the context it needs'),
        ...chatArg
      }
    },
    ({ prompt, chat }) => {
      const started = chats.startChat(chatForKey(chat), prompt)
      return text(
        `Started chat ${started.id} ("${started.title}"). It reports back here when it is done.`
      )
    }
  )

  server.registerTool(
    'send_message',
    {
      description: `Send a message to another chat of this project, by its chat ID (from start_chat, list_chats, or a message it sent you). It starts a turn in that chat, so it also gets a chat that stopped, failed or finished going again. If the chat is working, the message joins its turn at its next step, so you can steer it. Use it to report back to the chat that started you, or to coordinate with chats working alongside you. Do not send messages only to acknowledge or thank: a chat takes at most ${MAX_FROM_CHATS} messages from other chats between the user's messages. A chat with broader permissions than yours does not take messages from you, except the chat that started you.`,
      inputSchema: {
        to: z.string().describe('The chat ID of the chat to send it to'),
        message: z.string().describe('The message, with everything the other chat needs'),
        ...chatArg
      }
    },
    ({ to, message, chat }) =>
      text(
        {
          started: `Sent. Chat ${to} is working on it now.`,
          steering: `Sent. Chat ${to} is working, and reads your message at its next step.`
        }[chats.message(chatForKey(chat), to, message)]
      )
  )

  server.registerTool(
    'delete_chat',
    {
      description:
        'Delete a chat you started, by its chat ID, with all its messages. If it is working, it is stopped first. Only chats you started with start_chat can be deleted. Use it when the user asks, or to clear away a chat you started that is no longer needed, such as one you replace with a new one.',
      inputSchema: {
        to: z.string().describe('The chat ID of the chat to delete'),
        ...chatArg
      },
      annotations: { destructiveHint: true }
    },
    async ({ to, chat }) => {
      const title = await chats.deleteStartedChat(chatForKey(chat), to)
      return text(`Deleted chat ${to} ("${title}").`)
    }
  )

  server.registerTool(
    'run_in_background',
    {
      description:
        "Run a shell command in the project folder in the background, and be woken when it ends: a download, an install, a long build or test run, or a server that keeps running (a dev server, a watcher). Use it instead of your own shell's background mode or &: those cannot wake this chat, and cannot be checked on or stopped with these tools. It returns at once with the command's process ID. When the command ends, this chat gets a message with its exit code and the end of its output, as a new turn or at the next step of the current one. So for a command whose result you need, end your turn after starting it, without waiting or polling. read_background shows its output so far and stop_background stops it. Background commands stop when the app quits.",
      inputSchema: {
        command: z.string().describe('The bash command to run'),
        timeout: z
          .number()
          .positive()
          .optional()
          .describe(
            'Seconds after which the command is stopped, which wakes you as its end does. Leave it out for a server that should keep running.'
          ),
        ...chatArg
      }
    },
    async ({ command, timeout, chat }) => {
      const { pid, log } = await chats.runInBackground(chatForKey(chat), command, timeout)
      return text(
        `Started in the background (process ${pid}). Its output goes to ${log}. This chat is woken with the result when it ends, so if you need its result, end your turn now.`
      )
    }
  )

  server.registerTool(
    'list_background',
    {
      description:
        'List your background commands that are still running, with their process IDs and how long they have run, and your timer if one is set.',
      inputSchema: { ...chatArg },
      annotations: { readOnlyHint: true }
    },
    ({ chat }) => {
      const { commands, timer } = chats.listBackground(chatForKey(chat))
      const lines = commands.map(
        (c) =>
          `Process ${c.pid}, running for ${formatDuration(c.ms)}${c.timeout !== undefined ? ` of its ${formatDuration(c.timeout * 1000)} timeout` : ''}: ${c.command}`
      )
      if (lines.length === 0) lines.push('No background commands are running.')
      lines.push(
        timer
          ? `Your timer goes off in ${formatDuration(timer.at - Date.now())}: ${timer.note}`
          : 'No timer is set.'
      )
      return text(lines.join('\n'))
    }
  )

  server.registerTool(
    'read_background',
    {
      description:
        'Show a background command of yours that is still running: how long it has run and the end of its output so far. Use it to check on a server or a long run when you need to know now. For a final result, end your turn and be woken instead.',
      inputSchema: {
        pid: z.number().int().describe('Its process ID, from run_in_background or list_background'),
        ...chatArg
      },
      annotations: { readOnlyHint: true }
    },
    async ({ pid, chat }) => {
      const c = await chats.readBackground(chatForKey(chat), pid)
      return text(
        [
          `Process ${c.pid} has run for ${formatDuration(c.ms)}: ${c.command}`,
          c.output.trim()
            ? `End of its output so far:\n${c.output.trimEnd()}`
            : 'It has printed nothing yet.',
          `Full output: ${c.log}`
        ].join('\n\n')
      )
    }
  )

  server.registerTool(
    'stop_background',
    {
      description:
        'Stop a background command of yours, with every process it started, and get the end of its output. Stopping it does not wake you.',
      inputSchema: {
        pid: z.number().int().describe('Its process ID, from run_in_background or list_background'),
        ...chatArg
      },
      annotations: { destructiveHint: true }
    },
    async ({ pid, chat }) => {
      const f = await chats.stopBackground(chatForKey(chat), pid)
      return text(
        [
          `Stopped process ${f.pid} after ${formatDuration(f.ms)}: ${f.command}`,
          f.output.trim() ? `End of its output:\n${f.output.trimEnd()}` : 'It printed nothing.',
          `Full output: ${f.log}`
        ].join('\n\n')
      )
    }
  )

  server.registerTool(
    'set_timer',
    {
      description: `Wake this chat after a number of seconds, with a note to yourself of what to do then. Use it to check back on something nothing else tells you about, such as a deploy, a CI run or a page that updates; a background command and a chat you started wake you on their own. A chat has one timer: setting it again replaces the one before, and cancel_timer clears it. When it goes off, this chat gets your note as a new turn, or at the next step of the current one, so end your turn after setting it. The user's Stop clears it, and so does quitting the app. Each time it goes off counts toward the ${MAX_FROM_CHATS} messages a chat takes from other chats, commands and timers between the user's messages, so do not check more often than you need.`,
      inputSchema: {
        seconds: z
          .number()
          .min(1)
          .max(MAX_TIMER_SECONDS)
          .describe(`Seconds from now, at most ${MAX_TIMER_SECONDS} (a day)`),
        note: z.string().describe('What to do when it goes off'),
        ...chatArg
      }
    },
    ({ seconds, note, chat }) => {
      chats.setTimer(chatForKey(chat), seconds, note)
      return text(
        `Timer set: this chat is woken in ${formatDuration(seconds * 1000)} with your note. End your turn now.`
      )
    }
  )

  server.registerTool(
    'cancel_timer',
    {
      description: "Clear this chat's timer, when what it was for is done or no longer needed.",
      inputSchema: { ...chatArg }
    },
    ({ chat }) => text(chats.cancelTimer(chatForKey(chat)) ? 'Timer cleared.' : 'No timer was set.')
  )

  server.registerTool(
    'list_chats',
    {
      description:
        'List the chats you started, with how each is doing (working, waiting for the user, or how its last turn ended, with the error when it failed) and the file its conversation is saved in, and the other chats of this project that are working now. Use it to see why a chat you started stopped; send_message gets it going again.',
      inputSchema: { ...chatArg },
      annotations: { readOnlyHint: true }
    },
    ({ chat }) =>
      text(
        chats
          .listChats(chatForKey(chat))
          .map((c) =>
            [
              c.id,
              c.title,
              c.self ? 'this chat' : c.state,
              ...(c.started ? ['started by you'] : []),
              ...(c.file ? [`saved in ${c.file}`] : [])
            ].join('\t')
          )
          .join('\n')
      )
  )

  return server
}
