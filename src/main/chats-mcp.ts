import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

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
 */

export const SERVER_NAME = 'harness_chats'

/** Messages from other chats a chat takes since the user last wrote in it. */
export const MAX_FROM_CHATS = 5

/** Sent to the model as the server's instructions; the harness puts it in its system prompt. */
export const CHATS_GUIDANCE =
  "These tools start and message other chats of the user's project in Just Harness. Start new " +
  'chats only when the user asks for them; each one runs on its own and costs its own requests, ' +
  'so otherwise do the work yourself. A chat you start works alongside you and reports back with ' +
  'send_message; its report arrives as a new message once your turn has ended, so never wait or ' +
  'poll for it.'

/** What the chat tools do, implemented by the agent manager. Chats are named by their short IDs. */
export interface ChatsApi {
  /** Start a chat like the caller's and send it the task; returns its ID and title. */
  startChat(caller: string, prompt: string): { id: string; title: string }
  /** Send a message; 'started' when it started a turn, 'queued' when it waits for one to end. */
  message(caller: string, to: string, text: string): 'started' | 'queued'
  /** The project's running chats. */
  runningChats(caller: string): { id: string; title: string; waiting: boolean; self: boolean }[]
}

/** What a chat's agent is sent for a message from another chat. */
export function fromChatPrompt(title: string, id: string, text: string, first: boolean): string {
  if (first) {
    return `The chat "${title}" (chat ID ${id}) started this chat to hand you this task:

${text}

Work on it on your own. When you are done, report back to that chat with send_message: what you did or found, and anything it must know or decide. Your report is all it sees of your work.`
  }
  return `Message from the chat "${title}" (chat ID ${id}):

${text}

If it needs an answer, send it with send_message. Do not send messages only to acknowledge or thank.`
}

type ToolResult = { content: { type: 'text'; text: string }[] }

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] })

const chatArg = {
  chat: z.string().describe('Your chat ID, given in the conversation.')
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
      description: `Start a new chat in this project, with the same agent, model and permissions as yours, and send it a task. Only when the user asks for new chats; otherwise do the work yourself. The new chat sees none of this conversation: put everything it needs in "prompt" (the goal, the relevant paths, constraints, and what to report). It works on its own, alongside you, and reports back with send_message. Its report arrives here as a new message once your turn has ended, so do not wait or poll for it: start the chats you need, tell the user, and end your turn.`,
      inputSchema: {
        prompt: z.string().describe('The complete task, with all the context it needs'),
        ...chatArg
      }
    },
    ({ prompt, chat }) => {
      const started = chats.startChat(chat, prompt)
      return text(
        `Started chat ${started.id} ("${started.title}"). It reports back here when it is done.`
      )
    }
  )

  server.registerTool(
    'send_message',
    {
      description: `Send a message to another chat of this project, by its chat ID (from start_chat, list_chats, or a message it sent you). It starts a turn in that chat; if the chat is working, the message waits until its turn ends. Use it to report back to the chat that started you, or to coordinate with chats working alongside you. Do not send messages only to acknowledge or thank: a chat takes at most ${MAX_FROM_CHATS} messages from other chats between the user's messages.`,
      inputSchema: {
        to: z.string().describe('The chat ID of the chat to send it to'),
        message: z.string().describe('The message, with everything the other chat needs'),
        ...chatArg
      }
    },
    ({ to, message, chat }) =>
      chats.message(chat, to, message) === 'started'
        ? text(`Sent. Chat ${to} is working on it now.`)
        : text(`Chat ${to} is busy, so your message is delivered when its current turn ends.`)
  )

  server.registerTool(
    'list_chats',
    {
      description:
        'List the chats of this project that are running now: their chat IDs and titles, and which one is yours.',
      inputSchema: { ...chatArg },
      annotations: { readOnlyHint: true }
    },
    ({ chat }) =>
      text(
        chats
          .runningChats(chat)
          .map(
            (c) =>
              `${c.id}\t${c.title}${c.waiting ? '\t(waiting for the user)' : ''}${c.self ? '\t(this chat)' : ''}`
          )
          .join('\n')
      )
  )

  return server
}
