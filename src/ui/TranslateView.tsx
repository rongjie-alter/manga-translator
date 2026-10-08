import { useEffect, useState } from 'preact/hooks'
import { navigate } from '../app'
import { pendingFiles, planRun } from '../api/batcher'
import {
  dailyCapFor,
  estimateRun,
  formatTokens,
  sumEstimates,
  type Estimate,
} from '../api/estimate'
import { CONTEXT_PLACEHOLDER, renderPrompt } from '../api/prompt'
import { downloadProjectJson } from '../fs/export'
import type { Dimensions } from '../fs/images'
import { NotesTransfer } from './NotesTransfer'
import { createSeries, findSeries, resolveContext, sortedSeries, useNotes } from '../state/notes'
import {
  effectiveStatus,
  translatablePages,
  type ProjectFile,
  type ReadingDirection,
} from '../state/schema'
import { activeEndpoint } from '../state/settings'
import {
  cancelRun,
  chooseLang,
  loadPageBlob,
  setMeta,
  startRun,
  updateProject,
  useStore,
} from '../state/store'
import { Banner, Countdown, STATUS_LABEL, clamp, countByStatus } from './common'
import { LanguageSelect } from './LanguageSelect'

/** Measuring every page to estimate cost would mean decoding every page. Three is plenty. */
const SAMPLE_SIZE = 3

/** Sentinel option value for "create one now" in the series picker. */
const NEW_SERIES = '__new__'

export function TranslateView() {
  const { project, source, settings, run } = useStore()
  const { notes } = useNotes()
  const [sampled, setSampled] = useState<Dimensions[]>([])
  const endpoint = activeEndpoint(settings)

  const files = project ? pendingFiles(project) : []
  const sampleKey = project
    ? translatablePages(project)
        .slice(0, SAMPLE_SIZE)
        .map((p) => p.file)
        .join('|')
    : ''

  useEffect(() => {
    let cancelled = false
    if (sampleKey === '') return
    void measurePages(sampleKey.split('|')).then((dims) => !cancelled && setSampled(dims))
    return () => {
      cancelled = true
    }
  }, [sampleKey])

  if (!project || !source) return null

  const counts = countByStatus(project.pages)
  // Each layout is sent with its own system prompt, so it is estimated on its own and the
  // parts summed. Going through `planRun` keeps the call count what the run will make.
  const context = resolveContext(project, notes)
  const planned = planRun(project, files, project.settings.batchSize)
  const estimate = sumEstimates(
    (['standard', '4koma'] as const).map((layout) =>
      estimateRun({
        pageCount: planned
          .filter((b) => b.layout === layout)
          .reduce((n, b) => n + b.files.length, 0),
        sampled,
        maxEdge: settings.maxEdge,
        batchSize: project.settings.batchSize,
        systemPrompt: renderPrompt(
          layout === '4koma' ? settings.fourKomaPromptTemplate : settings.promptTemplate,
          { meta: project.project, glossary: project.glossary, context },
        ),
      }),
    ),
  )
  const fourKomaCount = project.pages.filter((p) => !p.excluded && p.layout === '4koma').length
  const cap = endpoint ? dailyCapFor(endpoint.model) : null
  const progress = run.batches > 0 ? run.batch / run.batches : 0

  return (
    <div>
      <h1>Translate</h1>
      <p class="sub">
        {files.length} of {translatablePages(project).length} included pages still need
        translating.
        {fourKomaCount > 0 && ` ${fourKomaCount} marked 4-koma, sent separately with the 4-koma prompt.`}
      </p>

      {!endpoint && <Banner kind="error">No endpoint configured. Add one in Settings.</Banner>}
      {endpoint && endpoint.apiKey.trim() === '' && (
        <Banner kind="warn">
          {endpoint.name} has no API key yet. Add one in Settings before starting.
        </Banner>
      )}

      <div class="card">
        <h2>Translation settings</h2>
        <div class="fields">
          <div>
            <label for="src">From</label>
            <LanguageSelect
              id="src"
              value={project.project.sourceLang}
              recent={settings.recentSourceLangs}
              onChange={(code) => chooseLang('source', code)}
            />
          </div>
          <div>
            <label for="dst">To</label>
            <LanguageSelect
              id="dst"
              value={project.project.targetLang}
              recent={settings.recentTargetLangs}
              onChange={(code) => chooseLang('target', code)}
            />
          </div>
          <div>
            <label for="dir">Reading direction</label>
            <select
              id="dir"
              value={project.project.readingDirection}
              onChange={(e) =>
                setMeta({ readingDirection: e.currentTarget.value as ReadingDirection })
              }
            >
              <option value="rtl">Right to left (manga)</option>
              <option value="ltr">Left to right</option>
            </select>
          </div>
          <div>
            <label for="batch">Pages per API call</label>
            <input
              id="batch"
              type="number"
              min={1}
              max={20}
              value={project.settings.batchSize}
              onInput={(e) =>
                updateProject((p) => ({
                  ...p,
                  settings: {
                    ...p.settings,
                    batchSize: clamp(Number(e.currentTarget.value), 1, 20),
                  },
                }))
              }
            />
          </div>
        </div>
      </div>

      <SeriesContextCard project={project} />

      <div class="card">
        <h2>Before you start</h2>
        <EstimateTable estimate={estimate} project={project} cap={cap} />
        <p class="muted" style="margin-top:8px">
          Token counts are estimates. The call count is exact and is what counts against a
          daily quota.
          {estimate.assumedPageSize && ' Page size assumed; images not measured yet.'}
        </p>
        <div class="row" style="margin-top:12px">
          {!run.running ? (
            <>
              <button
                class="primary"
                disabled={files.length === 0 || !endpoint}
                onClick={() => void startRun()}
              >
                {files.length === 0 ? 'Nothing to translate' : 'Translate ' + files.length + ' pages'}
              </button>
              {counts.failed + counts.blocked > 0 && (
                <button
                  onClick={() =>
                    void startRun({
                      files: project.pages
                        .filter((p) => p.status === 'failed' || p.status === 'blocked')
                        .map((p) => p.file),
                    })
                  }
                >
                  Retry {counts.failed + counts.blocked} failed/blocked
                </button>
              )}
            </>
          ) : (
            <button class="danger" onClick={cancelRun}>
              Stop
            </button>
          )}
          {counts.translated > 0 && (
            <>
              <button onClick={() => navigate('review')}>Review</button>
              <button onClick={() => navigate('read')}>Read</button>
            </>
          )}
        </div>
      </div>

      {(run.running || run.log.length > 0) && (
        <div class="card">
          <h2>Progress</h2>
          <div class="bar" style="margin-bottom:10px">
            <div style={'width:' + Math.round(progress * 100) + '%'} />
          </div>
          <div class="row" style="margin-bottom:10px">
            <span>
              {run.batches > 0 ? 'Call ' + run.batch + ' of ' + run.batches : 'Preparing…'}
            </span>
            {run.current.length > 0 && <span class="muted mono">{run.current.join(', ')}</span>}
            {run.waitingUntil !== null && (
              <span class="muted">
                waiting <Countdown until={run.waitingUntil} /> — {run.waitingMessage}
              </span>
            )}
            <span class="spacer" style="flex:1" />
            <span class="muted">
              {run.usage.calls} calls · {formatTokens(run.usage.promptTokens)} in ·{' '}
              {formatTokens(run.usage.completionTokens)} out
            </span>
          </div>
          {run.log.length > 0 && (
            <div class="log">
              {run.log
                .slice()
                .reverse()
                .map((entry, i) => (
                  <div class={entry.level} key={entry.at + ':' + i}>
                    {new Date(entry.at).toLocaleTimeString()} {entry.text}
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      <div class="card">
        <h2>Pages</h2>
        <div class="strip">
          {translatablePages(project).map((page, i) => (
            <span
              key={page.file}
              class={'cell ' + effectiveStatus(page) + (run.current.includes(page.file) ? ' active' : '')}
              title={page.file + ' — ' + STATUS_LABEL[effectiveStatus(page)] + (page.lastRun?.error ? ': ' + page.lastRun.error : '')}
            >
              {i + 1}
            </span>
          ))}
        </div>
        <p class="muted" style="margin-top:10px">
          {counts.translated} translated · {counts.pending} pending · {counts.stale} stale ·{' '}
          {counts.failed} failed · {counts.blocked} blocked
        </p>
      </div>

      <div class="card">
        <h2>Export</h2>
        <p class="muted" style="margin-top:-6px">
          Grab the translations as a JSON file. Save the page images from the Scan page to
          go with it.
        </p>
        <div class="row" style="margin-top:14px">
          <button onClick={() => downloadProjectJson(project, source.jsonName)}>
            Download {source.jsonName}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Which series this project belongs to, and what else the model should know about it.
 *
 * The series link is what makes the glossary portable between volumes; the context box
 * is for everything a term pair cannot express.
 */
function SeriesContextCard({ project }: { project: ProjectFile }) {
  const { settings } = useStore()
  const { notes, loaded } = useNotes()
  const series = findSeries(notes, project.project.seriesId)
  const usesFourKoma = project.pages.some((p) => !p.excluded && p.layout === '4koma')
  const templateTakesContext =
    settings.promptTemplate.includes(CONTEXT_PLACEHOLDER) &&
    (!usesFourKoma || settings.fourKomaPromptTemplate.includes(CONTEXT_PLACEHOLDER))

  const assign = (value: string): void => {
    if (value === NEW_SERIES) {
      const name = prompt('Name of the series', project.project.name)
      if (name === null) return
      const id = createSeries(name)
      if (id !== '') setMeta({ seriesId: id, seriesName: name.trim() })
      return
    }
    const picked = findSeries(notes, value)
    setMeta({ seriesId: picked?.id ?? '', seriesName: picked?.name ?? '' })
  }

  return (
    <div class="card">
      <h2>Series &amp; context</h2>
      <div class="fields">
        <div>
          <label for="series">Series</label>
          <select
            id="series"
            disabled={!loaded}
            value={series ? series.id : ''}
            onChange={(e) => assign(e.currentTarget.value)}
          >
            <option value="">Not part of a series</option>
            {sortedSeries(notes).map((s) => (
              <option value={s.id} key={s.id}>
                {s.name} ({s.terms.length} terms)
              </option>
            ))}
            <option value={NEW_SERIES}>New series…</option>
          </select>
        </div>
      </div>

      {project.project.seriesId !== '' && !series && loaded && (
        <Banner kind="warn">
          This project belongs to “{project.project.seriesName || project.project.seriesId}”,
          which is not in this browser's notes. Import it on the{' '}
          <a href="#/notes">Notes page</a> to reconnect, or pick another series above.
        </Banner>
      )}

      {series && series.context.trim() !== '' && (
        <div style="margin-top:12px">
          <label>Inherited from {series.name}</label>
          <p class="muted" style="white-space:pre-wrap;margin:0">
            {series.context}
          </p>
        </div>
      )}

      <div style="margin-top:12px">
        <label for="context">Additional context for this project</label>
        <textarea
          id="context"
          rows={4}
          placeholder="e.g. This volume is a flashback. Kenji narrates. Signs in the background can stay untranslated."
          value={project.project.context}
          onInput={(e) => setMeta({ context: e.currentTarget.value })}
        />
      </div>

      {!templateTakesContext && project.project.context.trim() !== '' && (
        <Banner kind="warn">
          Your prompt template has no {CONTEXT_PLACEHOLDER} placeholder, so this text is
          not being sent. Add it on the <a href="#/settings">Settings page</a>.
        </Banner>
      )}

      <div style="margin-top:14px">
        <NotesTransfer project={project} />
      </div>
    </div>
  )
}

function EstimateTable({
  estimate,
  project,
  cap,
}: {
  estimate: Estimate
  project: ProjectFile
  cap: number | null
}) {
  const days = cap ? Math.ceil(estimate.calls / cap) : 0
  return (
    <table class="table">
      <tbody>
        <tr>
          <th>API calls</th>
          <td>
            {estimate.calls}
            <span class="muted"> at {project.settings.batchSize} pages per call</span>
            {cap !== null && estimate.calls > cap && (
              <span class="warn" style="color:var(--warn)">
                {' '}
                — over the {cap}/day free tier, about {days} days
              </span>
            )}
          </td>
        </tr>
        <tr>
          <th>Input tokens</th>
          <td>
            ~{formatTokens(estimate.promptTokens)}
            <span class="muted"> ({estimate.imageTokensPerPage} per page image)</span>
          </td>
        </tr>
        <tr>
          <th>Output tokens</th>
          <td>~{formatTokens(estimate.completionTokens)}</td>
        </tr>
      </tbody>
    </table>
  )
}

async function measurePages(files: string[]): Promise<Dimensions[]> {
  const out: Dimensions[] = []
  for (const file of files) {
    try {
      const bitmap = await createImageBitmap(await loadPageBlob(file))
      out.push({ width: bitmap.width, height: bitmap.height })
      bitmap.close()
    } catch {
      // A page that will not decode is a problem for the run, not for the estimate.
    }
  }
  return out
}
