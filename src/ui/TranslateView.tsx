import { useEffect, useState } from 'preact/hooks'
import { navigate } from '../app'
import { pendingFiles } from '../api/batcher'
import { dailyCapFor, estimateRun, formatTokens, type Estimate } from '../api/estimate'
import { renderPrompt } from '../api/prompt'
import type { Dimensions } from '../fs/images'
import { resolveContext, useNotes } from '../state/notes'
import { translatablePages, type ProjectFile } from '../state/schema'
import { activeEndpoint } from '../state/settings'
import { cancelRun, loadPageBlob, startRun, useStore } from '../state/store'
import { Banner, Countdown, STATUS_LABEL, countByStatus } from './common'

/** Measuring every page to estimate cost would mean decoding every page. Three is plenty. */
const SAMPLE_SIZE = 3

export function TranslateView() {
  const { project, settings, run } = useStore()
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

  if (!project) return null

  const counts = countByStatus(project.pages)
  const systemPrompt = renderPrompt(settings.promptTemplate, {
    meta: project.project,
    glossary: project.glossary,
    context: resolveContext(project, notes),
  })
  const estimate = estimateRun({
    pageCount: files.length,
    sampled,
    maxEdge: settings.maxEdge,
    batchSize: project.settings.batchSize,
    systemPrompt,
  })
  const cap = endpoint ? dailyCapFor(endpoint.model) : null
  const progress = run.batches > 0 ? run.batch / run.batches : 0

  return (
    <div>
      <h1>Translate</h1>
      <p class="sub">
        {files.length} of {translatablePages(project).length} included pages still need
        translating.
      </p>

      {!endpoint && <Banner kind="error">No endpoint configured. Add one in Settings.</Banner>}
      {endpoint && endpoint.apiKey.trim() === '' && (
        <Banner kind="warn">
          {endpoint.name} has no API key yet. Add one in Settings before starting.
        </Banner>
      )}

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
              class={'cell ' + page.status + (run.current.includes(page.file) ? ' active' : '')}
              title={page.file + ' — ' + STATUS_LABEL[page.status] + (page.lastRun?.error ? ': ' + page.lastRun.error : '')}
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
