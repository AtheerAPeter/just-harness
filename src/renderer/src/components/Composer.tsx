import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AGENTS,
  type AgentCommand,
  type AgentId,
  type AgentOption,
  type AgentStatus,
  type Chat,
  type Skill,
  type Attachment
} from '../../../shared/types'
import { Picker } from './Picker'
import { ModelPicker } from './model-picker/ModelPicker'
import { CompletionMenu, type CompletionItem } from './CompletionMenu'
import { writePref } from '../lib/prefs'
import { CloseIcon, FileIcon, PaperclipIcon, SendIcon, StopIcon } from './icons'

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
  projectPath: string
  /** Switch agents, starting with the given settings (e.g. the model picked with it). */
  onAgentChange: (agent: AgentId, settings: Record<string, string>) => void
  onOptionChange: (optionId: string, value: string) => Promise<void>
}

/**
 * Options shown in the composer next to the model picker (which also covers
 * cline's provider). Anything else the agent offers is ignored, including mode:
 * chats always run in build mode.
 */
const SHOWN_CATEGORIES = ['thought_level']

/** How much the agent may do without asking, per chat. */
const PERMISSION_MODES = [
  { value: 'ask', name: 'Ask', description: 'Every tool request asks you first' },
  {
    value: 'project',
    name: 'Auto in project',
    description: 'Runs inside the project; asks before touching anything outside'
  },
  { value: 'full', name: 'Full access', description: 'Runs every request without asking' }
]

function permissionMode(chat: Chat): string {
  if (!chat.bypassPermissions) return 'ask'
  return chat.projectOnly ? 'project' : 'full'
}

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
  projectPath,
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
    const mention = before.match(/(?:^|\s)@([^\s@]*)$/)
    if (mention)
      return { kind: 'mention' as const, query: mention[1], start: caret - mention[1].length - 1 }
    return undefined
  }, [text, caret])

  // Project files for @, re-read each time the @ menu opens so new files show up.
  const [files, setFiles] = useState<string[]>([])
  const mentioning = trigger?.kind === 'mention'
  useEffect(() => {
    if (!mentioning) return
    let cancelled = false
    window.api.listFiles(projectPath).then((list) => {
      if (!cancelled) setFiles(list)
    })
    return () => {
      cancelled = true
    }
  }, [mentioning, projectPath])

  const menuItems = useMemo((): CompletionItem[] => {
    if (!trigger) return []
    let all: CompletionItem[]
    if (trigger.kind === 'mention') {
      const q = trigger.query.toLowerCase()
      const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1).toLowerCase()
      const matches = files
        .filter((path) => path.toLowerCase().includes(q))
        // File names that start with the query first, then shorter paths.
        .sort(
          (a, b) =>
            Number(!baseName(a).startsWith(q)) - Number(!baseName(b).startsWith(q)) ||
            a.length - b.length
        )
        .slice(0, 50)
        .map((path) => ({ name: path, description: '', kind: 'file' as const }))
      return [...TAGS.filter((t) => t.name.includes(q)), ...matches]
    } else {
      const commandNames = new Set(commands.map((c) => c.name))
      all = [
        ...commands.map((c) => ({ ...c, kind: 'command' as const })),
        ...skills
          .filter((s) => !commandNames.has(s.name))
          .map((s) => ({ name: s.name, description: s.description, kind: 'skill' as const }))
      ]
    }
    const q = trigger.query.toLowerCase()
    return all
      .filter((item) => item.name.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)))
  }, [trigger, files, commands, skills])

  const menuOpen = trigger !== undefined && menuDismissed !== `${caret}:${text}`

  function choose(item: CompletionItem): void {
    if (!trigger) return
    const inserted = `${item.kind === 'tag' || item.kind === 'file' ? '@' : '/'}${item.name} `
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

  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)

  const canSend =
    (text.trim().length > 0 || attachments.length > 0) &&
    !chat.running &&
    status?.available !== false

  const addAttachments = (added: Attachment[]): void =>
    setAttachments((current) => [
      ...current,
      ...added.filter((a) => !a.path || !current.some((c) => c.path === a.path))
    ])

  /** Files from a paste or drop. Pasted screenshots have no path, so their data is read. */
  async function attachFiles(files: FileList): Promise<void> {
    const added: Attachment[] = []
    for (const file of Array.from(files)) {
      const path = window.api.pathForFile(file)
      if (path) {
        added.push({ name: file.name, path, mimeType: file.type || undefined })
      } else if (file.type.startsWith('image/')) {
        const data = await new Promise<string>((done) => {
          const reader = new FileReader()
          reader.onload = () => done(String(reader.result).split(',')[1] ?? '')
          reader.readAsDataURL(file)
        })
        added.push({ name: file.name || 'Pasted image', mimeType: file.type, data })
      }
    }
    addAttachments(added)
  }

  function submit(): void {
    if (!canSend) return
    window.api.send(chat.id, text.trim(), attachments)
    setText('')
    setAttachments([])
    setCaret(0)
  }

  const shown = SHOWN_CATEGORIES.flatMap((category) =>
    (options ?? []).filter((o) => o.category === category)
  )

  /** Apply a model picked in the model picker, with its provider when it has one. */
  async function pickModel(agent: AgentId, settings: [string, string][]): Promise<void> {
    if (agent !== chat.agent) return onAgentChange(agent, Object.fromEntries(settings))
    // In order: the model list depends on the provider set before it.
    for (const [optionId, value] of settings) {
      if (options?.find((o) => o.id === optionId)?.currentValue !== value) {
        await onOptionChange(optionId, value)
      }
    }
  }
  const error = status?.error ?? optionsError

  return (
    <div
      className={`composer${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setDragging(false)
        attachFiles(e.dataTransfer.files)
      }}
    >
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((a, index) => (
            <span className="attachment" key={`${a.path ?? a.name}-${index}`} title={a.path}>
              {a.data ? (
                <img src={`data:${a.mimeType};base64,${a.data}`} alt="" />
              ) : (
                <FileIcon width={13} height={13} />
              )}
              <span className="attachment-name">{a.name}</span>
              <button
                type="button"
                title="Remove"
                onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
              >
                <CloseIcon width={11} height={11} />
              </button>
            </span>
          ))}
        </div>
      )}
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
          chat.waiting
            ? 'Waiting for your answer above'
            : chat.running
              ? 'Working…'
              : `Ask ${AGENTS.find((a) => a.id === chat.agent)?.label}…`
        }
        onChange={(e) => {
          setText(e.target.value)
          setCaret(e.target.selectionStart)
          setMenuActive(0)
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onPaste={(e) => {
          // Files and images on the clipboard become attachments; text pastes normally.
          if (e.clipboardData.files.length === 0) return
          e.preventDefault()
          attachFiles(e.clipboardData.files)
        }}
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
            // Handled: closing the menu must not also stop the agent.
            e.preventDefault()
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
        <button
          type="button"
          className="icon-btn"
          title="Attach files"
          onClick={async () => addAttachments(await window.api.pickFiles())}
        >
          <PaperclipIcon width={15} height={15} />
        </button>
        <ModelPicker
          agent={chat.agent}
          projectId={chat.projectId}
          statuses={statuses}
          options={options}
          agentFixed={started}
          onChange={pickModel}
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
        <div className="permission-mode" data-mode={permissionMode(chat)}>
          <Picker
            title="Permissions"
            value={permissionMode(chat)}
            values={PERMISSION_MODES}
            onChange={(mode) => {
              // Two per-chat settings underneath: bypass approves requests,
              // project-only still asks for anything outside the project.
              const permissions = {
                bypassPermissions: mode !== 'ask',
                projectOnly: mode === 'project'
              }
              window.api.setBypassPermissions(chat.id, permissions.bypassPermissions)
              window.api.setProjectOnly(chat.id, permissions.projectOnly)
              // Remembered for new chats.
              writePref('permissions', permissions)
            }}
          />
        </div>
        <div className="spacer" />
        {chat.running ? (
          <button
            className="send-button stop"
            title="Stop (Esc)"
            onClick={() => window.api.cancel(chat.id)}
          >
            <StopIcon width={14} height={14} />
          </button>
        ) : (
          <button className="send-button" title="Send (Enter)" disabled={!canSend} onClick={submit}>
            <SendIcon width={15} height={15} />
          </button>
        )}
      </div>
    </div>
  )
}
