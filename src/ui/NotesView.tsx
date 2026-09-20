/**
 * The notes view: glossary terms and translation instructions kept per series, across
 * projects.
 *
 * Reachable without a project open, because the main reason to come here is to prepare
 * for the next volume or to import someone else's terms.
 */

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
  parseImport,
  removeSeriesTerm,
  renameSeries,
  replaceNotes,
  serializeNotes,
  setSeriesContext,
  sortedSeries,
  updateSeriesTerm,
  useNotes,
  type Series,
} from '../state/notes'
import type { GlossaryEntry } from '../state/schema'
import { updateProject, useStore } from '../state/store'
import { Banner } from './common'

export function NotesView() {
  const { notes, loaded, error } = useNotes()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const all = sortedSeries(notes)
  const selected = findSeries(notes, selectedId ?? '') ?? all[0]

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
                Export {NOTES_FILE_NAME}
              </button>
              <ImportButton onNote={setNote} onSelect={setSelectedId} />
              <span class="spacer" style="flex:1" />
              <span class="muted">{notes.series.length} series</span>
            </div>
            {note && (
              <p class="muted" style="margin:10px 0 0">
                {note}
              </p>
            )}
          </div>

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

/**
 * Import a notes export, or harvest the glossary out of a project file.
 *
 * The second case is the migration path for volumes translated before any of this
 * existed, when the only copy of their terms is the `translation.json` beside them.
 */
function ImportButton({
  onNote,
  onSelect,
}: {
  onNote: (message: string) => void
  onSelect: (id: string) => void
}) {
  const input = useRef<HTMLInputElement>(null)

  const read = async (file: File): Promise<void> => {
    let raw: unknown
    try {
      raw = JSON.parse(await file.text())
    } catch {
      onNote(file.name + ' is not valid JSON.')
      return
    }

    const parsed = parseImport(raw)
    if (parsed.kind === 'unknown') {
      onNote(file.name + ' is neither a notes export nor a project file.')
      return
    }

    if (parsed.kind === 'notes') {
      const count = parsed.series.length
      if (count === 0) {
        onNote(file.name + ' has no series in it.')
        return
      }
      const replace = confirm(
        'Import ' +
          count +
          ' series from ' +
          file.name +
          '.\n\nOK: replace everything currently in Notes.\nCancel: merge into what is already here.',
      )
      if (replace) replaceNotes(parsed.series)
      else importNotes(parsed.series)
      onNote((replace ? 'Replaced Notes with ' : 'Merged in ') + count + ' series.')
      return
    }

    if (parsed.terms.length === 0) {
      onNote(file.name + ' has no glossary terms in it.')
      return
    }
    const name = prompt(
      'Found ' + parsed.terms.length + ' term(s) in ' + file.name + '.\n\nFile them under which series?',
      parsed.name,
    )
    if (name === null) return
    const id = createSeries(name)
    if (id === '') {
      onNote('A series needs a name.')
      return
    }
    const result = addSeriesTerms(id, parsed.terms)
    onSelect(id)
    onNote(result.added + ' term(s) imported into “' + name + '”.')
  }

  return (
    <>
      <button onClick={() => input.current?.click()}>Import…</button>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        style="display:none"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0]
          e.currentTarget.value = ''
          if (file) void read(file)
        }}
      />
    </>
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
