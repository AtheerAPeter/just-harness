import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** Enough for the @ menu in large repos without holding huge lists in memory. */
const MAX_FILES = 5000
/** Skipped when walking a folder that is not a git repository. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  'target',
  '.venv'
])

function gitFiles(projectPath: string): Promise<string[] | undefined> {
  return new Promise((done) => {
    execFile(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: projectPath, maxBuffer: 32 * 1024 * 1024, timeout: 10_000 },
      (error, stdout) =>
        done(error ? undefined : stdout.split('\n').filter(Boolean).slice(0, MAX_FILES))
    )
  })
}

function walk(root: string): string[] {
  const files: string[] = []
  const queue = ['']
  while (queue.length > 0 && files.length < MAX_FILES) {
    const dir = queue.shift()!
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(path)
      } else if (entry.isFile()) {
        files.push(path)
        if (files.length >= MAX_FILES) break
      }
    }
  }
  return files
}

/** Project files for the @ menu, relative to the project root. Respects .gitignore in git repos. */
export async function listProjectFiles(projectPath: string): Promise<string[]> {
  return (await gitFiles(projectPath)) ?? walk(projectPath)
}

/** Resolve an @mention to an absolute file path inside the project, if it names one. */
export function resolveProjectFile(projectPath: string, mention: string): string | undefined {
  const path = resolve(projectPath, mention)
  const rel = relative(projectPath, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return existsSync(path) && statSync(path).isFile() ? path : undefined
}
