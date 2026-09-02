import { navigate } from '../app'
import {
  SOURCE_LANG_NAMES,
  TARGET_LANG_NAMES,
  type Page,
  type ProjectFile,
  type ReadingDirection,
  type SourceLang,
  type TargetLang,
} from '../state/schema'
import { openSource, saveNow, updateProject, useStore } from '../state/store'
import { Banner, PageImage, StatusDot, countByStatus } from './common'
import { useState } from 'preact/hooks'

export function ScanView() {
  const { project, source, report } = useStore()
  const [rescanning, setRescanning] = useState(false)
  if (!project || !source) return null

  const counts = countByStatus(project.pages)
  const included = project.pages.filter((p) => !p.excluded).length

  return (
    <div>
      <h1>{project.project.name}</h1>
      <p class="sub">
        {project.pages.length} pages found · {included} included · translations saved to{' '}
        <span class="mono">{source.jsonName}</span>
      </p>

      {report && (report.added.length > 0 || report.removed.length > 0 || report.changed.length > 0) && (
        <Banner kind="info">
          {report.added.length > 0 && <span>{report.added.length} new page(s). </span>}
          {report.removed.length > 0 && (
            <span>{report.removed.length} page(s) no longer on disk were dropped. </span>
          )}
          {report.changed.length > 0 && (
            <span>
              {report.changed.length} image(s) changed since translating and are marked stale.
            </span>
          )}
        </Banner>
      )}

      <div class="card">
        <h2>Translation settings</h2>
        <div class="fields">
          <div>
            <label for="src">From</label>
            <select
              id="src"
              value={project.project.sourceLang}
              onChange={(e) =>
                setMeta({ sourceLang: e.currentTarget.value as SourceLang })
              }
            >
              {Object.entries(SOURCE_LANG_NAMES).map(([code, name]) => (
                <option value={code} key={code}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label for="dst">To</label>
            <select
              id="dst"
              value={project.project.targetLang}
              onChange={(e) =>
                setMeta({ targetLang: e.currentTarget.value as TargetLang })
              }
            >
              {Object.entries(TARGET_LANG_NAMES).map(([code, name]) => (
                <option value={code} key={code}>
                  {name}
                </option>
              ))}
            </select>
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
        <div class="row" style="margin-top:14px">
          <button class="primary" onClick={() => navigate('translate')}>
            Continue to translate
          </button>
          <button onClick={() => void saveNow()}>Save now</button>
          <button
            disabled={rescanning}
            onClick={async () => {
              setRescanning(true)
              try {
                await openSource(source)
              } finally {
                setRescanning(false)
              }
            }}
          >
            {rescanning ? 'Rescanning…' : 'Rescan folder'}
          </button>
          <span class="muted">
            {counts.translated} translated · {counts.pending} pending · {counts.stale} stale ·{' '}
            {counts.failed} failed · {counts.blocked} blocked
          </span>
        </div>
      </div>

      <div class="card">
        <h2>Pages</h2>
        <p class="muted" style="margin-top:-6px">
          Excluded pages are skipped by the translator and hidden in the reader. Use this
          for covers, ads and afterwords.
        </p>
        <div class="pages">
          {ordered(project).map((page, position) => (
            <PageCard
              key={page.file}
              page={page}
              position={position}
              last={position === project.pages.length - 1}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function PageCard({ page, position, last }: { page: Page; position: number; last: boolean }) {
  return (
    <div class={'page-card' + (page.excluded ? ' excluded' : '')}>
      <PageImage file={page.file} />
      <div class="meta">
        <span title={page.file} style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          {position + 1}. {page.file}
        </span>
        <StatusDot status={page.status} />
      </div>
      <div class="controls">
        <button class="small" disabled={position === 0} onClick={() => move(page.file, -1)}>
          ↑
        </button>
        <button class="small" disabled={last} onClick={() => move(page.file, 1)}>
          ↓
        </button>
        <button class="small" onClick={() => toggleExcluded(page.file)}>
          {page.excluded ? 'include' : 'exclude'}
        </button>
      </div>
    </div>
  )
}

function ordered(project: ProjectFile): Page[] {
  return project.pages.slice().sort((a, b) => a.index - b.index)
}

function setMeta(patch: Partial<ProjectFile['project']>): void {
  updateProject((p) => ({ ...p, project: { ...p.project, ...patch } }))
}

/** Swap a page with its neighbour, then renumber so `index` stays contiguous. */
function move(file: string, delta: number): void {
  updateProject((project) => {
    const pages = ordered(project)
    const at = pages.findIndex((p) => p.file === file)
    const to = at + delta
    if (at < 0 || to < 0 || to >= pages.length) return project
    const swapped = pages.slice()
    swapped[at] = pages[to]!
    swapped[to] = pages[at]!
    return { ...project, pages: swapped.map((page, i) => ({ ...page, index: i })) }
  })
}

function toggleExcluded(file: string): void {
  updateProject((project) => ({
    ...project,
    pages: project.pages.map((p) => (p.file === file ? { ...p, excluded: !p.excluded } : p)),
  }))
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.round(n)))
}
