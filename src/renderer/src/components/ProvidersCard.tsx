import { useEffect, useState } from 'react'
import {
  PROVIDER_PRESETS,
  type CustomProvider,
  type CustomProviderCheck,
  type ProviderApi
} from '../../../shared/types'
import { errorMessage } from '../lib/errors'
import { Picker } from './Picker'
import { RowMenu } from './RowMenu'

const API_NAMES: Record<ProviderApi, string> = {
  chat: 'Chat Completions',
  responses: 'Responses',
  messages: 'Anthropic Messages'
}

/**
 * The providers the Custom providers agent runs on: any API that speaks one of
 * the three formats, added, changed and removed here. Each row says how many
 * models the provider lists, or why it could not list them.
 */
export function ProvidersCard({ onChange }: { onChange: () => void }): React.JSX.Element {
  const [providers, setProviders] = useState<CustomProvider[]>()
  /** Each provider's last check; undefined while it runs. */
  const [checks, setChecks] = useState<Record<string, CustomProviderCheck | undefined>>({})
  /** The provider being changed, or 'new' while one is added. */
  const [editing, setEditing] = useState<CustomProvider | 'new'>()

  function check(id: string): void {
    setChecks((c) => ({ ...c, [id]: undefined }))
    window.api.providers.check(id).then((result) => setChecks((c) => ({ ...c, [id]: result })))
  }

  useEffect(() => {
    window.api.providers.list().then((list) => {
      setProviders(list)
      for (const provider of list) check(provider.id)
    })
  }, [])

  function saved(provider: CustomProvider): void {
    setProviders((list = []) =>
      list.some((p) => p.id === provider.id)
        ? list.map((p) => (p.id === provider.id ? provider : p))
        : [...list, provider]
    )
    setEditing(undefined)
    check(provider.id)
    onChange()
  }

  async function remove(id: string): Promise<void> {
    await window.api.providers.remove(id)
    setProviders((list = []) => list.filter((p) => p.id !== id))
    if (editing !== 'new' && editing?.id === id) setEditing(undefined)
    onChange()
  }

  return (
    <section className="settings-card">
      <h3>Providers</h3>
      <p>
        Add any API that speaks OpenAI Chat Completions, OpenAI Responses or Anthropic Messages. Its
        models show in the model picker under Custom providers, and chats on them run on the
        app&apos;s own agent.
      </p>
      {providers && providers.length > 0 && (
        <div className="provider-list">
          {providers.map((provider) =>
            editing !== 'new' && editing?.id === provider.id ? (
              <ProviderForm
                key={provider.id}
                provider={provider}
                onSaved={saved}
                onCancel={() => setEditing(undefined)}
              />
            ) : (
              <ProviderRow
                key={provider.id}
                provider={provider}
                check={checks[provider.id]}
                onEdit={() => setEditing(provider)}
                onCheck={() => check(provider.id)}
                onRemove={() => remove(provider.id)}
              />
            )
          )}
        </div>
      )}
      {editing === 'new' ? (
        <ProviderForm onSaved={saved} onCancel={() => setEditing(undefined)} />
      ) : (
        <div className="settings-row">
          <button type="button" className="btn" onClick={() => setEditing('new')}>
            Add provider
          </button>
        </div>
      )}
    </section>
  )
}

function ProviderRow({
  provider,
  check,
  onEdit,
  onCheck,
  onRemove
}: {
  provider: CustomProvider
  check: CustomProviderCheck | undefined
  onEdit: () => void
  onCheck: () => void
  onRemove: () => void
}): React.JSX.Element {
  const status = !check
    ? 'Listing models…'
    : check.error
      ? check.error
      : `${check.models} model${check.models === 1 ? '' : 's'}`
  return (
    <div className="provider-row">
      <div className="provider-row-text">
        <span className="provider-row-name">{provider.name}</span>
        <span className="provider-row-detail">
          {API_NAMES[provider.api]} · {provider.baseURL}
        </span>
        <span className={`provider-row-detail${check?.error ? ' error' : ''}`}>{status}</span>
      </div>
      <RowMenu
        label={`${provider.name} options`}
        items={[
          { name: 'Edit', onSelect: onEdit },
          { name: 'List models again', onSelect: onCheck },
          { name: 'Remove', danger: true, onSelect: onRemove }
        ]}
      />
    </div>
  )
}

/** "Name: value" per line, as the headers field shows them. */
const headerLines = (headers: Record<string, string>): string =>
  Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')

function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const colon = line.indexOf(':')
    if (colon <= 0) throw new Error(`Write each header as "Name: value" ("${line.trim()}").`)
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  return headers
}

function ProviderForm({
  provider,
  onSaved,
  onCancel
}: {
  /** The provider to change; unset to add one. */
  provider?: CustomProvider
  onSaved: (provider: CustomProvider) => void
  onCancel: () => void
}): React.JSX.Element {
  const [preset, setPreset] = useState('')
  const [name, setName] = useState(provider?.name ?? '')
  const [api, setApi] = useState<ProviderApi>(provider?.api ?? 'chat')
  const [baseURL, setBaseURL] = useState(provider?.baseURL ?? '')
  const [key, setKey] = useState('')
  /** Set when the user removes the saved key. */
  const [keyRemoved, setKeyRemoved] = useState(false)
  const [headers, setHeaders] = useState(headerLines(provider?.headers ?? {}))
  const [models, setModels] = useState(provider?.models.join('\n') ?? '')
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const keyless = PROVIDER_PRESETS.find((p) => p.name === preset)?.keyless
  const savedKey = provider?.keyHint && !keyRemoved ? provider.keyHint : undefined

  function choosePreset(value: string): void {
    const chosen = PROVIDER_PRESETS.find((p) => p.name === value)
    if (!chosen) return
    setPreset(value)
    setName(chosen.name)
    setApi(chosen.api)
    setBaseURL(chosen.baseURL)
  }

  async function submit(): Promise<void> {
    setError(undefined)
    setSaving(true)
    try {
      onSaved(
        await window.api.providers.save({
          id: provider?.id,
          name,
          api,
          baseURL,
          headers: parseHeaders(headers),
          models: models.split('\n'),
          // Empty keeps the saved key.
          apiKey: key.trim() ? key : keyRemoved ? null : undefined
        })
      )
    } catch (e) {
      setError(errorMessage(e))
      setSaving(false)
    }
  }

  return (
    <form
      className="provider-form"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      onKeyDown={(e) => {
        // An open preset list closes first, and says so.
        if (e.key !== 'Escape' || e.defaultPrevented) return
        // Handled: cancelling the form must not also leave Settings.
        e.preventDefault()
        onCancel()
      }}
    >
      {!provider && (
        <Picker
          value={preset}
          placeholder="Start from a preset"
          values={PROVIDER_PRESETS.map((p) => ({
            value: p.name,
            name: p.name,
            description: p.baseURL
          }))}
          onChange={choosePreset}
        />
      )}
      <label className="provider-field">
        <span>Name</span>
        <input
          autoFocus
          value={name}
          placeholder="My provider"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="provider-field">
        <span>API</span>
        <div className="segmented">
          {(Object.keys(API_NAMES) as ProviderApi[]).map((value) => (
            <button
              key={value}
              type="button"
              className={api === value ? 'on' : ''}
              onClick={() => setApi(value)}
            >
              {API_NAMES[value]}
            </button>
          ))}
        </div>
      </div>
      <label className="provider-field">
        <span>Base URL</span>
        <input
          value={baseURL}
          placeholder={api === 'messages' ? 'https://api.anthropic.com/v1' : 'https://…/v1'}
          spellCheck={false}
          onChange={(e) => setBaseURL(e.target.value)}
        />
      </label>
      <div className="provider-field">
        <span>API key</span>
        <div className="settings-row">
          <input
            type="password"
            value={key}
            placeholder={
              savedKey
                ? `Saved key ending in ${savedKey}`
                : keyless
                  ? 'Not needed for a local server'
                  : 'Leave empty if the provider takes none'
            }
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setKey(e.target.value)}
          />
          {savedKey && (
            <button type="button" className="btn" onClick={() => setKeyRemoved(true)}>
              Remove key
            </button>
          )}
        </div>
      </div>
      <label className="provider-field">
        <span>Headers</span>
        <textarea
          rows={2}
          value={headers}
          placeholder="One per line, as Name: value"
          spellCheck={false}
          onChange={(e) => setHeaders(e.target.value)}
        />
      </label>
      <label className="provider-field">
        <span>Models</span>
        <textarea
          rows={3}
          value={models}
          placeholder="Model ids, one per line. Leave empty to list the provider's models."
          spellCheck={false}
          onChange={(e) => setModels(e.target.value)}
        />
      </label>
      {error && <div className="msg-error">{error}</div>}
      <div className="new-skill-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn primary"
          disabled={saving || !name.trim() || !baseURL.trim()}
        >
          {provider ? 'Save' : 'Add'}
        </button>
      </div>
    </form>
  )
}
