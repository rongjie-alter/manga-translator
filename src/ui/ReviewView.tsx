import { useState } from 'preact/hooks'
import { countEditedLines, editLine, revertLine } from '../api/merge'
import {
  translatablePages,
  type GlossaryEntry,
  type Line,
  type Page,
  type ProjectFile,
} from '../state/schema'
import { startRun, updateProject, useStore } from '../state/store'
import { Banner, PageImage, StatusDot, STATUS_LABEL } from './common'

export function ReviewView() {
  const { project, run } = useStore()
  const [selected, setSelected] = useState<string | null>(null)
  const [showGlossary, setShowGlossary] = useState(false)
  if (!project) return null

  const pages = translatablePages(project)
  const page = pages.find((p) => p.file === selected) ?? pages[0]
  if (!page) return <div class="empty">No pages to review.</div>

  return (
    <div>
      <div class="row" style="margin-bottom:14px">
        <h1 style="margin:0">Review</h1>
        <span class="spacer" style="flex:1" />
        <button onClick={() => setShowGlossary((v) => !v)}>
          {showGlossary ? 'Hide' : 'Show'} glossary ({project.glossary.length})
        </button>
      </div>

      {showGlossary && <GlossaryEditor glossary={project.glossary} />}

      <div class="review">
        <div class="page-list">
          {pages.map((p, i) => (
            <button
              key={p.file}
              aria-current={p.file === page.file ? 'true' : 'false'}
              onClick={() => setSelected(p.file)}
            >
              <StatusDot status={p.status} />
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                {i + 1}. {p.file}
              </span>
              <span class="spacer" style="flex:1" />
              <span class="muted">{p.lines.length}</span>
            </button>
          ))}
        </div>

        <div class="page-image">
          <PageImage file={page.file} />
        </div>

        <div>
          <PageHeader page={page} project={project} running={run.running} />
          {page.lines.length === 0 ? (
            <Banner kind={page.status === 'blocked' ? 'error' : 'info'}>
              {page.status === 'pending'
                ? 'Not translated yet.'
                : (page.lastRun?.error ?? STATUS_LABEL[page.status])}
            </Banner>
          ) : (
            <div class="lines">
              {page.lines.map((line) => (
                <LineEditor key={line.id} file={page.file} line={line} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PageHeader({
  page,
  project,
  running,
}: {
  page: Page
  project: ProjectFile
  running: boolean
}) {
  const edited = countEditedLines(page)
  return (
    <div class="card" style="padding:10px 12px">
      <div class="row">
        <StatusDot status={page.status} />
        <strong class="mono">{page.file}</strong>
        <span class="muted">{STATUS_LABEL[page.status]}</span>
        {edited > 0 && <span class="tag">{edited} edited</span>}
        <span class="spacer" style="flex:1" />
        <button
          class="small"
          disabled={running}
          onClick={() => void retranslate(page, project.settings.batchSize)}
        >
          Retranslate page
        </button>
      </div>
      {page.lastRun?.error && (
        <p class="muted" style="margin:8px 0 0">
          Last run: {page.lastRun.error}
        </p>
      )}
    </div>
  )
}

/**
 * Retranslating a page with hand edits asks first, because the edits are the one thing
 * in the project the model cannot reproduce.
 */
async function retranslate(page: Page, _batchSize: number): Promise<void> {
  const edited = countEditedLines(page)
  let policy: 'preserve' | 'overwrite' = 'preserve'
  if (edited > 0) {
    policy = confirm(
      edited +
        ' line(s) on this page have been edited by hand.\n\n' +
        'OK: replace them with the new translation (the old text stays recoverable).\n' +
        'Cancel: keep your edits and only replace the untouched lines.',
    )
      ? 'overwrite'
      : 'preserve'
  }
  await startRun({ files: [page.file], editPolicy: policy })
}

function LineEditor({ file, line }: { file: string; line: Line }) {
  return (
    <div class={'line' + (line.edited ? ' edited' : '')}>
      <div class="head">
        <span class="tag">{line.kind}</span>
        <span>#{line.id}</span>
        <span class="spacer" style="flex:1" />
        {line.edited && (
          <button
            class="small"
            title={'Model wrote: ' + (line.previousTranslation ?? '—')}
            disabled={line.previousTranslation === null}
            onClick={() => applyToLine(file, line.id, revertLine)}
          >
            revert
          </button>
        )}
      </div>
      <div class="original">{line.original || <span class="muted">(no source text)</span>}</div>
      <textarea
        rows={Math.min(6, Math.max(2, Math.ceil(line.translation.length / 60)))}
        value={line.translation}
        onInput={(e) => {
          const text = e.currentTarget.value
          applyToLine(file, line.id, (l) => editLine(l, text))
        }}
      />
    </div>
  )
}

function applyToLine(file: string, id: number, fn: (line: Line) => Line): void {
  updateProject((project) => ({
    ...project,
    pages: project.pages.map((page) =>
      page.file === file
        ? { ...page, lines: page.lines.map((line) => (line.id === id ? fn(line) : line)) }
        : page,
    ),
  }))
}

function GlossaryEditor({ glossary }: { glossary: GlossaryEntry[] }) {
  return (
    <div class="card">
      <h2>Glossary</h2>
      <p class="muted" style="margin-top:-6px">
        Sent with every request so recurring names stay consistent. Locked entries are
        never changed by the model.
      </p>
      {glossary.length === 0 ? (
        <p class="muted">Empty. Terms are added as pages are translated.</p>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>Term</th>
              <th>Translation</th>
              <th>Note</th>
              <th style="width:1%" />
            </tr>
          </thead>
          <tbody>
            {glossary.map((entry) => (
              <tr key={entry.term}>
                <td class="mono">{entry.term}</td>
                <td>
                  <input
                    value={entry.translation}
                    onInput={(e) =>
                      updateGlossary(entry.term, { translation: e.currentTarget.value, locked: true })
                    }
                  />
                </td>
                <td>
                  <input
                    value={entry.note}
                    onInput={(e) => updateGlossary(entry.term, { note: e.currentTarget.value })}
                  />
                </td>
                <td style="white-space:nowrap">
                  <button
                    class="small"
                    title={entry.locked ? 'Locked: the model cannot change this' : 'Lock this term'}
                    onClick={() => updateGlossary(entry.term, { locked: !entry.locked })}
                  >
                    {entry.locked ? '🔒' : '🔓'}
                  </button>{' '}
                  <button class="small danger" onClick={() => removeGlossary(entry.term)}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function updateGlossary(term: string, patch: Partial<GlossaryEntry>): void {
  updateProject((project) => ({
    ...project,
    glossary: project.glossary.map((e) => (e.term === term ? { ...e, ...patch } : e)),
  }))
}

function removeGlossary(term: string): void {
  updateProject((project) => ({
    ...project,
    glossary: project.glossary.filter((e) => e.term !== term),
  }))
}
