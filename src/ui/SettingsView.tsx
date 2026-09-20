import { useState } from 'preact/hooks'
import {
  CONTEXT_PLACEHOLDER,
  DEFAULT_PROMPT_TEMPLATE,
  PLACEHOLDERS,
  renderPrompt,
} from '../api/prompt'
import {
  SOURCE_LANG_NAMES,
  TARGET_LANG_NAMES,
  type ReadingDirection,
  type SourceLang,
  type TargetLang,
} from '../state/schema'
import { resolveContext, useNotes } from '../state/notes'
import type { Endpoint, EndpointKind } from '../state/settings'
import { updateSettings, useStore } from '../state/store'
import { Banner } from './common'

export function SettingsView() {
  const { settings, project } = useStore()
  const { notes } = useNotes()
  const [previewing, setPreviewing] = useState(false)

  const preview = renderPrompt(settings.promptTemplate, {
    meta: project?.project ?? {
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      readingDirection: settings.readingDirection,
    },
    glossary: project?.glossary ?? [],
    context: project ? resolveContext(project, notes) : '',
  })

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
            <select
              id="s-src"
              value={settings.sourceLang}
              onChange={(e) => updateSettings({ sourceLang: e.currentTarget.value as SourceLang })}
            >
              {Object.entries(SOURCE_LANG_NAMES).map(([code, name]) => (
                <option value={code} key={code}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label for="s-dst">To</label>
            <select
              id="s-dst"
              value={settings.targetLang}
              onChange={(e) => updateSettings({ targetLang: e.currentTarget.value as TargetLang })}
            >
              {Object.entries(TARGET_LANG_NAMES).map(([code, name]) => (
                <option value={code} key={code}>
                  {name}
                </option>
              ))}
            </select>
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

      <div class="card">
        <h2>System prompt</h2>
        <p class="muted" style="margin-top:-6px">
          Placeholders: <span class="mono">{PLACEHOLDERS.join(' ')}</span>
        </p>
        <textarea
          rows={14}
          value={settings.promptTemplate}
          onInput={(e) => updateSettings({ promptTemplate: e.currentTarget.value })}
        />
        {!settings.promptTemplate.includes(CONTEXT_PLACEHOLDER) && (
          <Banner kind="warn">
            This template has no <span class="mono">{CONTEXT_PLACEHOLDER}</span>{' '}
            placeholder, so the per-project and per-series notes are not being sent. A
            template that drops a placeholder simply loses that feature -- nothing is
            added behind your back.{' '}
            <button
              class="small"
              onClick={() =>
                updateSettings({
                  promptTemplate:
                    settings.promptTemplate.trimEnd() + '\n\n' + CONTEXT_PLACEHOLDER,
                })
              }
            >
              add it
            </button>
          </Banner>
        )}
        <div class="row" style="margin-top:10px">
          <button onClick={() => setPreviewing((v) => !v)}>
            {previewing ? 'Hide' : 'Show'} rendered prompt
          </button>
          <button
            disabled={settings.promptTemplate === DEFAULT_PROMPT_TEMPLATE}
            onClick={() => updateSettings({ promptTemplate: DEFAULT_PROMPT_TEMPLATE })}
          >
            Reset to default
          </button>
        </div>
        {previewing && (
          <pre class="log" style="margin-top:10px;white-space:pre-wrap">
            {preview}
          </pre>
        )}
      </div>

      <Banner kind="info">
        Gemini safety categories are sent as <span class="mono">OFF</span> so that
        pages with adult or violent content are still translated. A refusal is still
        possible; refused pages are marked blocked and can be retried individually.
      </Banner>
    </div>
  )
}

function EndpointEditor({ endpoint }: { endpoint: Endpoint }) {
  const { settings } = useStore()
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
        <div style="grid-column:1/-1">
          <label>API key</label>
          <input
            type="password"
            autocomplete="off"
            value={endpoint.apiKey}
            onInput={(e) => patch({ apiKey: e.currentTarget.value })}
          />
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
