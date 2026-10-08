import { useMemo, useState } from 'preact/hooks'
import { countEditedLines, editLine, revertLine } from '../api/merge'
import {
  affectedLines,
  applyRename,
  glossaryHits,
  occurrenceKey,
  planRename,
  suggestWholeWord,
} from '../api/rename'
import { addSeriesTerms, findSeries, useNotes } from '../state/notes'
import {
  effectiveStatus,
  translatablePages,
  type GlossaryEntry,
  type Line,
  type Page,
  type ProjectFile,
} from '../state/schema'
import { startRun, updateProject, useStore } from '../state/store'
import { Banner, PageImage, StatusDot, STATUS_LABEL } from './common'
import { NotesTransfer } from './NotesTransfer'

/** What the rename panel opens with. `term` ties the sweep to a glossary entry. */
interface SweepSeed {
  from: string
  to: string
  term: string | null
}

export function ReviewView() {
  const { project, run } = useStore()
  const [selected, setSelected] = useState<string | null>(null)
  const [showGlossary, setShowGlossary] = useState(false)
  const [sweep, setSweep] = useState<SweepSeed | null>(null)
  if (!project) return null

  const pages = translatablePages(project)
  const page = pages.find((p) => p.file === selected) ?? pages[0]
  if (!page) return <div class="empty">No pages to review.</div>

  return (
    <div>
      <div class="row" style="margin-bottom:14px">
        <h1 style="margin:0">Review</h1>
        <span class="spacer" style="flex:1" />
        <button onClick={() => setSweep({ from: '', to: '', term: null })}>
          Find &amp; replace
        </button>
        <button onClick={() => setShowGlossary((v) => !v)}>
          {showGlossary ? 'Hide' : 'Show'} glossary ({project.glossary.length})
        </button>
      </div>

      {sweep && (
        <RenamePanel
          project={project}
          seed={sweep}
          key={sweep.term ?? '__free__'}
          onClose={() => setSweep(null)}
        />
      )}

      {showGlossary && (
        <GlossaryEditor
          project={project}
          onFix={(entry) =>
            setSweep({ from: entry.translation, to: entry.translation, term: entry.term })
          }
        />
      )}

      <div class="review">
        <div class="page-list">
          {pages.map((p, i) => (
            <button
              key={p.file}
              aria-current={p.file === page.file ? 'true' : 'false'}
              onClick={() => setSelected(p.file)}
            >
              <StatusDot status={effectiveStatus(p)} />
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
        <StatusDot status={effectiveStatus(page)} />
        <strong class="mono">{page.file}</strong>
        <span class="muted">{STATUS_LABEL[effectiveStatus(page)]}</span>
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

/**
 * Change a term everywhere at once: the glossary entry, and every line already
 * translated with the old wording.
 *
 * Fixing only the glossary is the trap this exists to close -- it corrects the *next*
 * run while leaving ninety pages saying the old name, which is what used to send people
 * into the JSON by hand.
 */
function RenamePanel({
  project,
  seed,
  onClose,
}: {
  project: ProjectFile
  seed: SweepSeed
  onClose: () => void
}) {
  const { notes } = useNotes()
  const [from, setFrom] = useState(seed.from)
  const [to, setTo] = useState(seed.to)
  const [override, setOverride] = useState<boolean | null>(null)
  const [skip, setSkip] = useState<ReadonlySet<string>>(new Set())
  const [done, setDone] = useState<{ count: number; term: string | null } | null>(null)

  const wholeWord = override ?? suggestWholeWord(from)
  const plan = useMemo(
    () => planRename(project, from, to, wholeWord),
    [project, from, to, wholeWord],
  )
  const count = affectedLines(plan, skip)
  const alsoCheck = glossaryHits(project.glossary, from, seed.term ?? '')
  const series = findSeries(notes, project.project.seriesId)

  const retarget = (next: () => void) => {
    setSkip(new Set())
    setDone(null)
    next()
  }

  const apply = () => {
    updateProject((p) => {
      const swept = applyRename(p, plan, skip)
      if (seed.term === null) return swept
      // One update, so a half-applied rename is not a state the autosave can catch.
      return {
        ...swept,
        glossary: swept.glossary.map((e) =>
          e.term === seed.term ? { ...e, translation: to, locked: true } : e,
        ),
      }
    })
    setDone({ count, term: seed.term })
  }

  if (done) {
    return (
      <div class="card">
        <div class="row">
          <strong>
            Replaced in {done.count} line(s).
            {done.term !== null && ' The glossary entry is updated and locked.'}
          </strong>
          <span class="spacer" style="flex:1" />
          {done.term !== null && series && (
            <button
              class="small"
              onClick={() => {
                const entry = project.glossary.find((e) => e.term === done.term)
                if (entry) addSeriesTerms(series.id, [entry])
                onClose()
              }}
            >
              Save “{to}” to {series.name}
            </button>
          )}
          <button class="small" onClick={onClose}>
            Close
          </button>
        </div>
        {done.term !== null && !series && (
          <p class="muted" style="margin:10px 0 0">
            Assign this project to a series in Scan to carry this correction into the
            next volume.
          </p>
        )}
      </div>
    )
  }

  return (
    <div class="card">
      <div class="row">
        <h2 style="margin:0">
          {seed.term === null ? 'Find and replace' : 'Fix “' + seed.term + '” everywhere'}
        </h2>
        <span class="spacer" style="flex:1" />
        <button class="small" onClick={onClose}>
          Cancel
        </button>
      </div>

      <div class="fields" style="margin-top:12px">
        <div>
          <label for="sweep-from">Replace</label>
          <input
            id="sweep-from"
            value={from}
            onInput={(e) => {
              const value = e.currentTarget.value
              retarget(() => setFrom(value))
            }}
          />
        </div>
        <div>
          <label for="sweep-to">With</label>
          <input
            id="sweep-to"
            value={to}
            onInput={(e) => {
              const value = e.currentTarget.value
              retarget(() => setTo(value))
            }}
          />
        </div>
        <div style="align-self:end">
          <label class="check">
            <input
              type="checkbox"
              checked={wholeWord}
              onChange={(e) => {
                const value = e.currentTarget.checked
                retarget(() => setOverride(value))
              }}
            />
            whole words only
          </label>
        </div>
      </div>

      {alsoCheck.length > 0 && (
        <p class="muted" style="margin:12px 0 0">
          Also check these glossary entries, which contain “{from}”:{' '}
          {alsoCheck.map((e) => e.term + ' → ' + e.translation).join(', ')}
        </p>
      )}

      {plan.occurrences.length === 0 ? (
        <p class="muted" style="margin-top:12px">
          {from.trim() === ''
            ? 'Type the text to replace.'
            : from === to
              ? 'The replacement is the same as the original.'
              : 'No translated line contains “' + from + '”.'}
        </p>
      ) : (
        <div style="margin-top:12px">
          <div class="row" style="margin-bottom:8px">
            <span class="muted">
              {count} of {plan.occurrences.length} line(s) selected
            </span>
            <span class="spacer" style="flex:1" />
            <button class="small" onClick={() => setSkip(new Set())}>
              Select all
            </button>
            <button
              class="small"
              onClick={() =>
                setSkip(new Set(plan.occurrences.map((o) => occurrenceKey(o.file, o.lineId))))
              }
            >
              Select none
            </button>
          </div>

          <div class="picker">
            <table class="table">
              <thead>
                <tr>
                  <th style="width:1%" />
                  <th style="width:1%">Page</th>
                  <th>Before</th>
                  <th>After</th>
                </tr>
              </thead>
              <tbody>
                {plan.occurrences.map((o) => {
                  const key = occurrenceKey(o.file, o.lineId)
                  return (
                    <tr key={key}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={'Replace on ' + o.file + ' line ' + o.lineId}
                          checked={!skip.has(key)}
                          onChange={() => {
                            const next = new Set(skip)
                            if (next.has(key)) next.delete(key)
                            else next.add(key)
                            setSkip(next)
                          }}
                        />
                      </td>
                      <td class="mono" style="white-space:nowrap">
                        {o.file} #{o.lineId}
                      </td>
                      <td class="diff-old">{o.before}</td>
                      <td>{o.after}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div class="row" style="margin-top:12px">
        <button class="primary" disabled={count === 0 && seed.term === null} onClick={apply}>
          {count > 0
            ? 'Replace in ' + count + ' line(s)'
            : seed.term !== null
              ? 'Update the glossary entry'
              : 'Replace'}
        </button>
        {seed.term !== null && (
          <span class="muted">
            The glossary entry is updated and locked either way, so future runs use “{to}”.
          </span>
        )}
      </div>
    </div>
  )
}

function GlossaryEditor({
  project,
  onFix,
}: {
  project: ProjectFile
  onFix: (entry: GlossaryEntry) => void
}) {
  const glossary = project.glossary
  return (
    <div class="card">
      <h2>Glossary</h2>
      <p class="muted" style="margin-top:-6px">
        Sent with every request so recurring names stay consistent. Locked entries are
        never changed by the model.
      </p>

      <div style="margin-bottom:14px">
        <NotesTransfer
          project={project}
          onReplaced={(from, to) => onFix({ term: from, translation: to, note: '', locked: true })}
        />
      </div>

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
                    title={'Replace “' + entry.translation + '” in every page already translated'}
                    onClick={() => onFix(entry)}
                  >
                    Fix everywhere…
                  </button>{' '}
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
