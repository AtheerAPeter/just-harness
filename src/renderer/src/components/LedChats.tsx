import type { Chat } from '../../../shared/types'
import { LeadIcon } from './icons'

/** In a chat that started chats: each of them, with what it is doing, one click away. */
export function LedChats({
  chats,
  onSelect
}: {
  chats: Chat[]
  onSelect: (chatId: string) => void
}): React.JSX.Element {
  const working = chats.filter((c) => c.running).length
  return (
    <div className="led-chats">
      <span
        className="led-label"
        title={`Started ${chats.length} ${chats.length === 1 ? 'chat' : 'chats'}, ${working} working`}
      >
        <LeadIcon width={13} height={13} />
        Leads {working}/{chats.length}
      </span>
      {chats.map((chat) => {
        const status = chat.waiting ? 'waiting' : chat.running ? 'running' : ''
        return (
          <button
            key={chat.id}
            className={`led-chat${status ? ` ${status}` : ''}`}
            title={chat.preview || chat.title}
            onClick={() => onSelect(chat.id)}
          >
            <span className={`chat-dot${status ? ` ${status}` : ''}`} />
            <span className="led-title">{chat.title}</span>
            <span className="led-state">
              {chat.waiting ? 'Needs you' : chat.running ? 'Working' : 'Idle'}
            </span>
          </button>
        )
      })}
    </div>
  )
}
