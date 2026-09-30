import { useRef, useState } from 'preact/hooks'
import { addGlossaryEntries } from '../api/merge'
import {
  CONTEXT_WARN_CHARS,
  NOTES_FILE_NAME,
  addSeriesTerms,
  clearNotesError,
  createSeries,
  deleteSeries,
  findSeries,
  importNotes,
  inspectNotesImport,
  parseImport,
  removeSeriesTerm,
  renameSeries,
  serializeNotes,
  setSeriesContext,
  sortedSeries,
  updateSeriesTerm,
  useNotes,
  type ImportConflictPolicy,
  type NotesImportInspection,
  type Series,
} from '../state/notes'
import type { GlossaryEntry } from '../state/schema'
import { updateProject, useStore } from '../state/store'
import { Banner } from './common'

export function NotesView() {
  const { notes, loaded, error } = useNotes()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)

  const [importPending, setImportPending] = useState<
    | { kind: 'notes'; fileName: string; series: Series[]; inspection: NotesImportInspection }
    | { kind: 'project'; fileName: string; name: string; terms: GlossaryEntry[] }
    | null
  >(null)
  const [policy, setPolicy] = useState<ImportConflictPolicy>('overwrite')
  const [targetSeriesId, setTargetSeriesId] = useState<string>('')
  const [newSeriesName, setNewSeriesName] = useState<string>('')

  const all = sortedSeries(notes)
  const selected = findSeries(notes, selectedId ?? '') ?? all[0]

  const openFilePicker = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return

    let raw: unknown
    try {
      raw = JSON.parse(await file.text())
    } catch {
      setNote(file.name + ' is not valid JSON.')
      return
    }

    const parsed = parseImport(raw)
    if (parsed.kind === 'unknown') {
      setNote(file.name + ' is neither a notes export nor a project file.')
      return
    }

    if (parsed.kind === 'notes') {
      if (parsed.series.length === 0) {
        setNote(file.name + ' has no series in it.')
        return
      }
      const inspection = inspectNotesImport(notes, parsed.series)
      setImportPending({
        kind: 'notes',
        fileName: file.name,
        series: parsed.series,
        inspection,
      })
      setPolicy('overwrite')
      if (typeof dialogRef.current?.showModal === 'function') {
        dialogRef.current.showModal()
      }
      return
    }

    if (parsed.kind === 'project') {
      if (parsed.terms.length === 0) {
        setNote(file.name + ' has no glossary terms in it.')
        return
      }
      setImportPending({
        kind: 'project',
        fileName: file.name,
        name: parsed.name,
        terms: parsed.terms,
      })
      const defaultSeries = findSeries(notes, selectedId ?? '') ?? all[0]
      setTargetSeriesId(defaultSeries ? defaultSeries.id : '__new__')
      setNewSeriesName(parsed.name)
      if (typeof dialogRef.current?.showModal === 'function') {
        dialogRef.current.showModal()
      }
      return
    }
  }

  const closeDialog = () => {
    if (typeof dialogRef.current?.close === 'function') {
      dialogRef.current.close()
    }
    setImportPending(null)
  }

  const handleConfirmNotesImport = () => {
    if (!importPending || importPending.kind !== 'notes') return
    const count = importPending.series.length
    importNotes(importPending.series, policy)
    closeDialog()
    const modeText =
      policy === 'replace'
        ? 'Replaced Notes with '
        : policy === 'keep'
          ? 'Merged (kept existing) '
          : 'Merged (overwrote duplicates) '
    setNote(modeText + count + ' series from ' + importPending.fileName + '.')
  }

  const handleConfirmProjectImport = () => {
    if (!importPending || importPending.kind !== 'project') return
    let sid = targetSeriesId
    let sname = ''
    if (sid === '__new__') {
      sid = createSeries(newSeriesName)
      if (sid === '') {
        setNote('A series needs a name.')
        return
      }
      sname = newSeriesName.trim()
    } else {
      sname = findSeries(notes, sid)?.name ?? ''
    }
    const result = addSeriesTerms(sid, importPending.terms)
    setSelectedId(sid)
    closeDialog()
    setNote(result.added + ' term(s) imported into “' + sname + '”.')
  }

  return (
    <div>
      <h1>Notes</h1>
      <p class="sub">
        Glossary terms and instructions shared between volumes of the same series. Kept
        in this browser, not in any project file — export them to move or back them up.
      </p>

      {error && (
        <Banner kind="error">
          {error} <button class="small" onClick={clearNotesError}>dismiss</button>
        </Banner>
      )}

      {!loaded ? (
        <p class="muted">Loading notes…</p>
      ) : (
        <>
          <div class="card">
            <div class="row">
              <button
                class="primary"
                onClick={() => {
                  const name = prompt('Name of the series')
                  if (name === null) return
                  const id = createSeries(name)
                  if (id === '') setNote('A series needs a name.')
                  else {
                    setSelectedId(id)
                    setNote(null)
                  }
                }}
              >
                New series
              </button>
              <button
                disabled={notes.series.length === 0}
                onClick={() => downloadNotes(serializeNotes(notes))}
              >
                Export all notes
              </button>
              <button onClick={openFilePicker}>
                Import all notes…
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                style="display:none"
                onChange={handleFileChange}
              />
              <span class="spacer" style="flex:1" />
              <span class="muted">{notes.series.length} series</span>
            </div>
            {note && (
              <p class="muted" style="margin:10px 0 0">
                {note}
              </p>
            )}
          </div>

          <dialog
            ref={dialogRef}
            class="import-dialog"
            onCancel={(e) => {
              e.preventDefault()
              closeDialog()
            }}
          >
            {importPending?.kind === 'notes' && (
              <div>
                <h2 style="margin-top:0">Import Notes</h2>
                <p class="muted">
                  File <span class="mono">{importPending.fileName}</span> contains{' '}
                  <strong>{importPending.inspection.totalSeriesCount}</strong> series and{' '}
                  <strong>{importPending.inspection.totalTermsCount}</strong> terms.
                </p>

                {importPending.inspection.hasConflicts && (
                  <div class="banner warn" style="margin:12px 0">
                    <strong style="display:block;margin-bottom:4px">
                      Duplicate / Conflicting series found
                    </strong>
                    <div style="font-size:12px">
                      {importPending.inspection.conflicts.map((c) => (
                        <div key={c.seriesId} style="margin-top:6px">
                          • <strong>{c.seriesName}</strong> ({c.existingTermsCount} existing terms
                          {c.newTermsCount > 0 ? `, ${c.newTermsCount} new` : ''})
                          {c.termConflicts.length > 0 && (
                            <ul style="margin:4px 0 0 16px;padding:0">
                              {c.termConflicts.map((tc) => (
                                <li key={tc.term}>
                                  Term <span class="mono">{tc.term}</span>: local{' '}
                                  <em>“{tc.localTranslation}”</em> vs imported{' '}
                                  <em>“{tc.importedTranslation}”</em>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div style="margin-top:16px">
                  <label style="font-weight:600;color:var(--text);margin-bottom:8px">
                    How should duplicate series and terms be handled?
                  </label>
                  <div class="grid" style="gap:10px">
                    <label class="check">
                      <input
                        type="radio"
                        name="policy"
                        value="overwrite"
                        checked={policy === 'overwrite'}
                        onChange={() => setPolicy('overwrite')}
                      />
                      <span>
                        <strong>Merge & overwrite duplicates</strong>
                        <br />
                        <span class="muted" style="font-size:12px">
                          Imported terms and series instructions overwrite local conflicting values.
                        </span>
                      </span>
                    </label>
                    <label class="check">
                      <input
                        type="radio"
                        name="policy"
                        value="keep"
                        checked={policy === 'keep'}
                        onChange={() => setPolicy('keep')}
                      />
                      <span>
                        <strong>Merge & keep existing</strong>
                        <br />
                        <span class="muted" style="font-size:12px">
                          Preserve local terms and series instructions; only import new series and terms.
                        </span>
                      </span>
                    </label>
                    <label class="check">
                      <input
                        type="radio"
                        name="policy"
                        value="replace"
                        checked={policy === 'replace'}
                        onChange={() => setPolicy('replace')}
                      />
                      <span>
                        <strong>Replace all notes</strong>
                        <br />
                        <span class="muted" style="font-size:12px">
                          Wipe out all current notes and replace with the imported file.
                        </span>
                      </span>
                    </label>
                  </div>
                </div>

                <div class="row" style="margin-top:20px;justify-content:flex-end;gap:8px">
                  <button onClick={closeDialog}>Cancel</button>
                  <button class="primary" onClick={handleConfirmNotesImport}>
                    Import
                  </button>
                </div>
              </div>
            )}

            {importPending?.kind === 'project' && (
              <div>
                <h2 style="margin-top:0">Import Glossary from Project</h2>
                <p class="muted">
                  Found <strong>{importPending.terms.length}</strong> term(s) in project file{' '}
                  <span class="mono">{importPending.fileName}</span>.
                </p>

                <div style="margin-top:12px">
                  <label for="import-target-series">Series to file terms under</label>
                  <select
                    id="import-target-series"
                    value={targetSeriesId}
                    onChange={(e) => setTargetSeriesId(e.currentTarget.value)}
                  >
                    {all.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.terms.length} terms)
                      </option>
                    ))}
                    <option value="__new__">+ Create new series…</option>
                  </select>
                </div>

                {targetSeriesId === '__new__' && (
                  <div style="margin-top:12px">
                    <label for="new-series-name">New series name</label>
                    <input
                      id="new-series-name"
                      value={newSeriesName}
                      onInput={(e) => setNewSeriesName(e.currentTarget.value)}
                      placeholder="e.g. Blue Period"
                    />
                  </div>
                )}

                <div class="row" style="margin-top:20px;justify-content:flex-end;gap:8px">
                  <button onClick={closeDialog}>Cancel</button>
                  <button
                    class="primary"
                    disabled={targetSeriesId === '__new__' && newSeriesName.trim() === ''}
                    onClick={handleConfirmProjectImport}
                  >
                    Import terms
                  </button>
                </div>
              </div>
            )}
          </dialog>

          {all.length === 0 ? (
            <div class="empty">
              No series yet. Create one, or import a <span class="mono">translation.json</span>{' '}
              from a volume you have already translated.
            </div>
          ) : (
            <div class="series-layout">
              <div class="series-list">
                {all.map((s) => (
                  <button
                    key={s.id}
                    aria-current={s.id === selected?.id ? 'true' : 'false'}
                    onClick={() => setSelectedId(s.id)}
                  >
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                      {s.name}
                    </span>
                    <span class="spacer" style="flex:1" />
                    <span class="muted">{s.terms.length}</span>
                  </button>
                ))}
              </div>

              {selected && <SeriesEditor series={selected} onDeleted={() => setSelectedId(null)} />}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SeriesEditor({ series, onDeleted }: { series: Series; onDeleted: () => void }) {
  const { project } = useStore()
  const [adding, setAdding] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const overlong = series.context.length > CONTEXT_WARN_CHARS

  return (
    <div>
      <div class="card">
        <div class="fields">
          <div>
            <label for="series-name">Series name</label>
            <input
              id="series-name"
              value={series.name}
              onInput={(e) => renameSeries(series.id, e.currentTarget.value)}
            />
          </div>
        </div>

        <div style="margin-top:12px">
          <label for="series-context">
            Shared instructions — sent with every request for every volume in this series
          </label>
          <textarea
            id="series-context"
            rows={4}
            placeholder="e.g. Set in 1920s Tokyo. Keep Japanese honorifics. The narrator is the younger sister."
            value={series.context}
            onInput={(e) => setSeriesContext(series.id, e.currentTarget.value)}
          />
          {overlong && (
            <p class="muted" style="margin:6px 0 0">
              {series.context.length} characters. This goes into every single request —
              long instructions cost tokens on every page.
            </p>
          )}
        </div>

        <div class="row" style="margin-top:14px">
          <button
            class="danger"
            onClick={() => {
              if (!confirm('Delete “' + series.name + '” and its ' + series.terms.length + ' term(s)?\n\nProjects keep the terms already copied into them.')) return
              deleteSeries(series.id)
              onDeleted()
            }}
          >
            Delete series
          </button>
          <span class="muted">Updated {new Date(series.updatedAt).toLocaleString()}</span>
        </div>
      </div>

      <div class="card">
        <div class="row">
          <h2 style="margin:0">Terms</h2>
          <span class="spacer" style="flex:1" />
          <button class="small" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'Add term'}
          </button>
          {project && (
            <button
              class="small"
              onClick={() => {
                const result = addGlossaryEntries(project.glossary, series.terms)
                updateProject((p) => ({ ...p, glossary: result.glossary }))
                setCopied(
                  result.added.length === 0
                    ? 'Nothing new for this project.'
                    : result.added.length + ' term(s) copied into ' + project.project.name + '.',
                )
              }}
            >
              Copy all into {project.project.name}
            </button>
          )}
        </div>

        {copied && (
          <p class="muted" style="margin:10px 0 0">
            {copied}{' '}
            {project && 'Use Scan → Series & context to pick a subset instead.'}
          </p>
        )}

        {adding && <AddTermForm seriesId={series.id} onDone={() => setAdding(false)} />}

        {series.terms.length === 0 ? (
          <p class="muted">
            No terms yet. Add one here, or push them up from a project's glossary in
            Scan or Review.
          </p>
        ) : (
          <div class="picker" style="margin-top:12px">
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
                {series.terms.map((entry) => (
                  <tr key={entry.term}>
                    <td class="mono">{entry.term}</td>
                    <td>
                      <input
                        value={entry.translation}
                        onInput={(e) =>
                          updateSeriesTerm(series.id, entry.term, {
                            translation: e.currentTarget.value,
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        value={entry.note}
                        onInput={(e) =>
                          updateSeriesTerm(series.id, entry.term, { note: e.currentTarget.value })
                        }
                      />
                    </td>
                    <td>
                      <button
                        class="small danger"
                        title={'Remove ' + entry.term}
                        onClick={() => removeSeriesTerm(series.id, entry.term)}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function AddTermForm({ seriesId, onDone }: { seriesId: string; onDone: () => void }) {
  const [entry, setEntry] = useState<GlossaryEntry>({
    term: '',
    translation: '',
    note: '',
    locked: true,
  })

  const submit = () => {
    if (entry.term.trim() === '' || entry.translation.trim() === '') return
    addSeriesTerms(seriesId, [entry])
    onDone()
  }

  return (
    <div class="fields" style="margin-top:12px">
      <div>
        <label for="add-term">Term as it appears</label>
        <input
          id="add-term"
          value={entry.term}
          onInput={(e) => setEntry({ ...entry, term: e.currentTarget.value })}
        />
      </div>
      <div>
        <label for="add-translation">Translation</label>
        <input
          id="add-translation"
          value={entry.translation}
          onInput={(e) => setEntry({ ...entry, translation: e.currentTarget.value })}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>
      <div>
        <label for="add-note">Note (optional)</label>
        <input
          id="add-note"
          value={entry.note}
          onInput={(e) => setEntry({ ...entry, note: e.currentTarget.value })}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>
      <div style="align-self:end">
        <button
          class="primary"
          disabled={entry.term.trim() === '' || entry.translation.trim() === ''}
          onClick={submit}
        >
          Add
        </button>
      </div>
    </div>
  )
}

/** Same temporary-anchor trick `fs/export.ts` uses for the project JSON. */
function downloadNotes(text: string): void {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = NOTES_FILE_NAME
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

