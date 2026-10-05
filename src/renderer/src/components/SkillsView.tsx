import { useCallback, useEffect, useState } from 'react'
import { AGENTS, type Project, type Skill, type SkillScope } from '../../../shared/types'
import { PlusIcon } from './icons'

interface SkillsViewProps {
  project?: Project
}

export function SkillsView({ project }: SkillsViewProps): React.JSX.Element {
  const [skills, setSkills] = useState<Skill[]>([])
  const [selected, setSelected] = useState<string>()
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string>()
  const projectPath = project?.path

  const refresh = useCallback(async () => {
    setSkills(await window.api.skills.list(projectPath))
  }, [projectPath])

  useEffect(() => {
    let cancelled = false
    window.api.skills.list(projectPath).then((list) => {
      if (!cancelled) setSkills(list)
    })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  useEffect(() => {
    if (!selected) return
    window.api.skills.read(selected, projectPath).then((text) => {
      setContent(text)
      setSaved(text)
    })
  }, [selected, projectPath])

  async function run(action: () => Promise<void>): Promise<void> {
    setError(undefined)
    try {
      await action()
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : String(e)
      )
    }
  }

  const current = skills.find((s) => s.path === selected)
  const dirty = content !== saved

  function save(path: string): Promise<void> {
    return run(async () => {
      await window.api.skills.save(path, content, projectPath)
      setSaved(content)
      await refresh()
    })
  }
  const groups: { scope: SkillScope; title: string }[] = [
    ...(project ? [{ scope: 'project' as const, title: project.name }] : []),
    { scope: 'global', title: 'Global' }
  ]

  return (
    <div className="skills">
      <div className="skills-list">
        <div className="skills-header">
          <h2>Skills</h2>
          <button className="icon-btn" title="New skill" onClick={() => setCreating(true)}>
            <PlusIcon />
          </button>
        </div>
        {creating && (
          <NewSkillForm
            hasProject={Boolean(project)}
            onCancel={() => setCreating(false)}
            onCreate={(name, scope) =>
              run(async () => {
                const path = await window.api.skills.create(name, scope, projectPath)
                setCreating(false)
                await refresh()
                setSelected(path)
              })
            }
          />
        )}
        {groups.map((group) => {
          const inGroup = skills.filter((s) => s.scope === group.scope)
          return (
            <div key={group.scope} className="skills-group">
              <div className="section-label">{group.title}</div>
              {inGroup.length === 0 && <div className="muted small">No skills</div>}
              {inGroup.map((skill) => (
                <button
                  key={skill.path}
                  className={`skill-row${skill.path === selected ? ' selected' : ''}`}
                  onClick={() => setSelected(skill.path)}
                >
                  <span className="skill-name">{skill.name}</span>
                  <span className="skill-desc">{skill.description}</span>
                </button>
              ))}
            </div>
          )
        })}
        {!project && (
          <p className="muted small">Select a chat or project to see its project skills.</p>
        )}
      </div>
      <div className="skills-editor">
        {error && <div className="msg-error">{error}</div>}
        {current ? (
          <>
            <div className="skills-editor-bar">
              <div>
                <strong>{current.name}</strong>
                <div className="muted small">
                  Used by{' '}
                  {current.agents.map((a) => AGENTS.find((x) => x.id === a)?.label).join(' and ')} ·{' '}
                  <button className="link" onClick={() => window.api.skills.reveal(current.path)}>
                    {current.path}
                  </button>
                </div>
              </div>
              <div className="spacer" />
              <button
                className="btn"
                onClick={() =>
                  confirm(`Delete the skill "${current.name}"?`) &&
                  run(async () => {
                    await window.api.skills.remove(current.path, projectPath)
                    setSelected(undefined)
                    await refresh()
                  })
                }
              >
                Delete
              </button>
              <button className="btn primary" disabled={!dirty} onClick={() => save(current.path)}>
                Save
              </button>
            </div>
            <textarea
              className="skill-textarea"
              spellCheck={false}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 's' && e.metaKey && dirty) {
                  e.preventDefault()
                  save(current.path)
                }
              }}
            />
          </>
        ) : (
          <div className="skills-empty">
            <h2>Agent skills</h2>
            <p>
              A skill is a folder with a <code>SKILL.md</code> file. Its description tells the agent
              when to load it. Project skills live in <code>.claude/skills</code>, which OpenCode
              and Cline both read; Command Code is pointed to them when you use one. Global skills
              live in <code>~/.claude/skills</code> and are linked into <code>~/.cline/skills</code>{' '}
              and <code>~/.commandcode/skills</code>.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function NewSkillForm({
  hasProject,
  onCreate,
  onCancel
}: {
  hasProject: boolean
  onCreate: (name: string, scope: SkillScope) => void
  onCancel: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [scope, setScope] = useState<SkillScope>(hasProject ? 'project' : 'global')
  return (
    <form
      className="new-skill"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) onCreate(name.trim(), scope)
      }}
    >
      <input
        autoFocus
        placeholder="skill-name"
        value={name}
        onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      />
      <div className="segmented">
        <button
          type="button"
          disabled={!hasProject}
          className={scope === 'project' ? 'on' : ''}
          onClick={() => setScope('project')}
        >
          Project
        </button>
        <button
          type="button"
          className={scope === 'global' ? 'on' : ''}
          onClick={() => setScope('global')}
        >
          Global
        </button>
      </div>
      <div className="new-skill-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={!name.trim()}>
          Create
        </button>
      </div>
    </form>
  )
}
