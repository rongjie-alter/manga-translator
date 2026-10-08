import { useState } from 'preact/hooks'
import {
  CONTEXT_PLACEHOLDER,
  DEFAULT_4KOMA_PROMPT_TEMPLATE,
  DEFAULT_PROMPT_TEMPLATE,
  PLACEHOLDERS,
  renderPrompt,
  type PromptContext,
} from '../api/prompt'
import type { ReadingDirection } from '../state/schema'
import { resolveContext, useNotes } from '../state/notes'
import type { Endpoint, EndpointKind } from '../state/settings'
import { chooseDefaultLang, updateSettings, useStore } from '../state/store'
import { Banner } from './common'
import { LanguageSelect } from './LanguageSelect'

export function SettingsView() {
  const { settings, project } = useStore()
  const { notes } = useNotes()
  const promptContext: PromptContext = {
    meta: project?.project ?? {
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      readingDirection: settings.readingDirection,
    },
    glossary: project?.glossary ?? [],
    context: project ? resolveContext(project, notes) : '',
  }

  return (
    <div>
      <h1>Settings</h1>
      <p class="sub">
        Stored in this browser only. API keys are never written into a project file.
      </p>

      <div class="card">
        <h2>Endpoints</h2>
        <div>
          <label for="active">Active endpoint</label>
          <select
            id="active"
            value={settings.activeEndpointId}
            onChange={(e) => updateSettings({ activeEndpointId: e.currentTarget.value })}
          >
            {settings.endpoints.map((endpoint) => (
              <option value={endpoint.id} key={endpoint.id}>
                {endpoint.name} — {endpoint.model || 'no model set'}
              </option>
            ))}
          </select>
        </div>
        {settings.endpoints.map((endpoint) => (
          <EndpointEditor key={endpoint.id} endpoint={endpoint} />
        ))}
        <button
          style="margin-top:12px"
          onClick={() =>
            updateSettings({
              endpoints: [
                ...settings.endpoints,
                {
                  id: 'ep-' + settings.endpoints.length + '-' + Math.random().toString(36).slice(2, 7),
                  name: 'New endpoint',
                  baseUrl: 'http://127.0.0.1:8787/v1',
                  apiKey: '',
                  model: '',
                  kind: 'openai',
                  structuredOutput: false,
                },
              ],
            })
          }
        >
          Add endpoint
        </button>
      </div>

      <div class="card">
        <h2>Defaults for new projects</h2>
        <div class="fields">
          <div>
            <label for="s-src">From</label>
            <LanguageSelect
              id="s-src"
              value={settings.sourceLang}
              recent={settings.recentSourceLangs}
              onChange={(code) => chooseDefaultLang('source', code)}
            />
          </div>
          <div>
            <label for="s-dst">To</label>
            <LanguageSelect
              id="s-dst"
              value={settings.targetLang}
              recent={settings.recentTargetLangs}
              onChange={(code) => chooseDefaultLang('target', code)}
            />
          </div>
          <div>
            <label for="s-dir">Reading direction</label>
            <select
              id="s-dir"
              value={settings.readingDirection}
              onChange={(e) =>
                updateSettings({ readingDirection: e.currentTarget.value as ReadingDirection })
              }
            >
              <option value="rtl">Right to left</option>
              <option value="ltr">Left to right</option>
            </select>
          </div>
          <div>
            <label for="s-batch">Pages per API call</label>
            <input
              id="s-batch"
              type="number"
              min={1}
              max={20}
              value={settings.batchSize}
              onInput={(e) => updateSettings({ batchSize: num(e.currentTarget.value, 1, 20, 4) })}
            />
          </div>
          <div>
            <label for="s-edge">Max image edge (px)</label>
            <input
              id="s-edge"
              type="number"
              min={512}
              max={4096}
              step={64}
              value={settings.maxEdge}
              onInput={(e) => updateSettings({ maxEdge: num(e.currentTarget.value, 512, 4096, 1600) })}
            />
          </div>
          <div>
            <label for="s-pdf-edge">PDF render resolution (px)</label>
            <input
              id="s-pdf-edge"
              type="number"
              min={800}
              max={4096}
              step={64}
              value={settings.pdfRenderEdge}
              onInput={(e) =>
                updateSettings({ pdfRenderEdge: num(e.currentTarget.value, 800, 4096, 2400) })
              }
            />
            <p class="muted" style="margin:4px 0 0">
              Independent of the upload size above. Only affects PDF-sourced projects — raise
              it if scanned pages come out too blurry to read.
            </p>
          </div>
          <div>
            <label for="s-thoughts">Reasoning trace</label>
            <select
              id="s-thoughts"
              value={settings.includeThoughts ? 'yes' : 'no'}
              onChange={(e) => updateSettings({ includeThoughts: e.currentTarget.value === 'yes' })}
            >
              <option value="no">Do not request</option>
              <option value="yes">Request (Gemini only, costs tokens)</option>
            </select>
          </div>
        </div>
      </div>

      <PromptEditor
        title="System prompt"
        value={settings.promptTemplate}
        defaultValue={DEFAULT_PROMPT_TEMPLATE}
        onChange={(promptTemplate) => updateSettings({ promptTemplate })}
        preview={(template) => renderPrompt(template, promptContext)}
      />

      <PromptEditor
        title="4-koma system prompt"
        description="Used instead of the prompt above for pages you mark as 4-koma on the Pages screen. Those pages are batched together, so this prompt can state the reading order outright."
        value={settings.fourKomaPromptTemplate}
        defaultValue={DEFAULT_4KOMA_PROMPT_TEMPLATE}
        onChange={(fourKomaPromptTemplate) => updateSettings({ fourKomaPromptTemplate })}
        preview={(template) => renderPrompt(template, promptContext)}
      />

      <Banner kind="info">
        Gemini safety categories are sent as <span class="mono">OFF</span> so that
        pages with adult or violent content are still translated. A refusal is still
        possible; refused pages are marked blocked and can be retried individually.
      </Banner>
    </div>
  )
}

/** One system-prompt template: editor, missing-`{context}` warning, reset and rendered preview. */
function PromptEditor({
  title,
  description,
  value,
  defaultValue,
  onChange,
  preview,
}: {
  title: string
  description?: string
  value: string
  defaultValue: string
  onChange: (value: string) => void
  preview: (template: string) => string
}) {
  const [previewing, setPreviewing] = useState(false)
  return (
    <div class="card">
      <h2>{title}</h2>
      {description && (
        <p class="muted" style="margin-top:-6px">
          {description}
        </p>
      )}
      <p class="muted" style="margin-top:-6px">
        Placeholders: <span class="mono">{PLACEHOLDERS.join(' ')}</span>
      </p>
      <textarea
        rows={14}
        value={value}
        onInput={(e) => onChange(e.currentTarget.value)}
      />
      {!value.includes(CONTEXT_PLACEHOLDER) && (
        <Banner kind="warn">
          This template has no <span class="mono">{CONTEXT_PLACEHOLDER}</span> placeholder,
          so the per-project and per-series notes are not being sent. A template that drops
          a placeholder simply loses that feature -- nothing is added behind your back.{' '}
          <button class="small" onClick={() => onChange(value.trimEnd() + '\n\n' + CONTEXT_PLACEHOLDER)}>
            add it
          </button>
        </Banner>
      )}
      <div class="row" style="margin-top:10px">
        <button onClick={() => setPreviewing((v) => !v)}>
          {previewing ? 'Hide' : 'Show'} rendered prompt
        </button>
        <button disabled={value === defaultValue} onClick={() => onChange(defaultValue)}>
          Reset to default
        </button>
      </div>
      {previewing && (
        <pre class="log" style="margin-top:10px;white-space:pre-wrap">
          {preview(value)}
        </pre>
      )}
    </div>
  )
}

function EndpointEditor({ endpoint }: { endpoint: Endpoint }) {
  const { settings } = useStore()
  const [showKey, setShowKey] = useState(false)
  const patch = (change: Partial<Endpoint>) =>
    updateSettings({
      endpoints: settings.endpoints.map((e) => (e.id === endpoint.id ? { ...e, ...change } : e)),
    })

  return (
    <div class="card" style="background:var(--panel-2);margin:12px 0 0">
      <div class="fields">
        <div>
          <label>Name</label>
          <input value={endpoint.name} onInput={(e) => patch({ name: e.currentTarget.value })} />
        </div>
        <div>
          <label>Model</label>
          <input value={endpoint.model} onInput={(e) => patch({ model: e.currentTarget.value })} />
        </div>
        <div style="grid-column:1/-1">
          <label>Base URL</label>
          <input
            class="mono"
            value={endpoint.baseUrl}
            onInput={(e) => patch({ baseUrl: e.currentTarget.value })}
          />
        </div>
        <div style="grid-column:1/3">
          <label>API key</label>
          <div class="row" style="gap:8px">
            <input
              type={showKey ? 'text' : 'password'}
              autocomplete="off"
              value={endpoint.apiKey}
              onInput={(e) => patch({ apiKey: e.currentTarget.value })}
              style="flex:1"
            />
            <button
              type="button"
              class="small"
              style="flex-shrink:0"
              onClick={() => setShowKey((v) => !v)}
            >
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
          {endpoint.kind == "gemini" && (
            <p class="muted" style="margin:4px 0 0">
              Keys stay in this browser and are sent only to the endpoint above. They are never included in exported translation files.
              {" "}<a href="https://aistudio.google.com/api-keys" target="_blank">Get a key.</a>
            </p>
          )}
        </div>
        <div>
          <label>Provider</label>
          <select
            value={endpoint.kind}
            onChange={(e) => patch({ kind: e.currentTarget.value as EndpointKind })}
          >
            <option value="gemini">Gemini (sends safety settings)</option>
            <option value="openai">Plain OpenAI-compatible</option>
          </select>
        </div>
        <div>
          <label>Structured output</label>
          <select
            value={endpoint.structuredOutput ? 'yes' : 'no'}
            onChange={(e) => patch({ structuredOutput: e.currentTarget.value === 'yes' })}
          >
            <option value="yes">Send a JSON schema</option>
            <option value="no">Ask for JSON in the prompt only</option>
          </select>
        </div>
      </div>
      {settings.endpoints.length > 1 && (
        <button
          class="small danger"
          style="margin-top:10px"
          onClick={() =>
            updateSettings({
              endpoints: settings.endpoints.filter((e) => e.id !== endpoint.id),
              activeEndpointId:
                settings.activeEndpointId === endpoint.id
                  ? (settings.endpoints.find((e) => e.id !== endpoint.id)?.id ?? '')
                  : settings.activeEndpointId,
            })
          }
        >
          Remove {endpoint.name}
        </button>
      )}
    </div>
  )
}

function num(value: string, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}
