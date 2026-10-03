import type { ChatItem } from '../shared/types'

/** The first meaningful line of a message, plain and short, for the sidebar. */
export function previewLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) =>
        l
          .replace(/[#*_`>|-]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      )
      .find((l) => l.length > 0) ?? ''
  return line.slice(0, 140)
}

/** The sidebar preview for a chat: the last message from the user or the agent. */
export function chatPreview(items: ChatItem[]): string {
  const last = items.findLast((i) => i.kind === 'user' || i.kind === 'text' || i.kind === 'error')
  return last && 'text' in last ? previewLine(last.text) : ''
}
