import type { Chat } from '../../../shared/types'

/**
 * What a chat between turns waits to be woken by, for the header and the
 * sidebar: "Waiting on 1 command and a timer". `chats` counts the chats it
 * started that are working. Undefined when it waits on nothing.
 */
export function waitingOn(chat: Chat, chats: number): string | undefined {
  const commands = chat.background?.commands.length ?? 0
  const parts = [
    ...(commands > 0 ? [commands === 1 ? '1 command' : `${commands} commands`] : []),
    ...(chats > 0 ? [chats === 1 ? '1 chat' : `${chats} chats`] : []),
    ...(chat.background?.timer ? ['a timer'] : [])
  ]
  if (parts.length === 0) return undefined
  const last = parts.pop()
  return `Waiting on ${parts.length > 0 ? `${parts.join(', ')} and ${last}` : last}`
}
