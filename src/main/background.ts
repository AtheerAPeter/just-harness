import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { groupAlive, keepForQuit, KILL_GRACE_MS, killGroup, MAX_BYTES, tail } from './harness/tools'
import { loadShellPath } from './shell-env'

/**
 * Commands chats run in the background with run_in_background (chats-mcp.ts):
 * a download, a long build or test run, a dev server. Each writes its output
 * to a log file, and when it ends on its own or at its timeout, the chat that
 * ran it is told how it went. A chat can list, read and stop its own. They are
 * stopped when their chat is deleted, and with the app's other leftovers when
 * it quits.
 */

/** How a background command ended. */
export interface Finished {
  command: string
  pid: number
  /** The exit code, or null when a signal ended it. */
  code: number | null
  signal: NodeJS.Signals | null
  /** Its timeout in seconds, when that is what stopped it. */
  timedOut?: number
  ms: number
  /** The end of its output, as the shell tool shows it. */
  output: string
  log: string
}

/** A background command that is still running. */
export interface Running {
  command: string
  pid: number
  ms: number
  log: string
  /** Its timeout in seconds, if it has one. */
  timeout?: number
}

interface Job {
  command: string
  pid: number
  log: string
  started: number
  timeout?: number
  timer?: NodeJS.Timeout
  /** Why it is being stopped: its timeout ran out, or the chat stopped it (see stopCommand). */
  stopping?: 'timeout' | 'chat'
  /** Settles once it has ended. */
  ended: Promise<Finished>
}

/**
 * In the app's own data folder, readable by the user only: output can hold
 * secrets, and a shared temporary folder (Linux's /tmp) could be taken over
 * by another user.
 */
const logDir = join(app.getPath('userData'), 'background')

/** The commands each chat runs, by process ID. */
const running = new Map<string, Map<number, Job>>()

/**
 * Start a command in `cwd`, stopped after `timeout` seconds if given.
 * `onDone` is called once it has ended, unless the chat stopped it.
 */
export async function startBackground(
  chatId: string,
  command: string,
  cwd: string,
  timeout: number | undefined,
  onDone: (finished: Finished) => void
): Promise<Running> {
  await loadShellPath()
  mkdirSync(logDir, { recursive: true, mode: 0o700 })
  const log = join(logDir, `${crypto.randomUUID()}.log`)
  // A new file only: 'wx' fails on an existing name instead of following it.
  const fd = openSync(log, 'wx', 0o600)
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
  const own = running.get(chatId) ?? new Map<number, Job>()
  running.set(chatId, own)
  const job: Job = {
    command,
    pid,
    log,
    started,
    timeout,
    ended: new Promise<Finished>((resolve) => {
      child.once('exit', (code, signal) => {
        own.delete(pid)
        if (own.size === 0 && running.get(chatId) === own) running.delete(chatId)
        clearTimeout(job.timer)
        void lastOutput(log).then((output) =>
          resolve({
            command,
            pid,
            code,
            signal,
            ...(job.stopping === 'timeout' ? { timedOut: timeout } : {}),
            ms: Date.now() - started,
            output,
            log
          })
        )
      })
    })
  }
  if (timeout !== undefined) {
    job.timer = setTimeout(() => stop(job, 'timeout'), timeout * 1000)
  }
  own.set(pid, job)
  void job.ended.then((finished) => {
    if (job.stopping !== 'chat') onDone(finished)
  })
  return runningOf(job)
}

/** The commands a chat runs, oldest first. */
export function listBackground(chatId: string): Running[] {
  return [...(running.get(chatId)?.values() ?? [])].map(runningOf)
}

/** A command the chat runs, and the end of its output so far. */
export async function readBackground(
  chatId: string,
  pid: number
): Promise<Running & { output: string }> {
  const job = jobOf(chatId, pid)
  return { ...runningOf(job), output: await lastOutput(job.log) }
}

/** Stop a command the chat runs; resolves once it has ended, with how it ended. */
export function stopCommand(chatId: string, pid: number): Promise<Finished> {
  const job = jobOf(chatId, pid)
  stop(job, 'chat')
  return job.ended
}

/** Stop the commands a chat runs: it is being deleted. */
export function stopBackground(chatId: string): void {
  for (const job of running.get(chatId)?.values() ?? []) stop(job, 'chat')
  running.delete(chatId)
}

/** Stop a command's process group, killing what is left of it after a grace period. */
function stop(job: Job, reason: 'timeout' | 'chat'): void {
  if (job.stopping) return
  job.stopping = reason
  killGroup(job.pid, 'SIGTERM')
  setTimeout(() => {
    if (groupAlive(job.pid)) killGroup(job.pid, 'SIGKILL')
  }, KILL_GRACE_MS).unref()
}

function jobOf(chatId: string, pid: number): Job {
  const job = running.get(chatId)?.get(pid)
  if (job) return job
  throw new Error(
    `None of your background commands runs as process ${pid}. list_background shows those that run; when one ends, you are told how it went.`
  )
}

function runningOf(job: Job): Running {
  return {
    command: job.command,
    pid: job.pid,
    ms: Date.now() - job.started,
    log: job.log,
    ...(job.timeout !== undefined ? { timeout: job.timeout } : {})
  }
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
