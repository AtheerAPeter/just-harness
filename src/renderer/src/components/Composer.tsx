import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AGENTS,
  type AgentCommand,
  type AgentId,
  type AgentOption,
  type AgentStatus,
  type Chat,
  type Skill
} from '../../../shared/types'
import { Picker } from './Picker'
import { CompletionMenu, type CompletionItem } from './CompletionMenu'
import { SendIcon, ShieldIcon, StopIcon } from './icons'

interface ComposerProps {
  chat: Chat
  statuses: Partial<Record<AgentId, AgentStatus>>
  /** Undefined while the agent session is starting. */
  options?: AgentOption[]
  optionsError?: string
  commands: AgentCommand[]
  skills: Skill[]
  /** True once the first message is sent; the agent is fixed from then on. */
  started: boolean
  onAgentChange: (agent: AgentId) => void
  onOptionChange: (optionId: string, value: string) => void
}

/**
 * Options shown in the composer, in this order. Anything else the agent offers is
 * ignored, including mode: chats always run in build mode.
 */
const SHOWN_CATEGORIES = ['model', 'thought_level']

/** @-tags. `@browser` tells the agent to work in the built-in browser panel. */
const TAGS: CompletionItem[] = [
  { name: 'browser', description: 'Use the built-in browser (keeps your logins)', kind: 'tag' }
]

export function Composer({
  chat,
  statuses,
  options,
  optionsError,
  commands,
  skills,
  started,
  onAgentChange,
  onOptionChange
}: ComposerProps): React.JSX.Element {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [menuActive, setMenuActive] = useState(0)
  /** Set when the user closes the menu with Escape, for the text and caret at that moment. */
  const [menuDismissed, setMenuDismissed] = useState<string>()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const status = statuses[chat.agent]

  // What is being completed: `/name` at the very start, or `@tag` anywhere before the caret.
  const trigger = useMemo(() => {
    const before = text.slice(0, caret)
    const slash = before.match(/^\/(\S*)$/)
    if (slash) return { kind: 'slash' as const, query: slash[1], start: 0 }
    const mention = before.match(/(?:^|\s)@(\w*)$/)
    if (mention)
      return { kind: 'mention' as const, query: mention[1], start: caret - mention[1].length - 1 }
    return undefined
  }, [text, caret])

  const menuItems = useMemo((): CompletionItem[] => {
    if (!trigger) return []
    let all: CompletionItem[]
    if (trigger.kind === 'mention') {
      all = TAGS
    } else {
      const commandNames = new Set(commands.map((c) => c.name))
      all = [
        ...commands.map((c) => ({ ...c, kind: 'command' as const })),
        ...skills
          .filter((s) => s.agents.includes(chat.agent) && !commandNames.has(s.name))
          .map((s) => ({ name: s.name, description: s.description, kind: 'skill' as const }))
      ]
    }
    const q = trigger.query.toLowerCase()
    return all
      .filter((item) => item.name.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)))
  }, [trigger, commands, skills, chat.agent])

  const menuOpen = trigger !== undefined && menuDismissed !== `${caret}:${text}`

  function choose(item: CompletionItem): void {
    if (!trigger) return
    const inserted = `${item.kind === 'tag' ? '@' : '/'}${item.name} `
    const next = text.slice(0, trigger.start) + inserted + text.slice(caret)
    const position = trigger.start + inserted.length
    setText(next)
    setCaret(position)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(position, position)
    })
  }

  useEffect(() => {
    textareaRef.current?.focus()
  }, [chat.id])

  // Grow with content up to a limit.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])

  const canSend = text.trim().length > 0 && !chat.running && status?.available !== false

  function submit(): void {
    if (!canSend) return
    window.api.send(chat.id, text.trim())
    setText('')
    setCaret(0)
  }

  const shown = SHOWN_CATEGORIES.flatMap((category) =>
    (options ?? []).filter((o) => o.category === category)
  )
  const error = status?.error ?? optionsError

  return (
    <div className="composer">
      {menuOpen && (
        <CompletionMenu
          items={menuItems}
          active={menuActive}
          onHover={setMenuActive}
          onChoose={choose}
        />
      )}
      <textarea
        ref={textareaRef}
        value={text}
        rows={1}
        placeholder={
          chat.running ? 'Working…' : `Ask ${AGENTS.find((a) => a.id === chat.agent)?.label}…`
        }
        onChange={(e) => {
          setText(e.target.value)
          setCaret(e.target.selectionStart)
          setMenuActive(0)
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={(e) => {
          if (menuOpen && menuItems.length > 0) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              const step = e.key === 'ArrowDown' ? 1 : -1
              setMenuActive((i) => (i + step + menuItems.length) % menuItems.length)
              return
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              choose(menuItems[Math.min(menuActive, menuItems.length - 1)])
              return
            }
          }
          if (menuOpen && e.key === 'Escape') {
            setMenuDismissed(`${caret}:${text}`)
            return
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className="composer-bar">
        <Picker
          title={started ? 'The agent is fixed once a chat has started' : 'Agent'}
          value={chat.agent}
          disabled={started}
          values={AGENTS.map((a) => ({
            value: a.id,
            name: a.label,
            description:
              statuses[a.id]?.available === false ? 'Not installed' : statuses[a.id]?.version,
            disabled: statuses[a.id]?.available === false
          }))}
          onChange={(v) => onAgentChange(v as AgentId)}
        />
        {!options && !error && <span className="composer-hint">Starting agent…</span>}
        {shown.map((option) => (
          <Picker
            key={option.id}
            title={option.name}
            value={option.currentValue}
            values={option.values}
            onChange={(v) => onOptionChange(option.id, v)}
          />
        ))}
        {error && (
          <span className="composer-error" title={error}>
            {error}
          </span>
        )}
        <button
          type="button"
          className={`bypass-toggle${chat.bypassPermissions ? ' on' : ''}`}
          aria-pressed={Boolean(chat.bypassPermissions)}
          title={
            chat.bypassPermissions
              ? 'Bypass permissions is on: every tool request is approved automatically (allow once). Click to ask again.'
              : 'Bypass permissions: approve every tool request automatically'
          }
          onClick={() => window.api.setBypassPermissions(chat.id, !chat.bypassPermissions)}
        >
          <ShieldIcon width={14} height={14} />
          {chat.bypassPermissions ? 'Bypass on' : 'Ask'}
        </button>
        <div className="spacer" />
        {chat.running ? (
          <button
            className="send-button stop"
            title="Stop"
            onClick={() => window.api.cancel(chat.id)}
          >
            <StopIcon />
          </button>
        ) : (
          <button className="send-button" title="Send (Enter)" disabled={!canSend} onClick={submit}>
            <SendIcon />
          </button>
        )}
      </div>
    </div>
  )
}
