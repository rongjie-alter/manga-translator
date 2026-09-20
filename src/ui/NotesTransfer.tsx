/**
 * Moving glossary terms between a project and its series in the notes store.
 *
 * Both directions are checkbox pickers rather than a bulk copy, and that is the whole
 * point: a series accumulates every character across every volume, while any one volume
 * needs a handful of them, and the glossary goes into every single request. Pulling the
 * lot would just move the prompt bloat somewhere the user cannot see it.
 *
 * Presented as inline expanding cards -- this app has no modal, and `confirm()` is its
 * only dialog.
 */

import { useMemo, useState } from 'preact/hooks'
import { addGlossaryEntries, type ConflictPolicy } from '../api/merge'
import { addSeriesTerms, findSeries, useNotes } from '../state/notes'
import type { GlossaryEntry, ProjectFile } from '../state/schema'
import { updateProject } from '../state/store'
import { Banner } from './common'

type Panel = 'pull' | 'push' | null

export function NotesTransfer({
  project,
  onReplaced,
}: {
  project: ProjectFile
  /**
   * Called after a pull overwrote a term the project already used, so the caller can
   * offer the rename sweep. Without it the pages already translated keep the old name,
   * which is the exact problem the notes store exists to prevent.
   */
  onReplaced?: (from: string, to: string) => void
}) {
  const { notes, loaded } = useNotes()
  const [panel, setPanel] = useState<Panel>(null)
  const [result, setResult] = useState<string | null>(null)
  const series = findSeries(notes, project.project.seriesId)

  if (!loaded) return <p class="muted">Loading notes…</p>

  if (!series) {
    return (
      <p class="muted">
        {project.project.seriesName === ''
          ? 'Assign this project to a series to share glossary terms between volumes.'
          : 'The series “' +
            project.project.seriesName +
            '” is not in this browser’s notes. Import it on the Notes page to reconnect.'}
      </p>
    )
  }

  const toggle = (next: Panel) => {
    setResult(null)
    setPanel((current) => (current === next ? null : next))
  }

  return (
    <div>
      <div class="row">
        <button class="small" onClick={() => toggle('pull')}>
          {panel === 'pull' ? 'Cancel' : 'Add terms from ' + series.name + '…'}
        </button>
        <button class="small" onClick={() => toggle('push')}>
          {panel === 'push' ? 'Cancel' : 'Save terms to ' + series.name + '…'}
        </button>
        <span class="muted">
          {series.terms.length} term(s) in the series · {project.glossary.length} in this project
        </span>
      </div>

      {result && (
        <p class="muted" style="margin:10px 0 0">
          {result}
        </p>
      )}

      {panel === 'pull' && (
        <PullPanel
          project={project}
          seriesName={series.name}
          seriesTerms={series.terms}
          onDone={(message) => {
            setResult(message)
            setPanel(null)
          }}
          onReplaced={onReplaced}
        />
      )}

      {panel === 'push' && (
        <PushPanel
          project={project}
          seriesId={series.id}
          seriesName={series.name}
          seriesTerms={series.terms}
          onDone={(message) => {
            setResult(message)
            setPanel(null)
          }}
        />
      )}
    </div>
  )
}

// -- pull -------------------------------------------------------------------

function PullPanel({
  project,
  seriesName,
  seriesTerms,
  onDone,
  onReplaced,
}: {
  project: ProjectFile
  seriesName: string
  seriesTerms: GlossaryEntry[]
  onDone: (message: string) => void
  onReplaced?: (from: string, to: string) => void
}) {
  // Nothing checked by default. On a fresh volume the project glossary is empty, so
  // "everything not already here" would be the entire cast -- the bloat this avoids.
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const [policy, setPolicy] = useState<ConflictPolicy>('keep')
  const inProject = useMemo(
    () => new Map(project.glossary.map((e) => [e.term, e])),
    [project.glossary],
  )

  const rows = seriesTerms.map((entry) => {
    const current = inProject.get(entry.term)
    return {
      entry,
      note:
        current === undefined
          ? ''
          : current.translation === entry.translation
            ? 'already here'
            : 'this project says “' + current.translation + '”',
      clashes: current !== undefined && current.translation !== entry.translation,
    }
  })

  const picked = seriesTerms.filter((e) => checked.has(e.term))
  const clashing = rows.filter((r) => r.clashes && checked.has(r.entry.term))

  const apply = () => {
    const result = addGlossaryEntries(project.glossary, picked, policy)
    updateProject((p) => ({ ...p, glossary: result.glossary }))

    const parts: string[] = []
    if (result.added.length > 0) parts.push(result.added.length + ' added')
    if (result.replaced.length > 0) parts.push(result.replaced.length + ' replaced')
    if (result.conflicted.length > 0) {
      parts.push(result.conflicted.length + ' left alone (' + result.conflicted.join(', ') + ')')
    }
    if (result.skipped.length > 0) {
      parts.push(result.skipped.length + ' dropped, the project glossary is full')
    }
    onDone(parts.length === 0 ? 'Nothing to change.' : parts.join(' · ') + '.')

    const first = result.replaced[0]
    if (first !== undefined && onReplaced) {
      const to = picked.find((e) => e.term === first)
      const from = project.glossary.find((e) => e.term === first)
      if (to && from) onReplaced(from.translation, to.translation)
    }
  }

  return (
    <div class="card" style="margin-top:12px">
      <h3 style="margin-top:0">Add terms from {seriesName}</h3>
      <p class="muted" style="margin-top:-6px">
        Every term you add is sent with every request, so pick the cast that appears in
        this volume rather than the whole series.
      </p>

      <TermTable
        rows={rows}
        checked={checked}
        onChange={setChecked}
        emptyText="This series has no terms yet."
      />

      {clashing.length > 0 && (
        <div class="row" style="margin-top:12px">
          <span class="muted">
            {clashing.length} of these already have a different translation here:
          </span>
          <label class="check">
            <input
              type="checkbox"
              checked={policy === 'replace'}
              onChange={(e) => setPolicy(e.currentTarget.checked ? 'replace' : 'keep')}
            />
            replace them with the series version
          </label>
        </div>
      )}

      <div class="row" style="margin-top:12px">
        <button class="primary" disabled={picked.length === 0} onClick={apply}>
          Add {picked.length} term(s)
        </button>
      </div>
    </div>
  )
}

// -- push -------------------------------------------------------------------

function PushPanel({
  project,
  seriesId,
  seriesName,
  seriesTerms,
  onDone,
}: {
  project: ProjectFile
  seriesId: string
  seriesName: string
  seriesTerms: GlossaryEntry[]
  onDone: (message: string) => void
}) {
  const inSeries = useMemo(() => new Map(seriesTerms.map((e) => [e.term, e])), [seriesTerms])

  const rows = project.glossary.map((entry) => {
    const current = inSeries.get(entry.term)
    return {
      entry,
      note:
        current === undefined
          ? ''
          : current.translation === entry.translation
            ? 'already saved'
            : 'the series says “' + current.translation + '”',
      clashes: current !== undefined && current.translation !== entry.translation,
    }
  })

  // Pre-checked, unlike the pull: what is new here is what the series is missing, and
  // nothing leaves the project until the user presses the button anyway.
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set(rows.filter((r) => r.note === '').map((r) => r.entry.term)),
  )

  const picked = project.glossary.filter((e) => checked.has(e.term))

  const apply = () => {
    const result = addSeriesTerms(seriesId, picked)
    const parts: string[] = []
    if (result.added > 0) parts.push(result.added + ' added')
    if (result.replaced > 0) parts.push(result.replaced + ' updated')
    if (result.skipped > 0) parts.push(result.skipped + ' dropped, the series is full')
    onDone(
      parts.length === 0
        ? 'Nothing to change.'
        : parts.join(' · ') + ' in ' + seriesName + '.',
    )
  }

  return (
    <div class="card" style="margin-top:12px">
      <h3 style="margin-top:0">Save terms to {seriesName}</h3>
      <p class="muted" style="margin-top:-6px">
        Saved terms are available to every other volume in the series. Nothing is saved
        automatically, so a one-shot never fills the series up.
      </p>

      <TermTable
        rows={rows}
        checked={checked}
        onChange={setChecked}
        emptyText="This project has no glossary terms yet."
      />

      <div class="row" style="margin-top:12px">
        <button class="primary" disabled={picked.length === 0} onClick={apply}>
          Save {picked.length} term(s)
        </button>
      </div>
    </div>
  )
}

// -- the table both panels use ----------------------------------------------

interface Row {
  entry: GlossaryEntry
  note: string
  clashes: boolean
}

function TermTable({
  rows,
  checked,
  onChange,
  emptyText,
}: {
  rows: Row[]
  checked: ReadonlySet<string>
  onChange: (next: ReadonlySet<string>) => void
  emptyText: string
}) {
  const [filter, setFilter] = useState('')

  const needle = filter.trim().toLowerCase()
  const visible =
    needle === ''
      ? rows
      : rows.filter(
          (r) =>
            r.entry.term.toLowerCase().includes(needle) ||
            r.entry.translation.toLowerCase().includes(needle),
        )

  const setAll = (on: boolean) => {
    const next = new Set(checked)
    for (const row of visible) {
      if (on) next.add(row.entry.term)
      else next.delete(row.entry.term)
    }
    onChange(next)
  }

  const toggle = (term: string) => {
    const next = new Set(checked)
    if (next.has(term)) next.delete(term)
    else next.add(term)
    onChange(next)
  }

  if (rows.length === 0) return <p class="muted">{emptyText}</p>

  return (
    <div>
      <div class="row" style="margin-bottom:8px">
        <input
          style="max-width:220px"
          placeholder="Filter terms…"
          value={filter}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
        <button class="small" onClick={() => setAll(true)}>
          Select {needle === '' ? 'all' : 'shown'}
        </button>
        <button class="small" onClick={() => setAll(false)}>
          Select none
        </button>
        <span class="spacer" style="flex:1" />
        <span class="muted">
          {checked.size} of {rows.length} selected
        </span>
      </div>

      <div class="picker">
        <table class="table">
          <thead>
            <tr>
              <th style="width:1%" />
              <th>Term</th>
              <th>Translation</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.entry.term}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={'Select ' + row.entry.term}
                    checked={checked.has(row.entry.term)}
                    onChange={() => toggle(row.entry.term)}
                  />
                </td>
                <td class="mono">{row.entry.term}</td>
                <td>
                  {row.entry.translation}
                  {row.note !== '' && (
                    <span class={row.clashes ? 'tag' : 'muted'} style="margin-left:8px">
                      {row.note}
                    </span>
                  )}
                </td>
                <td class="muted">{row.entry.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {visible.length === 0 && <Banner kind="info">No term matches “{filter}”.</Banner>}
    </div>
  )
}
