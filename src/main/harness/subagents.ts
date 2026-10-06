import { isAbsolute, resolve } from 'node:path'
import type { ToolSpec } from './types'

/**
 * Subagents: the main agent hands a well-defined task to a separate agent with
 * a fresh context, which works on it with the core tools and replies with a
 * report. Several run in parallel, so independent searches and independent
 * changes finish sooner. They are kept on a short leash: no browser, no
 * subagents of their own, explorers change nothing, implementers change only
 * the files they were given, and each has a step limit.
 *
 * A subagent's requests carry the chat's own system prompt and tools, byte for
 * byte, so they read the prefix the main agent's last request cached, and the
 * project's instructions come along. What makes it a subagent is its first
 * message (`brief`), and the rules enforced on its tool calls.
 */

export const AGENT_TOOL_NAME = 'agent'

/** Subagents of one chat running at once; more wait for a free place. */
export const MAX_PARALLEL = 5

/** Model requests one subagent may make before it must report. */
export const MAX_REQUESTS = 40

/** The tools a subagent may use. */
export const SUBAGENT_TOOLS = new Set(['read', 'bash', 'edit', 'write'])

/** Tools that change files, which explorers may not use and implementers only on their files. */
export const WRITING_TOOLS = new Set(['edit', 'write'])

export type SubagentType = 'explore' | 'implement'

export const AGENT_TOOL: ToolSpec = {
  name: AGENT_TOOL_NAME,
  description: `Start a subagent: a separate agent with its own context that does one well-defined task and replies with a report. Use it to finish work sooner: independent investigations, or independent changes to different files, run in parallel when you call this tool several times in one reply (at most ${MAX_PARALLEL} run at once). Do not use it for what a few tool calls of your own would finish, or for steps that depend on each other's results.

type "explore": investigates the project (read, bash) and reports what it found. It never changes files.
type "implement": makes a change, editing or writing only the files listed in "files". Implementers running at the same time must not share a file.

The subagent sees none of this conversation: put everything it needs in "prompt" (the goal, the relevant paths, constraints, and what to report). Subagents cannot use the browser or start subagents. You see only their final report, not their tool calls, so check an implementer's changes before relying on them.`,
  parameters: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description:
          'What it works on, in 3 to 6 words, shown to the user after "Exploring" or "Implementing" (e.g. "the auth flow")'
      },
      type: { type: 'string', enum: ['explore', 'implement'] },
      prompt: { type: 'string', description: 'The complete task, with all the context it needs' },
      files: {
        type: 'array',
        items: { type: 'string' },
        description:
          'For "implement": the files it may edit or create, relative to the project or absolute'
      }
    },
    required: ['description', 'type', 'prompt']
  }
}

/** A subagent call's arguments, checked. */
export interface SubagentTask {
  description: string
  type: SubagentType
  prompt: string
  /** Absolute paths an implementer may change; empty for an explorer. */
  files: string[]
}

/** Check the main agent's arguments; throws a message the model can act on. */
export function parseTask(args: Record<string, unknown>, cwd: string): SubagentTask {
  const { description, type, prompt, files } = args
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error('"description" must be a short text.')
  }
  if (type !== 'explore' && type !== 'implement') {
    throw new Error('"type" must be "explore" or "implement".')
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('"prompt" must describe the task.')
  }
  const paths = Array.isArray(files) ? files : []
  if (paths.some((f) => typeof f !== 'string' || !f.trim())) {
    throw new Error('"files" must be a list of file paths.')
  }
  if (type === 'implement' && paths.length === 0) {
    throw new Error('An "implement" subagent needs "files": the files it may change.')
  }
  return {
    description: description.trim(),
    type,
    prompt,
    files:
      type === 'implement'
        ? [...new Set((paths as string[]).map((f) => (isAbsolute(f) ? f : resolve(cwd, f))))]
        : []
  }
}

/** The subagent's first message: its role, its rules, and the task. */
export function brief(task: SubagentTask): string {
  const role =
    task.type === 'explore'
      ? `You are an explore subagent, started by the main agent of this chat to investigate one question. Use read and bash to look around. Do not change anything: no edits, no new files, and no commands that change files or state.

When you are done, reply with a concise report of what you found: the facts asked for, with file paths and line numbers where they help. Leave out what was not asked.`
      : `You are an implement subagent, started by the main agent of this chat to make one change. You may edit or write only these files:
${task.files.map((f) => `- ${f}`).join('\n')}

Other subagents may be changing other files at the same time. Do not change, create, format or revert any other file, and do not run commands that change files (formatters, code generators, git checkout, stash or commit). Commands that only check (type checks, tests, linters without fixing) are fine.

When you are done, reply with a short report: what you changed and where, and anything you could not do or are unsure about.`
  return `${role}

You cannot use the browser or start subagents. The main agent sees only your final reply, not your tool calls, so put everything it needs there. You have at most ${MAX_REQUESTS} steps.

<task>
${task.prompt}
</task>`
}

/**
 * Why a subagent may not make a call, if it may not: the tools it cannot have,
 * changes by an explorer, and changes by an implementer outside its files.
 * Paths are resolved the way the file tools resolve them.
 */
export function subagentRefusal(
  task: SubagentTask,
  tool: string,
  args: Record<string, unknown>,
  cwd: string
): string | undefined {
  if (tool === AGENT_TOOL_NAME) return 'Subagents cannot start subagents.'
  if (!SUBAGENT_TOOLS.has(tool)) {
    return `Subagents can use only read, bash, edit and write, not "${tool}". If the task needs more, say so in your report.`
  }
  if (!WRITING_TOOLS.has(tool)) return undefined
  if (task.type === 'explore') {
    return 'Explore subagents do not change files. Describe the change in your report instead.'
  }
  const path =
    typeof args.path === 'string'
      ? isAbsolute(args.path)
        ? args.path
        : resolve(cwd, args.path)
      : ''
  if (task.files.includes(path)) return undefined
  return `You may change only these files: ${task.files.join(', ')}. Describe other changes in your report instead.`
}

/** Sent when a subagent used up its steps without reporting. */
export const STEP_LIMIT_NOTE =
  'You have reached your step limit. Do not call any more tools: reply now with your final report, including what is left undone.'

/** A count of free places that callers wait on in order. */
export class Limiter {
  private running = 0
  private waiting: (() => void)[] = []

  constructor(private readonly max: number) {}

  /** Wait for a place; rejects if the signal aborts first. */
  acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.running < this.max) {
      this.running++
      return Promise.resolve()
    }
    return new Promise((done, fail) => {
      const take = (): void => {
        signal.removeEventListener('abort', onAbort)
        this.running++
        done()
      }
      const onAbort = (): void => {
        this.waiting = this.waiting.filter((w) => w !== take)
        fail(signal.reason)
      }
      this.waiting.push(take)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  release(): void {
    this.running--
    this.waiting.shift()?.()
  }
}
