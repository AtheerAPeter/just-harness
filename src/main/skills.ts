import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { parse } from 'yaml'
import type { AgentId, Skill, SkillScope } from '../shared/types'

/**
 * Where each CLI discovers skills (https://opencode.ai/docs/skills,
 * https://docs.cline.bot/customization/skills, https://commandcode.ai/docs/skills).
 * New project skills go to `.claude/skills`, which opencode and cline read. There
 * is no global folder they all read, so global skills go to `~/.claude/skills`
 * and get a symlink in `~/.cline/skills` and `~/.commandcode/skills`.
 */
const home = homedir()
const GLOBAL_DIRS: { dir: string; agents: AgentId[] }[] = [
  { dir: join(home, '.claude/skills'), agents: ['opencode'] },
  { dir: join(home, '.config/opencode/skills'), agents: ['opencode'] },
  { dir: join(home, '.agents/skills'), agents: ['opencode', 'commandcode'] },
  { dir: join(home, '.cline/skills'), agents: ['cline'] },
  { dir: join(home, '.commandcode/skills'), agents: ['commandcode'] }
]
const PROJECT_DIRS: { dir: string; agents: AgentId[] }[] = [
  { dir: '.claude/skills', agents: ['opencode', 'cline'] },
  { dir: '.opencode/skills', agents: ['opencode'] },
  { dir: '.agents/skills', agents: ['opencode', 'commandcode'] },
  { dir: '.cline/skills', agents: ['cline'] },
  { dir: '.clinerules/skills', agents: ['cline'] },
  { dir: '.commandcode/skills', agents: ['commandcode'] }
]
const PRIMARY_GLOBAL = GLOBAL_DIRS[0].dir
/** Global folders that get a symlink to each global skill the app creates. */
const LINKED_GLOBALS = [GLOBAL_DIRS[3].dir, GLOBAL_DIRS[4].dir]
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  try {
    const data = parse(match[1]) as Record<string, unknown> | null
    return {
      name: typeof data?.name === 'string' ? data.name : undefined,
      description: typeof data?.description === 'string' ? data.description.trim() : undefined
    }
  } catch {
    // Invalid YAML: list the skill by folder name so it can still be opened and fixed.
    return {}
  }
}

function scan(dir: string, scope: SkillScope, agents: AgentId[], found: Map<string, Skill>): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    const skillFile = join(dir, entry, 'SKILL.md')
    if (!existsSync(skillFile)) continue
    // The same skill may be visible through several folders (e.g. a symlink); merge them.
    const key = `${scope}:${entry}`
    const existing = found.get(key)
    if (existing) {
      existing.agents = [...new Set([...existing.agents, ...agents])]
      continue
    }
    const meta = parseFrontmatter(readFileSync(skillFile, 'utf8'))
    found.set(key, {
      name: meta.name || entry,
      description: meta.description ?? '',
      path: skillFile,
      scope,
      agents: [...agents]
    })
  }
}

export function listSkills(projectPath?: string): Skill[] {
  const found = new Map<string, Skill>()
  if (projectPath) {
    for (const { dir, agents } of PROJECT_DIRS)
      scan(join(projectPath, dir), 'project', agents, found)
  }
  for (const { dir, agents } of GLOBAL_DIRS) scan(dir, 'global', agents, found)
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function allowedRoots(projectPath?: string): string[] {
  const roots = GLOBAL_DIRS.map((d) => d.dir)
  if (projectPath) roots.push(...PROJECT_DIRS.map((d) => join(projectPath, d.dir)))
  return roots
}

/** Only touch files inside known skill folders. */
function assertSkillPath(path: string, projectPath?: string): void {
  const inside = allowedRoots(projectPath).some((root) => {
    const rel = relative(root, path)
    return rel && !rel.startsWith('..') && !isAbsolute(rel)
  })
  if (!inside || !path.endsWith('SKILL.md')) throw new Error(`Not a skill file: ${path}`)
}

export function readSkill(path: string, projectPath?: string): string {
  assertSkillPath(path, projectPath)
  return readFileSync(path, 'utf8')
}

export function template(name: string): string {
  return `---\nname: ${name}\ndescription: Describe what this skill does and when the agent should use it.\n---\n\n# ${name}\n\nInstructions for the agent.\n`
}

export function createSkill(name: string, scope: SkillScope, projectPath?: string): string {
  if (!NAME_RE.test(name) || name.length > 64) {
    throw new Error(
      'Skill names use lowercase letters, digits and single hyphens (max 64 characters).'
    )
  }
  if (scope === 'project' && !projectPath) throw new Error('Select a project first.')
  const root = scope === 'project' ? join(projectPath!, '.claude/skills') : PRIMARY_GLOBAL
  const dir = join(root, name)
  if (existsSync(dir)) throw new Error(`A skill named "${name}" already exists.`)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  writeFileSync(file, template(name))
  if (scope === 'global') {
    for (const linked of LINKED_GLOBALS) {
      mkdirSync(linked, { recursive: true })
      const link = join(linked, name)
      if (!existsSync(link)) symlinkSync(dir, link, 'dir')
    }
  }
  return file
}

export function saveSkill(path: string, content: string, projectPath?: string): void {
  assertSkillPath(path, projectPath)
  writeFileSync(path, content)
}

export function deleteSkill(path: string, projectPath?: string): void {
  assertSkillPath(path, projectPath)
  const dir = dirname(path)
  const name = dir.split('/').pop()!
  rmSync(dir, { recursive: true, force: true })
  // Remove the symlinks we created for global skills.
  if (!dir.startsWith(PRIMARY_GLOBAL)) return
  for (const linked of LINKED_GLOBALS) {
    const link = join(linked, name)
    if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(link)
  }
}
