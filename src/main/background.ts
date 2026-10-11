import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keepForQuit, killGroup, MAX_BYTES, tail } from './harness/tools'
import { loadShellPath } from './shell-env'

/**
 * Commands chats run in the background with run_in_background (chats-mcp.ts):
 * a download, a long build or test run. Each writes its output to a log file,
 * and when it ends the chat that ran it is told how it went. They are stopped
 * when their chat is deleted, and with the app's other leftovers when it quits.
 */

/** How a background command ended. */
export interface Finished {
  command: string
  pid: number
  /** The exit code, or null when a signal ended it. */
  code: number | null
  signal: NodeJS.Signals | null
  ms: number
  /** The end of its output, as the shell tool shows it. */
  output: string
  log: string
}

const logDir = join(tmpdir(), 'just-harness-background')

/** The commands each chat runs, by process ID. */
const running = new Map<string, Set<number>>()

/** Start a command in `cwd`; `onDone` is called once it has ended. */
export async function startBackground(
  chatId: string,
  command: string,
  cwd: string,
  onDone: (finished: Finished) => void
): Promise<{ pid: number; log: string }> {
  await loadShellPath()
  mkdirSync(logDir, { recursive: true })
  const log = join(logDir, `${crypto.randomUUID().slice(0, 8)}.log`)
  const fd = openSync(log, 'a')
  const started = Date.now()
  const child = spawn('/bin/bash', ['-c', command], {
    cwd,
    // Its own process group, so stopping it also stops what it started.
    detached: true,
    stdio: ['ignore', fd, fd]
  })
  closeSync(fd)
  const pid = child.pid
  if (pid === undefined) {
    await new Promise((resolve) => child.once('error', resolve))
    throw new Error(`Could not start bash for: ${command}`)
  }
  keepForQuit(pid)
  const own = running.get(chatId) ?? new Set()
  running.set(chatId, own.add(pid))
  child.once('exit', (code, signal) => {
    own.delete(pid)
    void lastOutput(log).then((output) =>
      onDone({ command, pid, code, signal, ms: Date.now() - started, output, log })
    )
  })
  return { pid, log }
}

/** Stop the commands a chat runs: it is being deleted. */
export function stopBackground(chatId: string): void {
  for (const pid of running.get(chatId) ?? []) killGroup(pid, 'SIGTERM')
  running.delete(chatId)
}

/** The end of a log, read from its last bytes so a large one is not read whole. */
async function lastOutput(log: string): Promise<string> {
  const file = await open(log, 'r')
  try {
    const { size } = await file.stat()
    const length = Math.min(size, 2 * MAX_BYTES)
    const { buffer } = await file.read(Buffer.alloc(length), 0, length, size - length)
    return tail(buffer.toString('utf8'))
  } finally {
    await file.close()
  }
}
